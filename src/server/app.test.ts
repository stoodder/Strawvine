import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Bootstrap } from "../shared/schemas";
import { buildSession } from "../shared/session";
import { createApp, LOGIN_BODY_LIMIT_BYTES } from "./app";
import { deriveSessionKey, makeToken, MAX_AGE_S, RENEW_BELOW_S } from "./auth";
import { buildExport, restoreExport, RestoreError } from "./backup";
import { createDb, runMigrations, withMigrationLock } from "./db/client";
import { pruneIdempotencyKeys } from "./idempotency";
import { ensureSeeded, prepareDatabase } from "./seed";

const url = process.env.TEST_DATABASE_URL ?? "postgres://postgres@localhost:5432/strawvine_test";
const { db, sql: client } = createDb(url);
const secret = "x".repeat(40);
const app = createApp({ db, password: "hunter2", sessionSecret: secret, secureCookies: false, buildId: "test-build" });
let cookie = "";

const req = (path: string, init: RequestInit = {}) =>
  app.request(path, {
    ...init,
    headers: { "content-type": "application/json", cookie, ...(init.headers as Record<string, string>) },
  });
const json = (method: string, body: unknown) => ({ method, body: JSON.stringify(body) });

beforeAll(async () => {
  await db.execute(sql`drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;`);
  await runMigrations(db);
  await ensureSeeded(db, "2026-11-01");
});

const login = async (a = app) => {
  const res = await a.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "hunter2" }),
  });
  expect(res.status).toBe(200);
  return res.headers.get("set-cookie")!.split(";")[0]!;
};

afterAll(async () => {
  await client.end();
});

describe("auth", () => {
  it("rejects unauthenticated API calls", async () => {
    expect((await req("/api/bootstrap")).status).toBe(401);
  });

  it("rejects a wrong password and accepts the right one", async () => {
    expect((await req("/api/auth/login", json("POST", { password: "nope" }))).status).toBe(401);
    const res = await req("/api/auth/login", json("POST", { password: "hunter2" }));
    expect(res.status).toBe(200);
    cookie = res.headers.get("set-cookie")!.split(";")[0]!;
    expect(cookie).toMatch(/^sv_session=/);
  });

  it("rejects a tampered cookie", async () => {
    const res = await app.request("/api/bootstrap", { headers: { cookie: cookie.replace(/.$/, "x") } });
    expect(res.status).toBe(401);
  });
});

describe("api", () => {
  it("bootstraps the seeded program", async () => {
    const b = (await (await req("/api/bootstrap")).json()) as Bootstrap;
    expect(b.exercises.filter((e) => e.tracksMax).map((e) => e.name)).toEqual([
      "Bench press",
      "Deadlift",
      "Back squat",
      "Front squat",
      "Strict press",
    ]);
    expect(b.settings.program.cycleStartDate).toBe("2026-11-02");
    expect(b.settings.onboarded).toBe(false);
  });

  it("upserts and patches a day log", async () => {
    let res = await req("/api/days/2026-11-02", json("PUT", { weightLb: 201.4 }));
    expect(res.status).toBe(200);
    res = await req("/api/days/2026-11-02", json("PUT", { calories: 3100, proteinG: 210 }));
    const day = await res.json();
    expect(day).toMatchObject({ date: "2026-11-02", weightLb: 201.4, calories: 3100, proteinG: 210, zone2Done: false });
  });

  it("validates input", async () => {
    expect((await req("/api/days/2026-13-40", json("PUT", { weightLb: 200 }))).status).toBe(400);
    expect((await req("/api/days/2026-11-02", json("PUT", { weightLb: "heavy" }))).status).toBe(400);
    expect((await req("/api/days/2026-11-02", json("PUT", { bogus: 1 }))).status).toBe(400);
  });

  it("records maxes, saves sessions and settings", async () => {
    const b = (await (await req("/api/bootstrap")).json()) as Bootstrap;
    const bench = b.exercises.find((e) => e.name === "Bench press")!;
    const res = await req(`/api/exercises/${bench.id}/maxes`, json("POST", { date: "2026-11-01", valueLb: 315, source: "initial" }));
    expect(res.status).toBe(201);
    const entry = await res.json();

    const session = buildSession("2026-11-02", { ...b, maxEntries: [entry] });
    expect(session.blocks[0]!.exercises[0]!.sets[0]!.targetWeight).toBe(240);
    expect((await req("/api/sessions/2026-11-02", json("PUT", session))).status).toBe(200);
    expect((await req("/api/sessions/2026-11-03", json("PUT", session))).status).toBe(400);

    const settings = { ...b.settings, onboarded: true };
    expect((await req("/api/settings", json("PUT", settings))).status).toBe(200);
    expect((await req("/api/settings", json("PUT", { ...settings, program: null }))).status).toBe(400);

    const after = (await (await req("/api/bootstrap")).json()) as Bootstrap;
    expect(after.sessions).toHaveLength(1);
    expect(after.maxEntries[0]!.valueLb).toBe(315);
    expect(after.settings.onboarded).toBe(true);
  });

  it("creates exercises and remembers seen achievements", async () => {
    const res = await req("/api/exercises", json("POST", { name: "Hollow hold", category: "core", measure: "seconds" }));
    expect(res.status).toBe(201);
    await req("/api/achievements/seen", json("POST", { keys: ["calib-1", "calib-1"] }));
    const b = (await (await req("/api/bootstrap")).json()) as Bootstrap;
    expect(b.seenAchievements).toEqual(["calib-1"]);
    expect(b.exercises.at(-1)).toMatchObject({ name: "Hollow hold", measure: "seconds" });
  });
});

