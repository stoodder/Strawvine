#!/usr/bin/env node
/**
 * End-to-end run: build, start the production server against a fresh e2e database on a free
 * port, run the Playwright suite (e2e/), stop the server.
 *
 *   npm run e2e                       # build + run everything
 *   npm run e2e -- --grep offline     # extra args go to `playwright test`
 *   E2E_SKIP_BUILD=1 npm run e2e      # reuse dist/
 *   E2E_KEEP_DB=1 npm run e2e         # don't reset the database first
 *
 * E2E_DATABASE_URL (default postgres://postgres@localhost:5432/strawvine_e2e) is dropped and
 * recreated on every run, so its name must contain "e2e" (a guard against wiping a real database).
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dbUrl = process.env.E2E_DATABASE_URL ?? "postgres://postgres@localhost:5432/strawvine_e2e";
const PASSWORD = process.env.E2E_PASSWORD ?? "e2e-password-not-secret";
const SESSION_SECRET = "e2e-session-secret-e2e-session-secret-0123456789";

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: root, stdio: "inherit", ...opts });
    p.on("exit", (code, signal) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(" ")} exited with ${code ?? signal}`))));
    p.on("error", reject);
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Drop and recreate the e2e database (or just create it if missing, with E2E_KEEP_DB). */
async function resetDatabase() {
  const url = new URL(dbUrl);
  const name = decodeURIComponent(url.pathname.slice(1));
  if (!/^[\w-]+$/.test(name)) throw new Error(`Unexpected database name "${name}"`);
  const admin = new URL(dbUrl);
  admin.pathname = "/postgres";
  const sql = postgres(admin.toString(), { max: 1, onnotice: () => {} });
  try {
    const exists = (await sql`select 1 from pg_database where datname = ${name}`).length > 0;
    if (exists && !process.env.E2E_KEEP_DB) {
      if (!/e2e/i.test(name)) throw new Error(`Refusing to reset "${name}": the e2e database name must contain "e2e".`);
      await sql.unsafe(`drop database "${name}" with (force)`);
    }
    if (!exists || !process.env.E2E_KEEP_DB) await sql.unsafe(`create database "${name}"`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function waitForHealth(base, server, ms = 30_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (server.exitCode !== null) throw new Error(`server exited early (${server.exitCode})`);
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server not healthy after ${ms} ms`);
}

async function main() {
  if (!process.env.E2E_SKIP_BUILD) await run("npm", ["run", "build"]);
  await resetDatabase();
  const port = Number(process.env.E2E_PORT) || (await freePort());
  const base = `http://localhost:${port}`;

  const server = spawn(process.execPath, ["dist/server/index.js"], {
    cwd: root,
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...process.env,
      NODE_ENV: "test",
      DATABASE_URL: dbUrl,
      APP_PASSWORD: PASSWORD,
      SESSION_SECRET,
      PORT: String(port),
    },
  });
  const stop = () => {
    if (server.exitCode === null) server.kill("SIGTERM");
  };
  process.on("SIGINT", () => (stop(), process.exit(130)));
  process.on("SIGTERM", () => (stop(), process.exit(143)));

  let code = 1;
  try {
    await waitForHealth(base, server);
    console.log(`e2e: server on ${base}, database ${new URL(dbUrl).pathname.slice(1)}`);
    await run("npx", ["playwright", "test", "-c", "e2e/playwright.config.ts", ...process.argv.slice(2)], {
      env: { ...process.env, E2E_BASE_URL: base, E2E_PASSWORD: PASSWORD },
    });
    code = 0;
  } catch (err) {
    console.error(`e2e: ${err instanceof Error ? err.message : err}`);
  } finally {
    stop();
  }
  process.exit(code);
}

await main();
