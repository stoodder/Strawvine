/**
 * Version-checked saves (revisions, If-Match → 409), the dataset version on writes, Server-Timing,
 * the CSP report-only trial and "forget this device".
 */
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Bootstrap, Session, Settings } from "../shared/schemas";
import { buildSession } from "../shared/session";
import { CSP_REPORT_BODY_LIMIT_BYTES, CSP_REPORTS_PER_CLIENT_PER_MIN, createApp, cspViolations, opaqueTag, writeLock } from "./app";
import { createDb, runMigrations } from "./db/client";
import { ensureSeeded } from "./seed";
import { assertDisposableDatabase } from "./testDb";

const url = process.env.TEST_DATABASE_URL ?? "postgres://postgres@localhost:5432/strawvine_test";
assertDisposableDatabase(url);
const { db, sql: client } = createDb(url);
const logged: Array<{ message: string; details: Record<string, unknown> }> = [];
const app = createApp({
  db,
  password: "hunter2",
  sessionSecret: "y".repeat(40),
  secureCookies: false,
  trustProxy: true,
  buildId: "test-build",
  log: (message, details) => logged.push({ message, details }),
});
let cookie = "";

const req = (path: string, init: RequestInit = {}) =>
  app.request(path, {
    ...init,
    headers: { "content-type": "application/json", cookie, ...(init.headers as Record<string, string>) },
  });
const put = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  req(path, { method: "PUT", body: JSON.stringify(body), headers });
const boot = async () => {
  const res = await req("/api/bootstrap");
  return { res, data: (await res.json()) as Bootstrap };
};

beforeAll(async () => {
  await db.execute(sql`drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;`);
  await runMigrations(db);
  await ensureSeeded(db, "2026-11-01");
  const res = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "hunter2" }),
  });
  cookie = res.headers.get("set-cookie")!.split(";")[0]!;
});

afterAll(async () => {
  await client.end();
});

describe("version-checked saves", () => {
  let session: Session;

  it("bootstrap carries the settings' and every session's revision", async () => {
    const { data } = await boot();
    session = buildSession("2026-11-02", data);
    expect((await put("/api/sessions/2026-11-02", session)).status).toBe(200);
    const after = (await boot()).data;
    expect(after.revs).toEqual({ settings: expect.any(String), sessions: { "2026-11-02": expect.any(String) } });
  });

  it("a save based on the current revision is accepted and answers with the new one", async () => {
    const { data } = await boot();
    const rev = data.revs!.sessions["2026-11-02"]!;
    const res = await put("/api/sessions/2026-11-02", { ...session, notes: "A" }, { "If-Match": `"${rev}"` });
    expect(res.status).toBe(200);
    const next = opaqueTag(res.headers.get("etag")!);
    expect(next).not.toBe(rev);
    expect((await boot()).data.revs!.sessions["2026-11-02"]).toBe(next);
    // A bare (unquoted) revision works too.
    expect((await put("/api/sessions/2026-11-02", { ...session, notes: "B" }, { "If-Match": next })).status).toBe(200);
  });

  it("a stale revision is a 409 with the server's current document and revision", async () => {
    const { data } = await boot();
    const current = data.revs!.sessions["2026-11-02"]!;
    const res = await put("/api/sessions/2026-11-02", { ...session, notes: "stale" }, { "If-Match": '"1"' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "conflict", current: { ...session, notes: "B" }, rev: current });
    // Nothing was written.
    expect((await boot()).data.sessions.find((s) => s.date === "2026-11-02")!.notes).toBe("B");
  });

  it("If-None-Match: * refuses to overwrite a session the client didn't know about", async () => {
    const res = await put("/api/sessions/2026-11-02", { ...session, notes: "built here too" }, { "If-None-Match": "*" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { current: Session }).current.notes).toBe("B");
    // …but creates one that doesn't exist yet.
    const fresh = { ...session, date: "2026-11-03" };
    expect((await put("/api/sessions/2026-11-03", fresh, { "If-None-Match": "*" })).status).toBe(200);
  });

  it("accepts saves without a precondition (older clients) and over a deleted session", async () => {
    expect((await put("/api/sessions/2026-11-02", { ...session, notes: "old client" })).status).toBe(200);
    const rev = (await boot()).data.revs!.sessions["2026-11-03"]!;
    expect((await req("/api/sessions/2026-11-03", { method: "DELETE" })).status).toBe(200);
    expect((await boot()).data.revs!.sessions["2026-11-03"]).toBeUndefined();
    const res = await put("/api/sessions/2026-11-03", { ...session, date: "2026-11-03" }, { "If-Match": `"${rev}"` });
    expect(res.status).toBe(200);
  });

  it("checks settings the same way", async () => {
    const { data } = await boot();
    const rev = data.revs!.settings;
    const mine: Settings = { ...data.settings, onboarded: true };
    const ok = await put("/api/settings", mine, { "If-Match": `"${rev}"` });
    expect(ok.status).toBe(200);
    const next = opaqueTag(ok.headers.get("etag")!);
    expect(next).not.toBe(rev);
    const stale = await put("/api/settings", { ...mine, targets: { ...mine.targets, steps: 1 } }, { "If-Match": `"${rev}"` });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "conflict", current: mine, rev: next });
    expect((await put("/api/settings", mine)).status).toBe(200);
    // Invalid bodies are still a 400 before any check.
    expect((await put("/api/settings", { nope: 1 }, { "If-Match": '"1"' })).status).toBe(400);
  });
});