describe("settings preferences", () => {
  it("round-trips settings with and without the optional training/display fields", async () => {
    const b = (await (await req("/api/bootstrap")).json()) as Bootstrap;
    const { training: _t, display: _d, ...legacy } = b.settings;
    let res = await req("/api/settings", json("PUT", legacy));
    expect(res.status).toBe(200);
    let after = (await (await req("/api/bootstrap")).json()) as Bootstrap;
    expect(after.settings).not.toHaveProperty("training");
    expect(after.settings).not.toHaveProperty("display");

    const prefs = {
      ...legacy,
      training: { restSecondsMain: 150, restSecondsAccessory: 75, accessoryIncrementLb: 2.5 },
      display: { highContrast: true },
    };
    res = await req("/api/settings", json("PUT", prefs));
    expect(res.status).toBe(200);
    after = (await (await req("/api/bootstrap")).json()) as Bootstrap;
    expect(after.settings.training).toEqual(prefs.training);
    expect(after.settings.display).toEqual({ highContrast: true });

    expect((await req("/api/settings", json("PUT", { ...prefs, training: { ...prefs.training, restSecondsMain: 5 } }))).status).toBe(400);
    expect((await req("/api/settings", json("PUT", { ...prefs, display: { highContrast: "yes" } }))).status).toBe(400);
  });

  it("stores correction max entries", async () => {
    const b = (await (await req("/api/bootstrap")).json()) as Bootstrap;
    const bench = b.exercises.find((e) => e.name === "Bench press")!;
    const res = await req(`/api/exercises/${bench.id}/maxes`, json("POST", { date: "2026-11-03", valueLb: 310, source: "correction" }));
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ source: "correction", valueLb: 310 });
    const after = (await (await req("/api/bootstrap")).json()) as Bootstrap;
    expect(after.maxEntries.at(-1)).toMatchObject({ source: "correction" });
  });
});

