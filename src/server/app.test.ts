import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Bootstrap } from "../shared/schemas";
import { buildSession } from "../shared/session";
import { maxPrs, effectiveMaxHistory } from "../shared/gamify";
import { clampCreatedAt, createApp, LOGIN_BODY_LIMIT_BYTES } from "./app";
import { deriveSessionKey, makeToken, MAX_AGE_S, RENEW_BELOW_S } from "./auth";
import { buildExport, restoreExport, RestoreError } from "./backup";
import { createDb, MigrationLockTimeout, runMigrations, withMigrationLock } from "./db/client";
import { pruneIdempotencyKeys, requestHash } from "./idempotency";
import { ensureSeeded, prepareDatabase } from "./seed";
import { assertDisposableDatabase } from "./testDb";

const url = process.env.TEST_DATABASE_URL ?? "postgres://postgres@localhost:5432/strawvine_test";
// These tests drop and recreate the schema: never against anything but a local throwaway database.
assertDisposableDatabase(url);
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
/** The cookie-signing key for this database's current salt. */
const dbKey = async () => {
  const [row] = await db.execute<{ salt: string | null }>(sql`select key_salt as salt from auth_state where id = 1`);
  return deriveSessionKey(secret, "hunter2", row?.salt ?? "");
};

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

  it("seeds which exercises are weighted: everything but the pull-up", async () => {
    const b = (await (await req("/api/bootstrap")).json()) as Bootstrap;
    const weighted = Object.fromEntries(b.exercises.filter((e) => e.id <= 9).map((e) => [e.name, e.weighted]));
    expect(weighted).toEqual({
      "Bench press": true,
      Deadlift: true,
      "Back squat": true,
      "Front squat": true,
      "Strict press": true,
      "Pull-up": false,
      "Sandbag clean": true,
      "Sandbag carry": true,
      "Farmer's carry": true,
    });
  });

  it("creates weighted and unweighted exercises of any measure, and patches the flag", async () => {
    const create = async (body: object) => {
      const res = await req("/api/exercises", json("POST", body));
      expect(res.status).toBe(201);
      return res.json();
    };
    // Not saying (an older client) is weighted, whatever the measure.
    expect(await create({ name: "Cable curl" })).toMatchObject({ measure: "reps", weighted: true });
    expect(await create({ name: "Plank", category: "core", measure: "seconds" })).toMatchObject({ weighted: true });
    const hang = await create({ name: "Weighted dead hang", measure: "seconds", weighted: true });
    expect(hang).toMatchObject({ measure: "seconds", weighted: true });
    const run = await create({ name: "Shuttle run", category: "conditioning", measure: "meters", weighted: false });
    expect(run).toMatchObject({ measure: "meters", weighted: false });
    expect((await req("/api/exercises", json("POST", { name: "Dip", weighted: "yes" }))).status).toBe(400);

    const patched = await req(`/api/exercises/${run.id}`, json("PATCH", { weighted: true }));
    expect(await patched.json()).toMatchObject({ id: run.id, measure: "meters", weighted: true });
    expect((await req(`/api/exercises/${hang.id}`, json("PATCH", { weighted: null }))).status).toBe(400);
    const b = (await (await req("/api/bootstrap")).json()) as Bootstrap;
    expect(b.exercises.find((e) => e.id === run.id)?.weighted).toBe(true);

    // Rows written without the column (as before the migration) are weighted.
    const [raw] = await db.execute<{ weighted: boolean }>(sql`insert into exercises (name) values ('Raw row') returning weighted`);
    expect(raw?.weighted).toBe(true);
    await db.execute(sql`delete from exercises where name = 'Raw row'`);
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

  it("refuses a key reused with a different body instead of replaying the old response", async () => {
    const first = await req("/api/exercises", withKey("key-body-0001", { name: "Lat pulldown" }));
    expect(first.status).toBe(201);
    // Same body, keys in another order: a genuine retry.
    const retry = await req("/api/exercises", withKey("key-body-0001", { measure: "reps", name: "Lat pulldown" }));
    expect(retry.status).toBe(201);
    expect(retry.headers.get("idempotent-replayed")).toBe("true");
    const other = await req("/api/exercises", withKey("key-body-0001", { name: "Seated row" }));
    expect(other.status).toBe(422);
  });

  it("replays an exercise create retried with or without the weighted flag the first attempt had", async () => {
    // Windows on different builds share one queued create: a build from before the flag sends it
    // without `weighted` (the response is lost), a newer one retries it with the flag.
    const before = await count("exercises");
    const base = { name: "Hollow rock", category: "core", measure: "seconds", tracksMax: false };
    const first = await req("/api/exercises", withKey("key-weighted-0001", base));
    expect(first.status).toBe(201);
    const created = await first.json();
    expect(created).toMatchObject({ weighted: true });
    for (const weighted of [true, false]) {
      const retry = await req("/api/exercises", withKey("key-weighted-0001", { ...base, weighted }));
      expect(retry.status, String(weighted)).toBe(201);
      expect(retry.headers.get("idempotent-replayed")).toBe("true");
      // The first response, as stored (a create that meant unweighted is patched by the client).
      expect(await retry.json()).toEqual(created);
    }
    // And the other way round: sent unweighted by a newer build, retried by an older one.
    const unweighted = await (
      await req("/api/exercises", withKey("key-weighted-0002", { ...base, name: "L-sit", weighted: false }))
    ).json();
    expect(unweighted).toMatchObject({ weighted: false });
    const old = await req("/api/exercises", withKey("key-weighted-0002", { ...base, name: "L-sit" }));
    expect(old.headers.get("idempotent-replayed")).toBe("true");
    expect(await old.json()).toEqual(unweighted);
    expect(await count("exercises")).toBe(before + 2);
    // Anything else under the key is still another request.
    expect((await req("/api/exercises", withKey("key-weighted-0001", { ...base, name: "V-up", weighted: true }))).status).toBe(422);
    expect((await req("/api/exercises", withKey("key-weighted-0001", { ...base, measure: "reps" }))).status).toBe(422);
  });

  it("replays exercise creates stored by a server from before the weighted flag", async () => {
    // Hash and response exactly as that server stored them: its parsed body (defaults applied).
    const oldHash = requestHash({ name: "Kettlebell halo", category: "accessory", tracksMax: false, measure: "reps" });
    const oldBody = { id: 4242, name: "Kettlebell halo", category: "accessory", tracksMax: false, measure: "reps", archived: false };
    await db.execute(
      sql`insert into idempotency_keys (key, method, path, status, body, request_hash)
          values ('key-pre-weighted-1', 'POST', '/api/exercises', 201, ${JSON.stringify(oldBody)}::jsonb, ${oldHash})`,
    );
    const before = await count("exercises");
    for (const body of [{ name: "Kettlebell halo" }, { name: "Kettlebell halo", weighted: true }]) {
      const res = await req("/api/exercises", withKey("key-pre-weighted-1", body));
      expect(res.status, JSON.stringify(body)).toBe(201);
      expect(res.headers.get("idempotent-replayed")).toBe("true");
      expect(await res.json()).toEqual(oldBody);
    }
    expect(await count("exercises")).toBe(before);
  });

  it("forgets the stored create when that max is deleted", async () => {
    const b = (await (await req("/api/bootstrap")).json()) as Bootstrap;
    const press = b.exercises.find((e) => e.name === "Strict press")!;
    const body = { date: "2026-11-04", valueLb: 140 };
    const created = await (await req(`/api/exercises/${press.id}/maxes`, withKey("key-max-delete-1", body))).json();
    expect((await req(`/api/maxes/${created.id}`, { method: "DELETE" })).status).toBe(200);
    const rows = await db.execute(sql`select key from idempotency_keys where key = 'key-max-delete-1'`);
    expect(rows).toHaveLength(0);
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

describe("max entries made offline", () => {
  const MIN = 60_000;
  const DAY = 24 * 60 * MIN;
  const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10);

  it("clamps the device's createdAt to the last 30 days and 5 minutes ahead", () => {
    const now = Date.parse("2026-11-01T12:00:00Z");
    expect(clampCreatedAt(undefined, now).toISOString()).toBe("2026-11-01T12:00:00.000Z");
    expect(clampCreatedAt("2026-10-30T08:00:00Z", now).toISOString()).toBe("2026-10-30T08:00:00.000Z");
    expect(clampCreatedAt("2025-01-01T00:00:00Z", now).getTime()).toBe(now - 30 * DAY);
    expect(clampCreatedAt("2027-01-01T00:00:00Z", now).getTime()).toBe(now + 5 * MIN);
  });

  it("stores createdAt sent as an ISO string, and the server time without one", async () => {
    const b = (await (await req("/api/bootstrap")).json()) as Bootstrap;
    const squat = b.exercises.find((e) => e.name === "Front squat")!;
    const at = new Date(Date.now() - 3 * DAY);
    const sent = await req(
      `/api/exercises/${squat.id}/maxes`,
      json("POST", { date: isoDay(at.getTime()), valueLb: 250, createdAt: at.toISOString() }),
    );
    expect(sent.status).toBe(201);
    expect((await sent.json()).createdAt).toBe(at.toISOString());
    // With an offset, too.
    const offset = await req(
      `/api/exercises/${squat.id}/maxes`,
      json("POST", { date: "2026-11-01", valueLb: 251, createdAt: "2026-10-31T20:00:00-04:00" }),
    );
    expect(offset.status).toBe(201);
    const before = Date.now();
    const plain = await req(`/api/exercises/${squat.id}/maxes`, json("POST", { date: "2026-11-01", valueLb: 252 }));
    expect(plain.status).toBe(201);
    expect(Math.abs(Date.parse((await plain.json()).createdAt) - before)).toBeLessThan(60_000);
  });

  /** Creates a lift with a baseline, then posts `entries` back to back (an outbox flush). */
  async function flush(name: string, entries: Array<{ date: string; valueLb: number; source: string; createdAt?: string }>) {
    const ex = await (await req("/api/exercises", json("POST", { name, category: "primary", tracksMax: true }))).json();
    const baseline = Date.now() - 20 * DAY;
    await req(
      `/api/exercises/${ex.id}/maxes`,
      json("POST", { date: isoDay(baseline), valueLb: 300, source: "initial", createdAt: new Date(baseline).toISOString() }),
    );
    for (const e of entries) expect((await req(`/api/exercises/${ex.id}/maxes`, json("POST", e))).status).toBe(201);
    const b = (await (await req("/api/bootstrap")).json()) as Bootstrap;
    const mine = b.maxEntries.filter((m) => m.exerciseId === ex.id);
    return { mine, prs: maxPrs(effectiveMaxHistory(mine)) };
  }

  it("keeps an AMRAP bump and a later manual max from merging into one correction", async () => {
    const amrapAt = Date.now() - 6 * DAY; // "Oct 26"
    const manualAt = Date.now() - 4 * DAY; // "Oct 28"
    const { mine, prs } = await flush("Offline press A", [
      { date: isoDay(amrapAt), valueLb: 303, source: "amrap", createdAt: new Date(amrapAt).toISOString() },
      { date: isoDay(manualAt), valueLb: 310, source: "manual", createdAt: new Date(manualAt).toISOString() },
    ]);
    expect(mine.map((m) => m.createdAt)).toContain(new Date(amrapAt).toISOString());
    expect(prs.map((p) => p.entry.valueLb)).toEqual([303, 310]);
  });

  it("doesn't let a lower manual max a week later erase a PR", async () => {
    const prAt = Date.now() - 12 * DAY; // "Oct 20"
    const laterAt = Date.now() - 5 * DAY; // "Oct 27"
    const { prs } = await flush("Offline press B", [
      { date: isoDay(prAt), valueLb: 320, source: "manual", createdAt: new Date(prAt).toISOString() },
      { date: isoDay(laterAt), valueLb: 290, source: "manual", createdAt: new Date(laterAt).toISOString() },
    ]);
    expect(prs.map((p) => p.entry.valueLb)).toEqual([320]);
  });

  it("still treats a quick re-entry as a correction, and rejects malformed timestamps", async () => {
    const at = Date.now() - 2 * DAY;
    const { prs } = await flush("Offline press C", [
      { date: isoDay(at), valueLb: 1320, source: "manual", createdAt: new Date(at).toISOString() },
      { date: isoDay(at), valueLb: 320, source: "manual", createdAt: new Date(at + 2 * MIN).toISOString() },
    ]);
    expect(prs.map((p) => p.entry.valueLb)).toEqual([320]);
    const b = (await (await req("/api/bootstrap")).json()) as Bootstrap;
    const bench = b.exercises.find((e) => e.name === "Bench press")!;
    expect(
      (await req(`/api/exercises/${bench.id}/maxes`, json("POST", { date: "2026-11-01", valueLb: 1, createdAt: "yesterday" }))).status,
    ).toBe(400);
  });
});

describe("path parameters", () => {
  const patch = (id: string) => req(`/api/exercises/${id}`, json("PATCH", { archived: true }));
  const addMax = (id: string) => req(`/api/exercises/${id}/maxes`, json("POST", { date: "2026-11-01", valueLb: 300 }));
  const deleteMax = (id: string) => req(`/api/maxes/${id}`, { method: "DELETE" });

  it("rejects ids that aren't positive integers with 400", async () => {
    for (const id of ["abc", "0", "-1", "1.5", "1e3", "0x1", "99999999999", "01", "007", "+5", " 5"]) {
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
    // Cross-site reads are refused too (a link or navigation from another site can't fetch the
    // data set or download the export); same-origin and direct navigation (none) are fine.
    expect((await req("/api/bootstrap", { headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
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

  it("keeps the bootstrap out of the HTTP cache, revalidates it by ETag and compresses it", async () => {
    const first = await req("/api/bootstrap", { headers: { "accept-encoding": "gzip" } });
    expect(first.status).toBe(200);
    expect(first.headers.get("content-encoding")).toBe("gzip");
    expect(first.headers.get("cache-control")).toBe("no-store");
    const tag = first.headers.get("etag")!;
    expect(tag).toMatch(/^W\/".+"$/);
    const again = await req("/api/bootstrap", { headers: { "if-none-match": tag } });
    expect(again.status).toBe(304);
    expect(again.headers.get("etag")).toBe(tag);
    expect(again.headers.get("cache-control")).toBe("no-store");
    expect(again.headers.get("x-strawvine-build")).toBe("test-build");
    expect((await req("/api/bootstrap", { headers: { "if-none-match": `W/"other", ${tag}` } })).status).toBe(304);

    // Every kind of write moves the tag on.
    let current = tag;
    const changes = async (write: () => Response | Promise<Response>) => {
      expect((await write()).ok).toBe(true);
      const res = await req("/api/bootstrap", { headers: { "if-none-match": current } });
      expect(res.status).toBe(200);
      current = res.headers.get("etag")!;
    };
    const b = (await (await req("/api/bootstrap")).json()) as Bootstrap;
    await changes(() => req("/api/days/2026-11-07", json("PUT", { steps: 1234 })));
    await changes(() => req("/api/days/2026-11-07", json("PUT", { steps: 1235 })));
    await changes(() => req(`/api/exercises/${b.exercises[0]!.id}`, json("PATCH", { name: "Bench press" })));
    await changes(() => req("/api/achievements/seen", json("POST", { keys: ["etag-test"] })));
    await changes(() => req("/api/settings", json("PUT", b.settings)));
    let id = 0;
    await changes(async () => {
      const res = await req(`/api/exercises/${b.exercises[0]!.id}/maxes`, json("POST", { date: "2026-11-07", valueLb: 300 }));
      id = (await res.clone().json()).id;
      return res;
    });
    await changes(() => req(`/api/maxes/${id}`, { method: "DELETE" }));
  });

  it("compresses JSON with Brotli when the client accepts it", async () => {
    const res = await req("/api/bootstrap", { headers: { "accept-encoding": "gzip, deflate, br" } });
    expect(res.headers.get("content-encoding")).toBe("br");
    expect(res.headers.get("vary")).toContain("Accept-Encoding");
    // `app.request` hands back the encoded bytes; decode them to be sure they're real Brotli.
    const { brotliDecompressSync } = await import("node:zlib");
    const body = JSON.parse(brotliDecompressSync(Buffer.from(await res.arrayBuffer())).toString()) as Bootstrap;
    expect(body.exercises.length).toBeGreaterThan(0);
    // Not when refused, and not for tiny bodies.
    expect((await req("/api/bootstrap", { headers: { "accept-encoding": "br;q=0, gzip" } })).headers.get("content-encoding")).toBe("gzip");
    expect((await req("/api/auth/me", { headers: { "accept-encoding": "br" } })).headers.get("content-encoding")).toBeNull();
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
      epochs: { current: async () => ({ epoch: 0, salt: "" }), bump: async () => ({ epoch: 1, salt: "" }) },
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
  const DAY = 86_400_000;

  it("re-issues the cookie when it gets old, but not on every request", async () => {
    const key = await dbKey();
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
    expect(out.headers.get("clear-site-data")).toBe('"cache"');
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
    const blocked = await attempt("nope");
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await attempt("hunter2")).status).toBe(429);
  });

  it("lets a known device sign in while others are slowed down by a distributed attack", async () => {
    const limited = createApp({
      db,
      password: "hunter2",
      sessionSecret: secret,
      secureCookies: false,
      trustProxy: true,
      loginLimits: { perClient: 3, global: 4, baseDelayMs: 20, maxDelayMs: 60 },
    });
    const attempt = (password: string, ip: string, cookie = "") =>
      limited.request("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": ip, cookie },
        body: JSON.stringify({ password }),
      });
    // The owner's phone signs in once and is remembered.
    const ok = await attempt("hunter2", "198.51.100.7");
    const device = ok.headers
      .getSetCookie()
      .find((c) => c.startsWith("sv_device="))!
      .split(";")[0]!;
    expect(ok.headers.getSetCookie().find((c) => c.startsWith("sv_device="))).toMatch(/HttpOnly/i);
    // Guessing from many networks…
    for (let i = 0; i < 6; i++) expect((await attempt("nope", `203.0.${i}.9`)).status).toBe(401);
    // …is now tarpitted (and refused when the queue is full) for unknown clients…
    const slowed = await Promise.all([attempt("nope", "192.0.2.1"), attempt("nope", "192.0.2.77"), attempt("nope", "192.0.3.1")]);
    expect(slowed.map((r) => r.status)).toContain(429);
    // …but the known device signs straight in, from anywhere.
    const started = Date.now();
    expect((await attempt("hunter2", "100.64.0.1", device)).status).toBe(200);
    expect(Date.now() - started).toBeLessThan(50);
    // A forged device cookie is just an unknown client.
    expect(
      (
        await attempt(
          "hunter2",
          "192.0.2.200",
          device.replace(/.$/, (c) => (c === "A" ? "B" : "A")),
        )
      ).status,
    ).not.toBe(500);
    // Addresses in one /24 share a budget.
    for (let i = 0; i < 3; i++) await attempt("nope", `198.18.0.${i + 1}`, device.replace("sv_device=", "x="));
    expect((await attempt("hunter2", "198.18.0.200")).status).toBe(429);
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
    expect(exported).toMatchObject({ format: "strawvine-export", version: 3 });
    expect(exported.seenAchievements.map((s: { key: string }) => s.key)).toEqual(["calib-1", "etag-test", "streak-3"]);
    expect(exported.exercises[0].createdAt).toMatch(/Z$/);
    expect(exported.exercises.find((e: { name: string }) => e.name === "Pull-up")).toMatchObject({ weighted: false });
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

  it("restores a v2 export (before the weighted flag) as weighted, and refuses newer versions", async () => {
    const current = await buildExport(db);
    expect(current.version).toBe(3);
    expect(current.exercises.some((e) => !e.weighted)).toBe(true);
    const v2 = { ...current, version: 2, exercises: current.exercises.map(({ weighted: _w, ...e }) => e) };
    await expect(restoreExport(db, { ...current, version: 4 }, { force: true })).rejects.toThrow(/Not a valid Strawvine export/);
    await restoreExport(db, v2, { force: true });
    const after = await buildExport(db);
    expect(after.exercises.map((e) => e.weighted)).toEqual(current.exercises.map(() => true));
    // Back to the flags as they were, for the test below.
    await restoreExport(db, current, { force: true });
    expect((await buildExport(db)).exercises).toEqual(current.exercises);
  });

  it("accepts a pre-versioning export and replaces data only with force", async () => {
    const current = await buildExport(db);
    const legacy = {
      exportedAt: current.exportedAt,
      settings: current.settings,
      days: current.days,
      // Exported before exercises had a `weighted` flag, too.
      exercises: current.exercises.map(({ createdAt: _c, weighted: _w, ...e }) => e),
      maxEntries: current.maxEntries,
      sessions: current.sessions,
    };
    expect(current.exercises.some((e) => !e.weighted)).toBe(true);
    const summary = await restoreExport(db, legacy, { force: true });
    expect(summary).toMatchObject({ seenAchievements: 0, exercises: current.exercises.length });
    const after = await buildExport(db);
    expect(after.seenAchievements).toEqual([]);
    // An export from before the flag restores every exercise as weighted (a load was shown on all of them).
    expect(after.exercises.map((e) => e.weighted)).toEqual(current.exercises.map(() => true));
  });

  it("bumps the session epoch and clears idempotency keys on every restore", async () => {
    const epoch = async () => (await db.execute<{ e: number }>(sql`select session_epoch as e from auth_state where id = 1`))[0]?.e ?? 0;
    await db.execute(
      sql`insert into idempotency_keys (key, method, path, status, body) values ('key-before-restore', 'POST', '/api/exercises', 201, '{}')`,
    );
    const before = await epoch();
    const oldKey = await dbKey();
    const summary = await restoreExport(db, await buildExport(db), { force: true });
    expect(summary.sessionEpoch).toBe(before + 1);
    expect(await epoch()).toBe(before + 1);
    expect(await db.execute(sql`select key from idempotency_keys`)).toHaveLength(0);
    // A cookie from before the restore no longer works; a new sign-in does.
    const fresh = createApp({ db, password: "hunter2", sessionSecret: secret, secureCookies: false });
    const stale = `sv_session=${makeToken(oldKey, before)}`;
    // Not even at the new epoch: the restore also changed the signing-key salt.
    const sameEpoch = `sv_session=${makeToken(oldKey, before + 1)}`;
    expect((await fresh.request("/api/auth/me", { headers: { cookie: sameEpoch } })).status).toBe(401);
    expect((await fresh.request("/api/auth/me", { headers: { cookie: stale } })).status).toBe(401);
    expect((await fresh.request("/api/auth/me", { headers: { cookie: await login(fresh) } })).status).toBe(200);
  });

  it("refuses to restore over exercises the athlete created, unless forced", async () => {
    const exported = await buildExport(db);
    await db.execute(sql`truncate day_logs, sessions, max_entries, seen_achievements, exercises, settings restart identity cascade`);
    await ensureSeeded(db, "2026-11-01");
    await db.execute(sql`insert into exercises (name, created_at) values ('My own lift', now() + interval '1 second')`);
    await expect(restoreExport(db, exported)).rejects.toThrow(/1 exercises of your own/);
    await db.execute(sql`delete from exercises where name = 'My own lift'`);
    await db.execute(sql`update exercises set archived = true where name = 'Pull-up'`);
    await expect(restoreExport(db, exported)).rejects.toThrow(RestoreError);
    await restoreExport(db, exported, { force: true });
  });

  it("prunes expired idempotency keys when preparing the database", async () => {
    await db.execute(
      sql`insert into idempotency_keys (key, method, path, status, body, created_at) values ('key-expired-boot', 'POST', '/api/exercises', 201, '{}', now() - interval '8 days')`,
    );
    const { sql: other } = createDb(url);
    await prepareDatabase(db, other);
    await other.end();
    expect(await db.execute(sql`select key from idempotency_keys where key = 'key-expired-boot'`)).toHaveLength(0);
  });

  it("gives up waiting for the migration lock after the timeout", async () => {
    const { sql: a } = createDb(url);
    const { sql: b } = createDb(url);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const first = withMigrationLock(a, () => held);
    await new Promise((r) => setTimeout(r, 50));
    await expect(withMigrationLock(b, async () => "ran", { timeoutMs: 300 })).rejects.toThrow(MigrationLockTimeout);
    release();
    await first;
    await expect(withMigrationLock(b, async () => "ran", { timeoutMs: 300 })).resolves.toBe("ran");
    await Promise.all([a.end(), b.end()]);
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

describe("restoring into a fresh database", () => {
  it("doesn't revive a revoked cookie whose epoch the fresh database reaches again", async () => {
    const exported = await buildExport(db);
    // A cookie minted at epoch 1 on the old database (say, before its owner signed out everywhere).
    const oldCookie = `sv_session=${makeToken(await dbKey(), 1)}`;

    await db.execute(sql`drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;`);
    const { sql: other } = createDb(url);
    await prepareDatabase(db, other);
    await other.end();
    const summary = await restoreExport(db, exported);
    expect(summary.sessionEpoch).toBe(1); // the same epoch number the old cookie carries…

    const restored = createApp({ db, password: "hunter2", sessionSecret: secret, secureCookies: false });
    expect((await restored.request("/api/auth/me", { headers: { cookie: oldCookie } })).status).toBe(401); // …but a new key
    expect((await restored.request("/api/auth/me", { headers: { cookie: await login(restored) } })).status).toBe(200);
  });
});
