import { existsSync } from "node:fs";
import path from "node:path";
import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { createDb, runMigrations } from "./db/client";
import { ensureSeeded } from "./seed";

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required environment variable ${name}. See .env.example.`);
    process.exit(1);
  }
  return v;
}

const production = process.env.NODE_ENV === "production";
const databaseUrl = required("DATABASE_URL");
const password = required("APP_PASSWORD");
const sessionSecret = required("SESSION_SECRET");
if (sessionSecret.length < 32) {
  console.error("SESSION_SECRET must be at least 32 characters.");
  process.exit(1);
}

const { db } = createDb(databaseUrl);
await runMigrations(db);
await ensureSeeded(db);

const staticDir = path.resolve(process.cwd(), "dist/web");
const app = createApp({
  db,
  password,
  sessionSecret,
  secureCookies: production,
  staticDir: existsSync(staticDir) ? staticDir : undefined,
});

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port }, () => console.log(`Strawvine listening on :${port}`));