describe("idempotent creates", () => {
  const withKey = (key: string, body: unknown) => ({ ...json("POST", body), headers: { "idempotency-key": key } });
  const count = async (table: "exercises" | "max_entries") =>
    (await db.execute<{ n: number }>(sql`select count(*)::int as n from ${sql.identifier(table)}`))[0]!.n;

  it("creates an exercise once per key and replays the first response", async () => {
    const before = await count("exercises");
    const first = await req("/api/exercises", withKey("key-exercise-0001", { name: "Cable row" }));
    expect(first.status).toBe(201);
    const created = await first.json();
    const again = await req("/api/exercises", withKey("key-exercise-0001", { name: "Cable row" }));
    expect(again.status).toBe(201);
    expect(again.headers.get("idempotent-replayed")).toBe("true");
    expect(await again.json()).toEqual(created);
    expect(await count("exercises")).toBe(before + 1);
    // Without a key, every POST creates.
    await req("/api/exercises", json("POST", { name: "Cable row" }));
    expect(await count("exercises")).toBe(before + 2);
  });

  it("creates a max once per key, even for concurrent retries", async () => {
    const b = (await (await req("/api/bootstrap")).json()) as Bootstrap;
    const squat = b.exercises.find((e) => e.name === "Back squat")!;
    const before = await count("max_entries");
    const body = { date: "2026-11-04", valueLb: 405, source: "manual" };
    const responses = await Promise.all(
      Array.from({ length: 4 }, () => req(`/api/exercises/${squat.id}/maxes`, withKey("key-max-concurrent-1", body))),
    );
    expect(responses.map((r) => r.status)).toEqual([201, 201, 201, 201]);
    const ids = new Set(await Promise.all(responses.map(async (r) => (await r.json()).id)));
    expect(ids.size).toBe(1);
    expect(await count("max_entries")).toBe(before + 1);
  });

  it("refuses a key reused for another request, and malformed keys", async () => {
    await req("/api/exercises", withKey("key-reused-0001", { name: "Face pull" }));
    const b = (await (await req("/api/bootstrap")).json()) as Bootstrap;
    const bench = b.exercises.find((e) => e.name === "Bench press")!;
    const res = await req(`/api/exercises/${bench.id}/maxes`, withKey("key-reused-0001", { date: "2026-11-04", valueLb: 320 }));
    expect(res.status).toBe(422);
    for (const key of ["short", "x".repeat(81), "has space!"])
      expect((await req("/api/exercises", withKey(key, { name: "Face pull" }))).status, key).toBe(400);
  });

  it("doesn't store failures, so the key still works once the request can succeed", async () => {
    expect((await req("/api/exercises/999999/maxes", withKey("key-missing-0001", { date: "2026-11-04", valueLb: 1 }))).status).toBe(404);
    expect((await req("/api/exercises", withKey("key-invalid-0001", { name: "" }))).status).toBe(400);
    const ok = await req("/api/exercises", withKey("key-invalid-0001", { name: "Shrug" }));
    expect(ok.status).toBe(201);
    expect((await ok.json()).name).toBe("Shrug");
  });

  it("prunes keys older than a week", async () => {
    await db.execute(sql`update idempotency_keys set created_at = now() - interval '8 days' where key = 'key-exercise-0001'`);
    expect(await pruneIdempotencyKeys(db)).toBe(1);
    const rows = await db.execute<{ key: string }>(sql`select key from idempotency_keys where key = 'key-max-concurrent-1'`);
    expect(rows).toHaveLength(1);
  });
});

describe("path parameters", () => {
  const patch = (id: string) => req(`/api/exercises/${id}`, json("PATCH", { archived: true }));
  const addMax = (id: string) => req(`/api/exercises/${id}/maxes`, json("POST", { date: "2026-11-01", valueLb: 300 }));
  const deleteMax = (id: string) => req(`/api/maxes/${id}`, { method: "DELETE" });

  it("rejects ids that aren't positive integers with 400", async () => {
    for (const id of ["abc", "0", "-1", "1.5", "1e3", "0x1", "99999999999"]) {
      expect((await patch(id)).status, `PATCH /exercises/${id}`).toBe(400);
      expect((await addMax(id)).status, `POST /exercises/${id}/maxes`).toBe(400);
      expect((await deleteMax(id)).status, `DELETE /maxes/${id}`).toBe(400);
    }
  });

  it("still answers 404 for well-formed ids that don't exist, and works for real ones", async () => {
    expect((await patch("999999")).status).toBe(404);
    expect((await addMax("999999")).status).toBe(404);
    expect((await deleteMax("999999")).status).toBe(404);

    const created = await (await req("/api/exercises", json("POST", { name: "Band pull-apart" }))).json();
    const res = await patch(String(created.id));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: created.id, archived: true });
    const max = await addMax(String(created.id));
    expect(max.status).toBe(201);
    expect((await deleteMax(String((await max.json()).id))).status).toBe(200);
  });

  it("validates the date when deleting a session", async () => {
    expect((await req("/api/sessions/not-a-date", { method: "DELETE" })).status).toBe(400);
    expect((await req("/api/sessions/2026-02-30", { method: "DELETE" })).status).toBe(400);

    const b = (await (await req("/api/bootstrap")).json()) as Bootstrap;
    const session = buildSession("2026-11-09", b);
    expect((await req("/api/sessions/2026-11-09", json("PUT", session))).status).toBe(200);
    expect((await req("/api/sessions/2026-11-09", { method: "DELETE" })).status).toBe(200);
    const after = (await (await req("/api/bootstrap")).json()) as Bootstrap;
    expect(after.sessions.map((s) => s.date)).not.toContain("2026-11-09");
  });
});

