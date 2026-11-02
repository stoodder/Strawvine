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
 * Every test starts from a known database and a freshly started server: the suite's `test`
 * fixture (e2e/helpers.ts) asks this script's control endpoint (E2E_CONTROL_URL) to stop the
 * server, drop and recreate the database and start the server again before each test — so
 * tests don't depend on each other and a retry starts clean.
 *
 * Onboarding through the UI takes ~4 s, so it happens once per run: Playwright's global setup
 * (e2e/global-setup.ts) onboards on the reset database and asks for POST /template/commit, which
 * copies it into `<name>_tpl`. From then on each reset clones that template
 * (`create database … template …`); a test that exercises onboarding itself opts into an empty
 * database (`test.use({ emptyDatabase: true })` → POST /reset?fresh=1). E2E_NO_TEMPLATE=1 turns
 * the template off (every test onboards through the UI, as before).
 *
 * CSP: the server's "CSP violation (report-only)" log lines are counted (GET /csp on the control
 * endpoint), and the fixture fails a test during which any report arrived — from any browser
 * context.
 *
 * At the end it prints a summary table (one row per test: result, duration, retries; skipped and
 * fixme tests included) from Playwright's JSON report.
 *
 * E2E_DATABASE_URL (default postgres://postgres@localhost:5432/strawvine_e2e) is dropped and
 * recreated, so its name must contain "e2e" and its host must be local (CI=true lifts the host
 * check) — a guard against wiping a real database. E2E_KEEP_DB doesn't lift the guard.
 */
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
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

/** A connection to the server's maintenance database (`postgres`), for create/drop database. */
function adminSql() {
  const admin = new URL(dbUrl);
  admin.pathname = "/postgres";
  return postgres(admin.toString(), { max: 1, onnotice: () => {} });
}

/**
 * Drop and recreate the e2e database (with E2E_KEEP_DB, only create it if missing) — empty, or as
 * a copy of `template`.
 */
async function resetDatabase({ keep = !!process.env.E2E_KEEP_DB, template = null } = {}) {
  const name = guardedDatabaseName();
  const sql = adminSql();
  try {
    const exists = (await sql`select 1 from pg_database where datname = ${name}`).length > 0;
    if (exists && keep) return;
    if (exists) await sql.unsafe(`drop database "${name}" with (force)`);
    await sql.unsafe(template ? `create database "${name}" template "${template}"` : `create database "${name}"`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** The onboarded template's name (derived from the guarded e2e name, so it contains "e2e" too). */
const templateName = () => `${guardedDatabaseName()}_tpl`;

/** Copy the (stopped) e2e database into the template, replacing an older one. */
async function snapshotTemplate() {
  const name = guardedDatabaseName();
  const tpl = templateName();
  const sql = adminSql();
  try {
    await sql.unsafe(`drop database if exists "${tpl}" with (force)`);
    await sql.unsafe(`create database "${tpl}" template "${name}"`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function dropTemplate() {
  const sql = adminSql();
  try {
    await sql.unsafe(`drop database if exists "${templateName()}" with (force)`);
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

/** CSP report-only violations the server has logged during this run (see GET /csp). */
const cspViolations = [];

function startServer(port) {
  const server = spawn(process.execPath, ["dist/server/index.js"], {
    cwd: appDir,
    stdio: ["ignore", "pipe", "inherit"],
    env: {
      ...process.env,
      NODE_ENV: "test",
      DATABASE_URL: dbUrl,
      APP_PASSWORD: PASSWORD,
      SESSION_SECRET,
      PORT: String(port),
    },
  });
  // Pass the log through, counting the CSP reports in it.
  let partial = "";
  server.stdout.on("data", (chunk) => {
    process.stdout.write(chunk);
    const lines = (partial + chunk.toString("utf8")).split("\n");
    partial = lines.pop() ?? "";
    for (const line of lines) if (line.includes("CSP violation")) cspViolations.push(line.trim());
  });
  return server;
}

function stopServer(server) {
  return new Promise((resolve) => {
    if (server.exitCode !== null || server.signalCode !== null) return resolve();
    // The database is dropped next anyway: a server slow to drain its connections is killed.
    const force = setTimeout(() => server.kill("SIGKILL"), 3_000);
    server.once("exit", () => (clearTimeout(force), resolve()));
    server.kill("SIGTERM");
  });
}

/** One row per test from Playwright's JSON report: file › title, result, time, retries, note. */
function printSummary(file) {
  if (!existsSync(file)) return;
  let report;
  try {
    report = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return;
  }
  const rows = [];
  const visit = (suite, prefix) => {
    for (const spec of suite.specs ?? [])
      for (const t of spec.tests ?? []) {
        const results = t.results ?? [];
        const last = results.at(-1);
        // fixme/skip annotations explain why a test didn't run.
        const note = (t.annotations ?? []).find((a) => a.type === "fixme" || a.type === "skip")?.description ?? "";
        const status =
          t.status === "skipped" ? ((t.annotations ?? []).some((a) => a.type === "fixme") ? "fixme" : "skipped")
          : t.status === "flaky" ? "flaky"
          : t.status === "expected" ? "passed"
          : last?.status === "timedOut" ? "timed out"
          : "FAILED";
        const ms = results.reduce((a, r) => a + (r.duration ?? 0), 0);
        rows.push([`${spec.file} › ${[...prefix, spec.title].join(" › ")}`, status, ms ? `${(ms / 1000).toFixed(1)}s` : "", results.length > 1 ? String(results.length - 1) : "", note]);
      }
    for (const child of suite.suites ?? []) visit(child, child.title && child.title !== child.file ? [...prefix, child.title] : prefix);
  };
  for (const s of report.suites ?? []) visit(s, []);
  if (!rows.length) return;
  const head = ["test", "result", "time", "retries", "note"];
  const clip = (v, n) => (v.length > n ? v.slice(0, n - 1) + "…" : v);
  const cols = head.map((h, i) => Math.min(i === 0 ? 72 : i === 4 ? 60 : 12, Math.max(h.length, ...rows.map((r) => r[i].length))));
  const line = (r) => r.map((v, i) => clip(v, cols[i]).padEnd(cols[i])).join("  ").trimEnd();
  const count = (s) => rows.filter((r) => r[1] === s).length;
  const totals = ["passed", "flaky", "FAILED", "timed out", "fixme", "skipped"].map((s) => [s, count(s)]).filter(([, n]) => n);
  console.log(`\ne2e summary\n${line(head)}\n${cols.map((n) => "-".repeat(n)).join("  ")}\n${rows.map(line).join("\n")}`);
  console.log(`\n${totals.map(([s, n]) => `${n} ${s.toLowerCase()}`).join(" · ")}`);

  // CI: the totals, and every flaky test (failed, then passed on retry) by name, in the job summary.
  if (process.env.GITHUB_STEP_SUMMARY) {
    const flaky = rows.filter((r) => r[1] === "flaky");
    const failed = rows.filter((r) => r[1] === "FAILED" || r[1] === "timed out");
    const fixme = rows.filter((r) => r[1] === "fixme");
    const md = [
      "### End-to-end tests",
      "",
      totals.map(([s, n]) => `${n} ${s.toLowerCase()}`).join(" · "),
      "",
      ...(flaky.length ? ["**Flaky** (failed, then passed on retry — fix these):", "", ...flaky.map((r) => `- ${r[0]} (${r[2]})`), ""] : []),
      ...(failed.length ? ["**Failed:**", "", ...failed.map((r) => `- ${r[0]}`), ""] : []),
      ...(fixme.length ? ["<details><summary>fixme</summary>", "", ...fixme.map((r) => `- ${r[0]}${r[4] ? ` — ${r[4]}` : ""}`), "", "</details>", ""] : []),
    ];
    try {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, md.join("\n") + "\n");
    } catch {
      /* best effort */
    }
    for (const r of flaky) console.log(`::warning title=Flaky e2e test::${r[0]} failed, then passed on retry`);
  }
}

async function main() {
  guardedDatabaseName();
  if (!process.env.E2E_SKIP_BUILD && appDir === root) await run("npm", ["run", "build"]);
  await resetDatabase();
  const port = Number(process.env.E2E_PORT) || (await freePort());
  const base = `http://localhost:${port}`;
  let server = startServer(port);

  // Control endpoint for the test fixture and the global setup:
  //   POST /reset            → the onboarded template's copy (an empty database before it exists) + a fresh server
  //   POST /reset?fresh=1    → an empty database + a fresh server
  //   POST /template/commit  → snapshot the current database as the template
  //   GET  /csp              → { count, lines } of CSP reports logged so far
  const useTemplate = !process.env.E2E_KEEP_DB && !process.env.E2E_NO_TEMPLATE;
  let templateReady = false;
  let resetting = Promise.resolve();
  const control = createHttpServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://control");
    if (req.method === "GET" && url.pathname === "/csp")
      return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ count: cspViolations.length, lines: cspViolations }));
    const routes = {
      "/reset": async () => {
        if (process.env.E2E_KEEP_DB) return;
        await stopServer(server);
        await resetDatabase({ keep: false, template: templateReady && url.searchParams.get("fresh") !== "1" ? templateName() : null });
        server = startServer(port);
      },
      "/template/commit": async () => {
        if (!useTemplate) return;
        await stopServer(server);
        await snapshotTemplate();
        templateReady = true;
        server = startServer(port);
      },
    };
    const handler = req.method === "POST" ? routes[url.pathname] : undefined;
    if (!handler) return res.writeHead(404).end();
    resetting = resetting.then(async () => {
      try {
        const t0 = performance.now();
        await handler();
        await waitForHealth(base, server);
        if (process.env.E2E_DEBUG) console.log(`e2e: ${url.pathname}${url.search} took ${Math.round(performance.now() - t0)} ms`);
        res.writeHead(204, { "x-e2e-template": String(templateReady) }).end();
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
  const summaryDir = mkdtempSync(path.join(tmpdir(), "strawvine-e2e-"));
  const summaryFile = path.join(summaryDir, "results.json");
  try {
    await waitForHealth(base, server);
    console.log(`e2e: server on ${base}, database ${new URL(dbUrl).pathname.slice(1)}`);
    await run("npx", ["playwright", "test", "-c", "e2e/playwright.config.ts", ...process.argv.slice(2)], {
      env: {
        ...process.env,
        E2E_BASE_URL: base,
        E2E_PASSWORD: PASSWORD,
        E2E_CONTROL_URL: controlUrl,
        E2E_SUMMARY_FILE: summaryFile,
        ...(useTemplate ? {} : { E2E_NO_TEMPLATE: "1" }),
      },
    });
    code = 0;
  } catch (err) {
    console.error(`e2e: ${err instanceof Error ? err.message : err}`);
  } finally {
    control.close();
    await stopServer(server);
    if (templateReady) await dropTemplate().catch(() => {});
  }
  printSummary(summaryFile);
  rmSync(summaryDir, { recursive: true, force: true });
  process.exit(code);
}

await main();
