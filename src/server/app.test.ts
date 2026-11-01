import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Bootstrap } from "../shared/schemas";
import { buildSession } from "../shared/session";
import { createApp } from "./app";
import { createDb, runMigrations } from "./db/client";
import { ensureSeeded } from "./seed";

const url = process.env.TEST_DATABASE_URL ?? "postgres://postgres@localhost:5432/strawvine_test";
const { db, sql: client } = createDb(url);
const app = createApp({ db, password: "hunter2", sessionSecret: "x".repeat(40), secureCookies: false });
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