describe("request hardening", () => {
  it("limits request bodies with a JSON 413", async () => {
    const big = JSON.stringify({ password: "a".repeat(LOGIN_BODY_LIMIT_BYTES) });
    const res = await req("/api/auth/login", { method: "POST", body: big });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "Request body too large" });
    const huge = JSON.stringify({ journal: "a".repeat(1024 * 1024) });
    expect((await req("/api/days/2026-11-05", { method: "PUT", body: huge })).status).toBe(413);
    // Chunked bodies (no content-length) are counted as they stream.
    const stream = new ReadableStream({
      start(ctl) {
        for (let i = 0; i < 20; i++) ctl.enqueue(new TextEncoder().encode("a".repeat(64 * 1024)));
        ctl.close();
      },
    });
    const chunked = await app.request("/api/days/2026-11-05", {
      method: "PUT",
      body: stream,
      headers: { "content-type": "application/json", cookie },
      duplex: "half",
    } as RequestInit);
    expect(chunked.status).toBe(413);
  });

  it("refuses cross-site and cross-origin writes", async () => {
    const put = (headers: Record<string, string>) =>
      req("/api/days/2026-11-06", { method: "PUT", body: JSON.stringify({ steps: 1 }), headers });
    expect((await put({ "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await put({ "sec-fetch-site": "same-site" })).status).toBe(403);
    expect((await put({ origin: "https://evil.herokuapp.com", host: "strawvine.herokuapp.com" })).status).toBe(403);
    expect((await put({ origin: "null", host: "strawvine.herokuapp.com" })).status).toBe(403);
    // Same origin (the scheme may differ behind a TLS-terminating proxy) is fine.
    const ok = await put({ origin: "https://strawvine.herokuapp.com", host: "strawvine.herokuapp.com", "sec-fetch-site": "same-origin" });
    expect(ok.status).toBe(200);
    // Reads aren't affected.
    expect((await req("/api/bootstrap", { headers: { "sec-fetch-site": "cross-site" } })).status).toBe(200);
    // A cross-site logout can't sign everyone out.
    expect((await req("/api/auth/logout", { method: "POST", headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
    expect((await req("/api/bootstrap")).status).toBe(200);
  });

  it("only accepts JSON bodies", async () => {
    const body = JSON.stringify({ steps: 2 });
    expect((await req("/api/days/2026-11-06", { method: "PUT", body, headers: { "content-type": "text/plain" } })).status).toBe(415);
    expect(
      (await req("/api/days/2026-11-06", { method: "PUT", body, headers: { "content-type": "application/x-www-form-urlencoded" } })).status,
    ).toBe(415);
    const noType = await app.request("/api/days/2026-11-06", { method: "PUT", body: new Blob([body]), headers: { cookie } });
    expect(noType.status).toBe(415);
    expect(
      (await req("/api/days/2026-11-06", { method: "PUT", body, headers: { "content-type": "application/json; charset=utf-8" } })).status,
    ).toBe(200);
    // Body-less writes need no content type.
    expect((await app.request("/api/sessions/2026-11-20", { method: "DELETE", headers: { cookie } })).status).toBe(200);
  });

  it("rejects NUL characters and out-of-range years", async () => {
    expect((await req("/api/days/2026-11-06", json("PUT", { journal: "a\u0000b" }))).status).toBe(400);
    expect((await req("/api/days/1899-12-31", json("PUT", { steps: 1 }))).status).toBe(400);
    expect((await req("/api/days/3026-11-06", json("PUT", { steps: 1 }))).status).toBe(400);
    expect((await req("/api/achievements/seen", json("POST", { keys: ["a\u0000"] }))).status).toBe(400);
  });

  it("marks API responses uncacheable and tags them with the build", async () => {
    const res = await req("/api/auth/me");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-strawvine-build")).toBe("test-build");
    const csp = res.headers.get("content-security-policy")!;
    for (const d of ["frame-ancestors 'none'", "object-src 'none'", "base-uri 'self'", "form-action 'self'"]) expect(csp).toContain(d);
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("strict-transport-security")).toContain("max-age=");
    expect(res.headers.get("permissions-policy")).toContain("camera=()");
  });

  it("revalidates the bootstrap with an ETag and compresses it", async () => {
    const first = await req("/api/bootstrap", { headers: { "accept-encoding": "gzip" } });
    expect(first.status).toBe(200);
    expect(first.headers.get("content-encoding")).toBe("gzip");
    expect(first.headers.get("cache-control")).toBe("private, no-cache");
    const tag = first.headers.get("etag")!;
    expect(tag).toBeTruthy();
    const again = await req("/api/bootstrap", { headers: { "if-none-match": tag } });
    expect(again.status).toBe(304);
    expect(again.headers.get("x-strawvine-build")).toBe("test-build");
    await req("/api/days/2026-11-07", json("PUT", { steps: 1234 }));
    expect((await req("/api/bootstrap", { headers: { "if-none-match": tag } })).status).toBe(200);
  });

  it("checks the database in /api/health", async () => {
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, db: "ok" });
  });

  it("redirects plain HTTP to HTTPS behind the proxy", async () => {
    const prod = createApp({ db, password: "hunter2", sessionSecret: secret, secureCookies: true, trustProxy: true, forceHttps: true });
    const res = await prod.request("/goals?x=1", { headers: { "x-forwarded-proto": "http", host: "strawvine.example" } });
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("https://strawvine.example/goals?x=1");
    expect((await prod.request("/api/health", { headers: { "x-forwarded-proto": "https" } })).status).toBe(200);
  });

  it("logs failures without details and answers with a generic 500", async () => {
    const logged: Array<Record<string, unknown>> = [];
    const failing = new Proxy({} as typeof db, {
      get() {
        throw Object.assign(new Error("insert into day_logs values ('secret journal')"), { code: "23505" });
      },
    });
    const broken = createApp({
      db: failing,
      password: "hunter2",
      sessionSecret: secret,
      secureCookies: false,
      epochs: { current: async () => 0, bump: async () => 1 },
      log: (_m, details) => logged.push(details),
    });
    const res = await broken.request("/api/days/2026-11-02", {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: `sv_session=${makeToken(deriveSessionKey(secret, "hunter2"), 0)}` },
      body: JSON.stringify({ journal: "secret journal" }),
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Something went wrong" });
    expect(logged).toEqual([{ name: "Error", code: "23505", method: "PUT", route: "/api/days/:date" }]);
    expect(JSON.stringify(logged)).not.toContain("secret");
  });
});

describe("sessions", () => {
  const key = deriveSessionKey(secret, "hunter2");
  const DAY = 86_400_000;

  it("re-issues the cookie when it gets old, but not on every request", async () => {
    const epoch = Number(cookie.split(".")[1]);
    const fresh = await app.request("/api/auth/me", { headers: { cookie } });
    expect(fresh.headers.get("set-cookie")).toBeNull();
    const old = `sv_session=${makeToken(key, epoch, Date.now() - (MAX_AGE_S * 1000 - RENEW_BELOW_S * 1000 + DAY))}`;
    const res = await app.request("/api/auth/me", { headers: { cookie: old } });
    expect(res.status).toBe(200);
    const renewed = res.headers.get("set-cookie")!;
    expect(renewed).toMatch(/^sv_session=/);
    expect(renewed).toContain(`Max-Age=${MAX_AGE_S}`);
    const expired = `sv_session=${makeToken(key, epoch, Date.now() - MAX_AGE_S * 1000 - 1000)}`;
    expect((await app.request("/api/auth/me", { headers: { cookie: expired } })).status).toBe(401);
  });

  it("signs every device out on logout", async () => {
    const phone = await login();
    const laptop = await login();
    expect((await app.request("/api/auth/me", { headers: { cookie: laptop } })).status).toBe(200);
    // Logging out without a valid session doesn't revoke anything.
    await app.request("/api/auth/logout", { method: "POST", headers: { cookie: "sv_session=bogus" } });
    expect((await app.request("/api/auth/me", { headers: { cookie: laptop } })).status).toBe(200);

    const out = await app.request("/api/auth/logout", { method: "POST", headers: { cookie: phone } });
    expect(out.status).toBe(200);
    expect(out.headers.get("set-cookie")).toMatch(/^sv_session=;/);
    expect((await app.request("/api/auth/me", { headers: { cookie: phone } })).status).toBe(401);
    expect((await app.request("/api/auth/me", { headers: { cookie: laptop } })).status).toBe(401);
    cookie = await login();
    expect((await req("/api/auth/me")).status).toBe(200);
  });

  it("signs everyone out when the password changes", async () => {
    const changed = createApp({ db, password: "correct horse battery", sessionSecret: secret, secureCookies: false });
    expect((await changed.request("/api/auth/me", { headers: { cookie } })).status).toBe(401);
  });

  it("uses a __Host- cookie over HTTPS", async () => {
    const prod = createApp({ db, password: "hunter2", sessionSecret: secret, secureCookies: true });
    const res = await prod.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "hunter2" }),
    });
    const set = res.headers.get("set-cookie")!;
    expect(set).toMatch(/^__Host-sv_session=/);
    expect(set).toContain("Secure");
    expect(set).toContain("Path=/");
    const c = set.split(";")[0]!;
    expect((await prod.request("/api/auth/me", { headers: { cookie: c } })).status).toBe(200);
    expect((await prod.request("/api/auth/me", { headers: { cookie: c.replace("__Host-", "") } })).status).toBe(401);
  });

  it("rate-limits failed logins only", async () => {
    const limited = createApp({
      db,
      password: "hunter2",
      sessionSecret: secret,
      secureCookies: false,
      loginLimits: { perClient: 2, global: 100 },
    });
    const attempt = (password: string) =>
      limited.request("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
    for (let i = 0; i < 5; i++) expect((await attempt("hunter2")).status).toBe(200);
    expect((await attempt("nope")).status).toBe(401);
    expect((await attempt("nope")).status).toBe(401);
    expect((await attempt("nope")).status).toBe(429);
    expect((await attempt("hunter2")).status).toBe(429);
  });
});

describe("static web app", () => {
  let dir = "";
  let web: ReturnType<typeof createApp>;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "strawvine-web-"));
    mkdirSync(path.join(dir, "assets"));
    writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>Strawvine</title>");
    writeFileSync(path.join(dir, "assets", "index-abc123.js"), `console.log(${JSON.stringify("x".repeat(4000))});`);
    writeFileSync(path.join(dir, "sw.js"), "self.addEventListener('fetch', () => {});");
    web = createApp({ db, password: "hunter2", sessionSecret: secret, secureCookies: false, staticDir: dir });
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("caches hashed assets forever and compresses them", async () => {
    const res = await web.request("/assets/index-abc123.js", { headers: { "accept-encoding": "gzip" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("content-encoding")).toBe("gzip");
  });

  it("answers 404 for a missing asset instead of the app shell", async () => {
    const res = await web.request("/assets/index-old999.js");
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("revalidates the app shell and service worker on every load", async () => {
    for (const p of ["/", "/index.html", "/goals", "/sw.js"]) {
      const res = await web.request(p);
      expect(res.status, p).toBe(200);
      expect(res.headers.get("cache-control"), p).toBe("no-cache");
    }
    expect(await (await web.request("/goals")).text()).toContain("<title>Strawvine</title>");
  });
});

describe("export & restore", () => {
  it("round-trips everything through an export", async () => {
    await req("/api/achievements/seen", json("POST", { keys: ["streak-3"] }));
    const res = await req("/api/export");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="strawvine-export-\d{4}-\d{2}-\d{2}\.json"$/);
    const exported = await res.json();
    expect(exported).toMatchObject({ format: "strawvine-export", version: 2 });
    expect(exported.seenAchievements.map((s: { key: string }) => s.key)).toEqual(["calib-1", "streak-3"]);
    expect(exported.exercises[0].createdAt).toMatch(/Z$/);
    expect(exported.maxEntries.length).toBeGreaterThan(0);
    expect(exported.days.length).toBeGreaterThan(0);

    await expect(restoreExport(db, exported)).rejects.toThrow(RestoreError);
    await expect(restoreExport(db, { ...exported, days: "nope" }, { force: true })).rejects.toThrow(/Not a valid Strawvine export/);

    // Wipe the data, then restore into the freshly seeded database without --force.
    await db.execute(sql`truncate day_logs, sessions, max_entries, seen_achievements, exercises, settings restart identity cascade`);
    const { sql: other } = createDb(url);
    await prepareDatabase(db, other);
    await other.end();
    const summary = await restoreExport(db, exported);
    expect(summary.days).toBe(exported.days.length);

    const { exportedAt: _a, ...before } = exported;
    const { exportedAt: _b, ...after } = await buildExport(db);
    expect(after).toEqual(before);

    // The restore signed every device out (a fresh app: no cached epoch).
    const restored = createApp({ db, password: "hunter2", sessionSecret: secret, secureCookies: false });
    expect((await restored.request("/api/auth/me", { headers: { cookie } })).status).toBe(401);
    cookie = await login(restored);

    // Sequences moved past the restored ids.
    const created = await (
      await restored.request("/api/exercises", {
        ...json("POST", { name: "Ring dip" }),
        headers: { "content-type": "application/json", cookie },
      })
    ).json();
    expect(created.id).toBe(Math.max(...exported.exercises.map((e: { id: number }) => e.id)) + 1);
  });

  it("accepts a pre-versioning export and replaces data only with force", async () => {
    const current = await buildExport(db);
    const legacy = {
      exportedAt: current.exportedAt,
      settings: current.settings,
      days: current.days,
      exercises: current.exercises.map(({ createdAt: _c, ...e }) => e),
      maxEntries: current.maxEntries,
      sessions: current.sessions,
    };
    const summary = await restoreExport(db, legacy, { force: true });
    expect(summary).toMatchObject({ seenAchievements: 0, exercises: current.exercises.length });
    expect((await buildExport(db)).seenAchievements).toEqual([]);
  });

  it("bumps the session epoch and clears idempotency keys on every restore", async () => {
    const epoch = async () => (await db.execute<{ e: number }>(sql`select session_epoch as e from auth_state where id = 1`))[0]?.e ?? 0;
    await db.execute(
      sql`insert into idempotency_keys (key, method, path, status, body) values ('key-before-restore', 'POST', '/api/exercises', 201, '{}')`,
    );
    const before = await epoch();
    const summary = await restoreExport(db, await buildExport(db), { force: true });
    expect(summary.sessionEpoch).toBe(before + 1);
    expect(await epoch()).toBe(before + 1);
    expect(await db.execute(sql`select key from idempotency_keys`)).toHaveLength(0);
    // A cookie from before the restore no longer works; a new sign-in does.
    const fresh = createApp({ db, password: "hunter2", sessionSecret: secret, secureCookies: false });
    const stale = `sv_session=${makeToken(deriveSessionKey(secret, "hunter2"), before)}`;
    expect((await fresh.request("/api/auth/me", { headers: { cookie: stale } })).status).toBe(401);
    expect((await fresh.request("/api/auth/me", { headers: { cookie: await login(fresh) } })).status).toBe(200);
  });

  it("serialises migrations behind an advisory lock", async () => {
    const order: string[] = [];
    const { sql: a } = createDb(url);
    const { sql: b } = createDb(url);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const first = withMigrationLock(a, async () => {
      order.push("first:start");
      await held;
      order.push("first:end");
    });
    await new Promise((r) => setTimeout(r, 50));
    const second = withMigrationLock(b, async () => {
      order.push("second");
    });
    await new Promise((r) => setTimeout(r, 100));
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
    await Promise.all([a.end(), b.end()]);
  });
});
