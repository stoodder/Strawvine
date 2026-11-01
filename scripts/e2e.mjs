#!/usr/bin/env node
/**
 * End-to-end run: build, start the production server against a fresh e2e database on a free
 * port, run the Playwright suite (e2e/), stop the server.
 *
 *   npm run e2e                       # build + run everything
 *   npm run e2e -- --grep offline     # extra args go to `playwright test`
 *   E2E_SKIP_BUILD=1 npm run e2e      # reuse dist/
 *   E2E_KEEP_DB=1 npm run e2e         # don't reset the database (before the run or between tests)
 *   E2E_APP_DIR=… npm run e2e         # serve another build: <dir>/dist and <dir>/drizzle (implies no build)
 *
 * Every test starts from an empty database and a freshly started server: the suite's `test`
 * fixture (e2e/helpers.ts) asks this script's control endpoint (E2E_CONTROL_URL) to stop the
 * server, drop and recreate the database and start the server again before each test — so
 * tests don't depend on each other and a retry starts clean.
 *
 * E2E_DATABASE_URL (default postgres://postgres@localhost:5432/strawvine_e2e) is dropped and
 * recreated, so its name must contain "e2e" and its host must be local (CI=true lifts the host
 * check) — a guard against wiping a real database. E2E_KEEP_DB doesn't lift the guard.
 */
import { spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** Where the server runs from (its dist/ and drizzle/); the repository unless E2E_APP_DIR says otherwise. */
const appDir = process.env.E2E_APP_DIR ? path.resolve(process.env.E2E_APP_DIR) : root;
const dbUrl = process.env.E2E_DATABASE_URL ?? "postgres://postgres@localhost:5432/strawvine_e2e";
const PASSWORD = process.env.E2E_PASSWORD ?? "e2e-password-not-secret";
const SESSION_SECRET = "e2e-session-secret-e2e-session-secret-0123456789";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", ""]);

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

/** The e2e database's name, after checking it is safe to drop. */
function guardedDatabaseName() {
  const url = new URL(dbUrl);
  const name = decodeURIComponent(url.pathname.slice(1));
  if (!/^[\w-]+$/.test(name)) throw new Error(`Unexpected database name "${name}"`);
  if (!/e2e/i.test(name)) throw new Error(`Refusing to use "${name}": the e2e database name must contain "e2e".`);
  const ci = process.env.CI === "true" || process.env.CI === "1";
  if (!ci && !LOCAL_HOSTS.has(url.hostname.toLowerCase()))
    throw new Error(`Refusing to use a database on "${url.hostname}": the e2e database must be local (or CI=true).`);
  return name;
}

/** Drop and recreate the e2e database (with E2E_KEEP_DB, only create it if missing). */
async function resetDatabase({ keep = !!process.env.E2E_KEEP_DB } = {}) {
  const name = guardedDatabaseName();
  const admin = new URL(dbUrl);
  admin.pathname = "/postgres";
  const sql = postgres(admin.toString(), { max: 1, onnotice: () => {} });
  try {
    const exists = (await sql`select 1 from pg_database where datname = ${name}`).length > 0;
    if (exists && keep) return;
    if (exists) await sql.unsafe(`drop database "${name}" with (force)`);
    await sql.unsafe(`create database "${name}"`);
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
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server not healthy after ${ms} ms`);
}

function startServer(port) {
  return spawn(process.execPath, ["dist/server/index.js"], {
    cwd: appDir,
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
}

function stopServer(server) {
  return new Promise((resolve) => {
    if (server.exitCode !== null || server.signalCode !== null) return resolve();
    const force = setTimeout(() => server.kill("SIGKILL"), 10_000);
    server.once("exit", () => (clearTimeout(force), resolve()));
    server.kill("SIGTERM");
  });
}

async function main() {
  guardedDatabaseName();
  if (!process.env.E2E_SKIP_BUILD && appDir === root) await run("npm", ["run", "build"]);
  await resetDatabase();
  const port = Number(process.env.E2E_PORT) || (await freePort());
  const base = `http://localhost:${port}`;
  let server = startServer(port);

  // Control endpoint for the test fixture: POST /reset → fresh database + fresh server.
  let resetting = Promise.resolve();
  const control = createHttpServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/reset") return res.writeHead(404).end();
    resetting = resetting.then(async () => {
      try {
        if (!process.env.E2E_KEEP_DB) {
          await stopServer(server);
          await resetDatabase({ keep: false });
          server = startServer(port);
        }
        await waitForHealth(base, server);
        res.writeHead(204).end();
      } catch (err) {
        res.writeHead(500, { "content-type": "text/plain" }).end(String(err instanceof Error ? err.message : err));
      }
    });
  });
  await new Promise((r) => control.listen(0, "127.0.0.1", r));
  const controlUrl = `http://127.0.0.1:${control.address().port}`;

  const stop = () => {
    control.close();
    if (server.exitCode === null) server.kill("SIGTERM");
  };
  process.on("SIGINT", () => (stop(), process.exit(130)));
  process.on("SIGTERM", () => (stop(), process.exit(143)));

  let code = 1;
  try {
    await waitForHealth(base, server);
    console.log(`e2e: server on ${base}, database ${new URL(dbUrl).pathname.slice(1)}`);
    await run("npx", ["playwright", "test", "-c", "e2e/playwright.config.ts", ...process.argv.slice(2)], {
      env: { ...process.env, E2E_BASE_URL: base, E2E_PASSWORD: PASSWORD, E2E_CONTROL_URL: controlUrl },
    });
    code = 0;
  } catch (err) {
    console.error(`e2e: ${err instanceof Error ? err.message : err}`);
  } finally {
    control.close();
    await stopServer(server);
  }
  process.exit(code);
}

await main();
