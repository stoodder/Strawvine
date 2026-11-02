#!/usr/bin/env node
/**
 * Restore round trip (CI: the weekly `restore-check` job): an export must restore into a fresh
 * database and export again unchanged.
 *
 *   npm run build && node scripts/restore-check.mjs
 *   RESTORE_APP_DIR=… node scripts/restore-check.mjs   # use another build (<dir>/dist, <dir>/drizzle)
 *
 * 1. starts the production server (dist/server/index.js) on a fresh database A and signs in;
 * 2. seeds a small but varied dataset through the API (days with every kind of field, a
 *    benchmark, unicode notes, settings changes, a new exercise, max entries, a session, seen
 *    achievements);
 * 3. GET /api/export → A.json;
 * 4. restores A.json into a second fresh database B with dist/server/restore.js;
 * 5. starts the server on B, signs in, exports again → B.json;
 * 6. compares the two exports, ignoring `exportedAt`; any difference fails with its path.
 *
 * RESTORE_CHECK_DATABASE_URL (default postgres://postgres@localhost:5432/strawvine_restore_check)
 * names the base: databases `<name>_a` and `<name>_b` are dropped and recreated, so the name must
 * contain "restore" and the host must be local (CI=true lifts the host check). The exports are
 * kept in RESTORE_CHECK_OUT (default: a temp dir) for inspection.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import postgres from "postgres";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appDir = process.env.RESTORE_APP_DIR ? path.resolve(process.env.RESTORE_APP_DIR) : root;
const baseUrl = process.env.RESTORE_CHECK_DATABASE_URL ?? "postgres://postgres@localhost:5432/strawvine_restore_check";
const outDir = process.env.RESTORE_CHECK_OUT ?? mkdtempSync(path.join(tmpdir(), "strawvine-restore-"));
const PASSWORD = "restore-check-password";
const SESSION_SECRET = "restore-check-session-secret-0123456789abcdef0123";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", ""]);

/** URLs of the two databases, after checking they are safe to drop. */
function databases() {
  const url = new URL(baseUrl);
  const name = decodeURIComponent(url.pathname.slice(1));
  if (!/^[\w-]+$/.test(name)) throw new Error(`Unexpected database name "${name}"`);
  if (!/restore/i.test(name)) throw new Error(`Refusing to use "${name}": the database name must contain "restore".`);
  const ci = process.env.CI === "true" || process.env.CI === "1";
  if (!ci && !LOCAL_HOSTS.has(url.hostname.toLowerCase()))
    throw new Error(`Refusing to use a database on "${url.hostname}": it must be local (or CI=true).`);
  const at = (suffix) => {
    const u = new URL(baseUrl);
    u.pathname = `/${name}_${suffix}`;
    return { name: `${name}_${suffix}`, url: u.toString() };
  };
  return [at("a"), at("b")];
}

async function recreate(names) {
  const admin = new URL(baseUrl);
  admin.pathname = "/postgres";
  const sql = postgres(admin.toString(), { max: 1, onnotice: () => {} });
  try {
    for (const name of names) {
      await sql.unsafe(`drop database if exists "${name}" with (force)`);
      await sql.unsafe(`create database "${name}"`);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
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

const env = (databaseUrl, extra = {}) => ({
  ...process.env,
  NODE_ENV: "test",
  DATABASE_URL: databaseUrl,
  APP_PASSWORD: PASSWORD,
  SESSION_SECRET,
  ...extra,
});

function run(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: appDir, stdio: "inherit", ...opts });
    p.on("exit", (code, signal) => (code === 0 ? resolve() : reject(new Error(`${path.basename(args[0] ?? cmd)} exited with ${code ?? signal}`))));
    p.on("error", reject);
  });
}

async function startServer(databaseUrl) {
  const port = await freePort();
  const server = spawn(process.execPath, ["dist/server/index.js"], {
    cwd: appDir,
    stdio: ["ignore", "inherit", "inherit"],
    env: env(databaseUrl, { PORT: String(port) }),
  });
  const base = `http://localhost:${port}`;
  const until = Date.now() + 30_000;
  for (;;) {
    if (server.exitCode !== null) throw new Error(`server exited early (${server.exitCode})`);
    const ok = await fetch(`${base}/api/health`).then((r) => r.ok, () => false);
    if (ok) break;
    if (Date.now() > until) throw new Error("server not healthy after 30 s");
    await new Promise((r) => setTimeout(r, 100));
  }
  return { base, stop: () => new Promise((resolve) => (server.exitCode !== null ? resolve() : (server.once("exit", resolve), server.kill("SIGTERM")))) };
}

