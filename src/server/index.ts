import { existsSync } from "node:fs";
import path from "node:path";
import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { loadConfig, type ServerConfig } from "./config";
import { createDb } from "./db/client";
import { prepareDatabase } from "./seed";

let config: ServerConfig;
try {
  config = loadConfig();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

const { db, sql } = createDb(config.databaseUrl);
// Normally done by the Heroku release phase already; cheap and idempotent (and locked) here.
await prepareDatabase(db, sql);

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