describe("dataset version on writes", () => {
  it("every successful write carries the ETag bootstrap now has, and the one before it", async () => {
    const before = (await req("/api/bootstrap")).headers.get("etag")!;
    const res = await put("/api/days/2026-11-04", { steps: 1234 });
    expect(res.status).toBe(200);
    const tag = res.headers.get("x-dataset-etag")!;
    expect(tag).toMatch(/^W\/".+"$/);
    expect(res.headers.get("x-dataset-etag-prev")).toBe(before);
    expect(tag).not.toBe(before);
    // The next revalidation with it is a bodiless 304.
    const again = await req("/api/bootstrap", { headers: { "If-None-Match": tag } });
    expect(again.status).toBe(304);
    expect(again.headers.get("etag")).toBe(tag);
  });

  it("chains across consecutive writes of every kind", async () => {
    let tag = (await req("/api/bootstrap")).headers.get("etag")!;
    const writes: Array<() => Response | Promise<Response>> = [
      () => put("/api/days/2026-11-05", { calories: 2500 }),
      () => req("/api/exercises", { method: "POST", body: JSON.stringify({ name: "Row" }) }),
      () => req("/api/achievements/seen", { method: "POST", body: JSON.stringify({ keys: ["calib-1"] }) }),
      () => req("/api/sessions/2026-11-05", { method: "DELETE" }),
    ];
    for (const w of writes) {
      const res = await w();
      expect(res.ok).toBe(true);
      expect(res.headers.get("x-dataset-etag-prev")).toBe(tag);
      tag = res.headers.get("x-dataset-etag")!;
    }
    expect((await req("/api/bootstrap", { headers: { "If-None-Match": tag } })).status).toBe(304);
  });

  it("isn't sent on failed writes or reads", async () => {
    const bad = await put("/api/days/2026-11-05", { steps: -1 });
    expect(bad.status).toBe(400);
    expect(bad.headers.get("x-dataset-etag")).toBeNull();
    expect((await req("/api/auth/me")).headers.get("x-dataset-etag")).toBeNull();
  });

  it("serialises writes, and lets one through unchained when the one before is stuck", async () => {
    const lock = writeLock(50);
    const order: string[] = [];
    const a = await lock.acquire();
    const b = lock.acquire().then((r) => (order.push("b"), r));
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual([]);
    a!();
    const rb = await b;
    expect(rb).toBeTypeOf("function");
    // b holds it now and never lets go: c gives up after 50 ms and goes ahead unserialised.
    const t = Date.now();
    expect(await lock.acquire()).toBeNull();
    expect(Date.now() - t).toBeGreaterThanOrEqual(45);
    rb!();
    expect(await lock.acquire()).toBeTypeOf("function");
  });
});

describe("Server-Timing", () => {
  it("breaks /bootstrap down into db, build and compress", async () => {
    const res = await req("/api/bootstrap", { headers: { "Accept-Encoding": "br" } });
    expect(res.headers.get("server-timing")).toMatch(/^db;dur=[\d.]+, build;dur=[\d.]+, compress;dur=[\d.]+$/);
    const tag = res.headers.get("etag")!;
    const unchanged = await req("/api/bootstrap", { headers: { "If-None-Match": tag } });
    expect(unchanged.headers.get("server-timing")).toMatch(/^db;dur=[\d.]+$/);
  });

  it("times writes (db, and reading the dataset version)", async () => {
    const res = await put("/api/days/2026-11-06", { steps: 1 });
    expect(res.headers.get("server-timing")).toMatch(/^db;dur=[\d.]+, etag;dur=[\d.]+$/);
  });
});

