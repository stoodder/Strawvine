import { existsSync } from "node:fs";
import path from "node:path";
import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { loadConfig, type ServerConfig } from "./config";
import { createDb, createWebDb } from "./db/client";
import { prepareDatabase } from "./seed";

let config: ServerConfig;
try {
  config = loadConfig();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

// Normally done by the Heroku release phase already; cheap and idempotent (and locked) here.
// Heroku kills a web dyno that hasn't bound its port within 60 s, so don't wait long for the lock
// (the release phase may be holding it for a long migration): fail fast and let the dyno restart.
// Its own short-lived pool, without the web pool's statement timeout.
{
  const prep = createDb(config.databaseUrl);
  try {
    await prepareDatabase(prep.db, prep.sql, { lockTimeoutMs: 30_000 });
  } catch (err) {
    console.error("Database preparation failed:", err instanceof Error ? err.name : "error", err instanceof Error ? err.message : "");
    await prep.sql.end({ timeout: 5 }).catch(() => {});
    process.exit(1);
  }
  await prep.sql.end({ timeout: 5 }).catch(() => {});
}

const { db, sql } = createWebDb(config.databaseUrl);

const staticDir = path.resolve(process.cwd(), "dist/web");
const app = createApp({
  db,
  password: config.password,
  sessionSecret: config.sessionSecret,
  secureCookies: config.production,
  trustProxy: config.trustProxy,
  forceHttps: config.production,
  buildId: config.buildId,
  staticDir: existsSync(staticDir) ? staticDir : undefined,
});

const server = serve({ fetch: app.fetch, port: config.port }, () =>
  console.log(`Strawvine listening on :${config.port}${config.buildId ? ` (build ${config.buildId})` : ""}`),
);

// Graceful shutdown: Heroku sends SIGTERM and allows 30 s before SIGKILL. Stop accepting
// connections, let in-flight requests finish, then close the pool. As PID 1 in the container
// node only reacts to signals it handles, so these handlers are what makes `docker stop` quick.
let stopping = false;
function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal} received, shutting down`);
  const force = setTimeout(() => process.exit(1), 25_000);
  force.unref();
  server.close(async () => {
    await sql.end({ timeout: 5 }).catch(() => {});
    process.exit(0);
  });
  // Idle keep-alive sockets would otherwise hold close() open until they time out.
  (server as { closeIdleConnections?: () => void }).closeIdleConnections?.();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