/** A tiny API client with a cookie jar. */
async function client(base) {
  const jar = new Map();
  const call = async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const i = pair.indexOf("=");
      jar.set(pair.slice(0, i), pair.slice(i + 1));
    }
    if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${await res.text()}`);
    return res.status === 204 ? null : res.json();
  };
  await call("POST", "/api/auth/login", { password: PASSWORD });
  return call;
}

const addDays = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** A small dataset touching every table and most column types. */
async function seed(call) {
  const boot = await call("GET", "/api/bootstrap");
  const bench = boot.exercises.find((e) => e.name === "Bench press");
  const start = "2026-09-01";
  for (let i = 0; i < 12; i++) {
    const date = addDays(start, i);
    await call("PUT", `/api/days/${date}`, {
      weightLb: 200 - i * 0.3,
      calories: 2300 + (i % 3) * 50,
      proteinG: 190 + i,
      carbsG: 220,
      fatG: 70,
      steps: 12000 + i * 250,
      sleepMinutes: 420 + i,
      ...(i % 4 === 0 ? { metconDone: true, metconBenchmark: "Fran", metconScore: `${4 + (i % 3)}:${String(10 + i).padStart(2, "0")}` } : {}),
      ...(i === 3 ? { journal: "Felt strong — ünïcödé ✓, \"quotes\" and a\nnewline." } : {}),
    });
  }
  await call("PUT", "/api/settings", { ...boot.settings, program: { ...boot.settings.program, name: "Restore check program" } });
  const row = await call("POST", "/api/exercises", { name: "Restore-check curl", category: "accessory", measure: "reps" });
  await call("POST", `/api/exercises/${bench.id}/maxes`, { date: start, valueLb: 225, source: "manual", note: "start" });
  await call("POST", `/api/exercises/${bench.id}/maxes`, { date: addDays(start, 7), valueLb: 230, source: "manual", note: null });
  const set = (id, done) => ({ id, targetReps: 10, targetWeight: 50, reps: done ? 10 : null, weight: done ? 50 : null, done, amrap: false, appliedProgressionLb: null });
  await call("PUT", `/api/sessions/${addDays(start, 7)}`, {
    date: addDays(start, 7),
    label: "Push",
    cycle: 1,
    week: 1,
    deload: false,
    primaryMaxLb: 225,
    blocks: [
      {
        id: "b1",
        kind: "primary",
        exercises: [{ exerciseId: bench.id, measure: "reps", sets: [set("s1", true), { ...set("s2", true), amrap: true, reps: 14 }] }],
      },
      { id: "b2", kind: "accessory", exercises: [{ exerciseId: row.id, measure: "reps", sets: [set("s3", true), set("s4", false)] }] },
    ],
    notes: "Restore check",
    completedAt: `${addDays(start, 7)}T18:00:00.000Z`,
    planSig: null,
  });
  await call("POST", "/api/achievements/seen", { keys: ["first-entry", "restore-check"] });
}

/** The first path at which a and b differ, or null. */
function firstDifference(a, b, at = "$") {
  if (isDeepStrictEqual(a, b)) return null;
  if (a && b && typeof a === "object" && typeof b === "object" && Array.isArray(a) === Array.isArray(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      const d = firstDifference(a[k], b[k], Array.isArray(a) ? `${at}[${k}]` : `${at}.${k}`);
      if (d) return d;
    }
  }
  return `${at}: ${JSON.stringify(a)?.slice(0, 200)} ≠ ${JSON.stringify(b)?.slice(0, 200)}`;
}

async function main() {
  const [A, B] = databases();
  mkdirSync(outDir, { recursive: true });
  await recreate([A.name, B.name]);

  const a = await startServer(A.url);
  let exportA;
  try {
    const call = await client(a.base);
    await seed(call);
    exportA = await call("GET", "/api/export");
  } finally {
    await a.stop();
  }
  const fileA = path.join(outDir, "export-a.json");
  writeFileSync(fileA, JSON.stringify(exportA, null, 2));
  console.log(
    `restore-check: exported ${exportA.days.length} days, ${exportA.sessions.length} sessions, ${exportA.exercises.length} exercises, ` +
      `${exportA.maxEntries.length} max entries, ${exportA.seenAchievements.length} seen achievements`,
  );

  await run(process.execPath, ["dist/server/restore.js", fileA], { env: env(B.url) });

  const b = await startServer(B.url);
  let exportB;
  try {
    const call = await client(b.base);
    exportB = await call("GET", "/api/export");
  } finally {
    await b.stop();
  }
  writeFileSync(path.join(outDir, "export-b.json"), JSON.stringify(exportB, null, 2));

  const strip = ({ exportedAt: _, ...rest }) => rest;
  const diff = firstDifference(strip(exportA), strip(exportB));
  if (diff) {
    console.error(`restore-check: the restored database exports differently (files in ${outDir})\n  ${diff}`);
    process.exit(1);
  }
  console.log(`restore-check: ok — the restored export matches (files in ${outDir}).`);
}

main().catch((err) => {
  console.error(`restore-check: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