describe("CSP report-only trial", () => {
  it("reports the policy without inline styles, and enforces the current one unchanged", async () => {
    const res = await app.request("/api/health");
    const enforced = res.headers.get("content-security-policy")!;
    const trial = res.headers.get("content-security-policy-report-only")!;
    expect(enforced).toContain("style-src 'self' 'unsafe-inline'");
    expect(enforced).not.toContain("report");
    expect(trial).toContain("style-src 'self';");
    expect(trial).not.toContain("unsafe-inline");
    expect(trial).toContain("report-uri /api/csp-report");
    // Identical otherwise.
    const strip = (p: string) =>
      p
        .split(";")
        .map((d) => d.trim())
        .filter((d) => d && !d.startsWith("style-src") && !d.startsWith("report-"))
        .sort();
    expect(strip(trial)).toEqual(strip(enforced));
  });

  const report = (body: unknown, type = "application/csp-report", ip = "203.0.113.9") =>
    app.request("/api/csp-report", {
      method: "POST",
      headers: { "content-type": type, "x-forwarded-for": ip, "sec-fetch-site": "same-origin" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  it("logs only the directive and the blocked host — no auth needed", async () => {
    logged.length = 0;
    const res = await report({
      "csp-report": {
        "document-uri": "https://strawvine.example/today?journal=secret",
        "violated-directive": "style-src-attr",
        "effective-directive": "style-src-attr",
        "blocked-uri": "inline",
        "source-file": "https://strawvine.example/assets/index.js",
        "script-sample": "secret journal text",
      },
    });
    expect(res.status).toBe(204);
    const res2 = await report(
      [
        {
          type: "csp-violation",
          body: { effectiveDirective: "style-src-elem", blockedURL: "https://evil.example/x.css?q=1", documentURL: "https://s/x" },
        },
        { type: "deprecation", body: { id: "x" } },
      ],
      "application/reports+json",
    );
    expect(res2.status).toBe(204);
    expect(logged).toEqual([
      { message: "CSP violation (report-only)", details: { directive: "style-src-attr", blocked: "inline" } },
      { message: "CSP violation (report-only)", details: { directive: "style-src-elem", blocked: "evil.example" } },
    ]);
    expect(JSON.stringify(logged)).not.toMatch(/secret|journal|index\.js|q=1/);
  });

  it("limits the body to 8 KB and the rate per client, and ignores garbage", async () => {
    const big = JSON.stringify({ "csp-report": { "violated-directive": "img-src", pad: "x".repeat(CSP_REPORT_BODY_LIMIT_BYTES) } });
    expect((await report(big, "application/csp-report", "198.51.100.1")).status).toBe(413);
    expect((await report("not json", "application/csp-report", "198.51.100.2")).status).toBe(400);
    let last = 0;
    for (let i = 0; i <= CSP_REPORTS_PER_CLIENT_PER_MIN; i++) last = (await report({ "csp-report": {} }, undefined, "192.0.2.77")).status;
    expect(last).toBe(429);
    // Another client (network) still gets through.
    expect((await report({ "csp-report": {} }, undefined, "198.18.7.1")).status).toBe(204);
  });

  it("reduces reports to directive + host", () => {
    expect(cspViolations({ "csp-report": { "violated-directive": "img-src https:", "blocked-uri": "data" } })).toEqual([
      { directive: "img-src", blocked: "data" },
    ]);
    expect(
      cspViolations({ "csp-report": { "effective-directive": "font-src", "blocked-uri": "https://fonts.example:8443/a.woff" } }),
    ).toEqual([{ directive: "font-src", blocked: "fonts.example:8443" }]);
    expect(cspViolations(null)).toEqual([]);
    expect(cspViolations([{ type: "csp-violation" }])).toEqual([]);
  });
});

describe("forget this device", () => {
  it("needs a session", async () => {
    expect((await app.request("/api/auth/forget-device", { method: "POST" })).status).toBe(401);
  });

  it("clears the known-device mark and this browser's session", async () => {
    const login = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "hunter2" }),
    });
    const cookies = login.headers.getSetCookie();
    const session = cookies.find((c) => c.startsWith("sv_session="))!.split(";")[0]!;
    const device = cookies.find((c) => c.startsWith("sv_device="))!.split(";")[0]!;
    const res = await app.request("/api/auth/forget-device", {
      method: "POST",
      headers: { cookie: `${session}; ${device}`, "content-type": "application/json" },
    });
    expect(res.status).toBe(200);
    const cleared = res.headers.getSetCookie();
    expect(cleared.find((c) => c.startsWith("sv_device="))).toMatch(/Max-Age=0/i);
    expect(cleared.find((c) => c.startsWith("sv_session="))).toMatch(/Max-Age=0/i);
    // Other devices stay signed in (no epoch bump): the cookie still works where it's kept.
    expect((await app.request("/api/auth/me", { headers: { cookie } })).status).toBe(200);
  });
});
