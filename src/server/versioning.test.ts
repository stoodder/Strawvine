/**
 * Version-checked saves (revisions, If-Match → 409), the dataset version on writes (including
 * concurrent writers and writes from outside the app), Server-Timing, the CSP report-only trial,
 * cross-site reads and "forget this device".
 */
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Bootstrap, Session, Settings } from "../shared/schemas";
import { buildSession } from "../shared/session";
import {
  CSP_BLOCKED_MAX_CHARS,
  CSP_LOG_PER_REPORT,
  CSP_REPORT_BODY_LIMIT_BYTES,
  CSP_REPORTS_PER_CLIENT_PER_MIN,
  createApp,
  cspViolations,
  opaqueTag,
} from "./app";
import { createDb, createWebDb, runMigrations } from "./db/client";
import { ensureSeeded } from "./seed";
import { assertDisposableDatabase } from "./testDb";

const url = process.env.TEST_DATABASE_URL ?? "postgres://postgres@localhost:5432/strawvine_test";
assertDisposableDatabase(url);
const { db, sql: client } = createDb(url);
const logged: Array<{ message: string; details: Record<string, unknown> }> = [];
const appOptions = {
  password: "hunter2",
  sessionSecret: "y".repeat(40),
  secureCookies: false,
  trustProxy: true,
  buildId: "test-build",
  log: (message: string, details: Record<string, unknown>) => logged.push({ message, details }),
};
const app = createApp({ db, ...appOptions });
/** A second process (another dyno): its own pool and its own in-memory state. */
const other = createDb(url);
const app2 = createApp({ db: other.db, ...appOptions });
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
  await other.sql.end();
});

const tagNow = async () => (await req("/api/bootstrap")).headers.get("etag")!;
const counter = async () => Number((await client`select v from dataset_version where id = 1`)[0]!.v);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs `work` in a transaction on its own connection and keeps it open until `release()` is
 * called — a write from elsewhere (another dyno, an older release, psql) caught mid-flight.
 */
async function heldTransaction(work: (sql: typeof client) => Promise<unknown>) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let ready!: () => void;
  const started = new Promise<void>((r) => (ready = r));
  const done = client.begin(async (tx) => {
    await work(tx as unknown as typeof client);
    ready();
    await gate;
  });
  await Promise.race([started, done]);
  return { release, done };
}

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

  it("chains parallel writes exactly, in whichever order they commit", async () => {
    const start = await tagNow();
    const v0 = await counter();
    const [a, b] = await Promise.all([put("/api/days/2026-11-10", { steps: 1 }), put("/api/days/2026-11-11", { steps: 2 })]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const [first, second] = [a, b].sort((x) => (x.headers.get("x-dataset-etag-prev") === start ? -1 : 1));
    expect(first!.headers.get("x-dataset-etag-prev")).toBe(start);
    expect(second!.headers.get("x-dataset-etag-prev")).toBe(first!.headers.get("x-dataset-etag"));
    expect(second!.headers.get("x-dataset-etag")).toBe(await tagNow());
    expect(await counter()).toBe(v0 + 2);
  });

  it("chains across two processes", async () => {
    const start = await tagNow();
    const writes = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        (i % 2 ? app2 : app).request(`/api/days/2026-11-${12 + i}`, {
          method: "PUT",
          body: JSON.stringify({ steps: i }),
          headers: { "content-type": "application/json", cookie },
        }),
      ),
    );
    // The six (prev → next) pairs form one unbroken chain from `start` to the current tag.
    const next = new Map(writes.map((w) => [w.headers.get("x-dataset-etag-prev")!, w.headers.get("x-dataset-etag")!]));
    let tag = start;
    for (let i = 0; i < 6; i++) tag = next.get(tag)!;
    expect(tag).toBe(await tagNow());
  });

  it("never chains past a write it didn't make (one held open elsewhere)", async () => {
    const start = await tagNow();
    const v0 = await counter();
    // Another process's write: its transaction has bumped the version but not committed.
    const held = await heldTransaction((sql) => sql`update day_logs set steps = 777 where date = '2026-11-10'`);
    const pending = put("/api/days/2026-11-20", { steps: 3 });
    await sleep(150);
    held.release();
    await held.done;
    const res = await pending;
    expect(res.status).toBe(200);
    // Its "before" is the state after the other write, not the one this client last saw…
    expect(res.headers.get("x-dataset-etag-prev")).not.toBe(start);
    expect(res.headers.get("x-dataset-etag")).toBe(await tagNow());
    expect(await counter()).toBe(v0 + 2);
    // …so a client at `start` doesn't adopt the new tag and downloads the other write.
    const reval = await req("/api/bootstrap", { headers: { "If-None-Match": start } });
    expect(reval.status).toBe(200);
    expect(((await reval.json()) as Bootstrap).days.find((d) => d.date === "2026-11-10")!.steps).toBe(777);
  });

  it("is moved on by writes from outside the app, once per transaction", async () => {
    const start = await tagNow();
    const v0 = await counter();
    await client.begin(async (tx) => {
      await tx`insert into seen_achievements (key) values ('outside-1'), ('outside-2'), ('outside-3')`;
      await tx`update day_logs set journal = 'psql' where date = '2026-11-10'`;
    });
    expect(await counter()).toBe(v0 + 1);
    expect(await tagNow()).not.toBe(start);
    // A statement that changes nothing doesn't.
    await client`delete from sessions where date = '1999-01-01'`;
    expect(await counter()).toBe(v0 + 1);
  });

  it("answers writes that change nothing with the current version as both", async () => {
    const tag = await tagNow();
    const same = (res: Response) => {
      expect(res.ok).toBe(true);
      expect(res.headers.get("x-dataset-etag")).toBe(tag);
      expect(res.headers.get("x-dataset-etag-prev")).toBe(tag);
    };
    same(await req("/api/achievements/seen", { method: "POST", body: JSON.stringify({ keys: ["outside-1"] }) }));
    same(await req("/api/sessions/1999-01-01", { method: "DELETE" }));
    expect(await tagNow()).toBe(tag);

    // An idempotent replay writes nothing either.
    const create = () =>
      req("/api/exercises", {
        method: "POST",
        body: JSON.stringify({ name: "Replay row" }),
        headers: { "Idempotency-Key": "replay-key-1" },
      });
    const first = await create();
    expect(first.status).toBe(201);
    const after = first.headers.get("x-dataset-etag")!;
    expect(first.headers.get("x-dataset-etag-prev")).toBe(tag);
    const replay = await create();
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(replay.headers.get("x-dataset-etag")).toBe(after);
    expect(replay.headers.get("x-dataset-etag-prev")).toBe(after);
  });
});

describe("If-None-Match: * across processes", () => {
  it("is a 409 when another process's create commits first", async () => {
    const { data } = await boot();
    const theirs = { ...buildSession("2026-12-01", data), notes: "theirs" };
    const held = await heldTransaction(
      (sql) => sql`insert into sessions (date, data) values ('2026-12-01', ${JSON.stringify(theirs)}::jsonb)`,
    );
    const pending = put("/api/sessions/2026-12-01", { ...theirs, notes: "mine" }, { "If-None-Match": "*" });
    await sleep(150);
    held.release();
    await held.done;
    const res = await pending;
    expect(res.status).toBe(409);
    const body = (await res.json()) as { current: Session; rev: string };
    expect(body.current.notes).toBe("theirs");
    expect(body.rev).toBe((await boot()).data.revs!.sessions["2026-12-01"]);
  });

  it("lets exactly one of two racing creates through", async () => {
    const { data } = await boot();
    for (const date of ["2026-12-02", "2026-12-03", "2026-12-04", "2026-12-05"]) {
      const doc = (notes: string) => ({ ...buildSession(date, data), notes });
      const send = (a: typeof app, notes: string) =>
        a.request(`/api/sessions/${date}`, {
          method: "PUT",
          body: JSON.stringify(doc(notes)),
          headers: { "content-type": "application/json", cookie, "If-None-Match": "*" },
        });
      const results = await Promise.all([send(app, "one"), send(app2, "two")]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      const won = (await results.find((r) => r.status === 200)!.json()) as Session;
      const lost = (await results.find((r) => r.status === 409)!.json()) as { current: Session };
      expect(lost.current.notes).toBe(won.notes);
      expect((await boot()).data.sessions.find((s) => s.date === date)!.notes).toBe(won.notes);
    }
  });
});

describe("version-checked deletes", () => {
  it("refuses to delete a session changed since the revision it was based on", async () => {
    const { data } = await boot();
    const doc = buildSession("2026-12-10", data);
    const created = await put("/api/sessions/2026-12-10", doc);
    const rev = opaqueTag(created.headers.get("etag")!);
    const edited = await put("/api/sessions/2026-12-10", { ...doc, notes: "edited elsewhere" }, { "If-Match": `"${rev}"` });
    const current = opaqueTag(edited.headers.get("etag")!);

    const stale = await req("/api/sessions/2026-12-10", { method: "DELETE", headers: { "If-Match": `"${rev}"` } });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "conflict", current: { ...doc, notes: "edited elsewhere" }, rev: current });
    expect(stale.headers.get("x-dataset-etag")).toBeNull();
    expect((await boot()).data.revs!.sessions["2026-12-10"]).toBe(current);

    const ok = await req("/api/sessions/2026-12-10", { method: "DELETE", headers: { "If-Match": `"${current}"` } });
    expect(ok.status).toBe(200);
    expect((await boot()).data.revs!.sessions["2026-12-10"]).toBeUndefined();
    // Already gone: nothing to conflict with.
    expect((await req("/api/sessions/2026-12-10", { method: "DELETE", headers: { "If-Match": `"${current}"` } })).status).toBe(200);
  });
});

describe("statement timeout", () => {
  it("is set on the web pool only", async () => {
    const web = createWebDb(url);
    try {
      expect((await web.sql`show statement_timeout`)[0]!.statement_timeout).toBe("10s");
    } finally {
      await web.sql.end();
    }
    expect((await client`show statement_timeout`)[0]!.statement_timeout).toBe("0");
  });
});

describe("cross-site reads", () => {
  it("refuses API reads another site initiated (e.g. a link that downloads the export)", async () => {
    const get = (site?: string) => req("/api/export", { headers: site ? { "sec-fetch-site": site } : {} });
    expect((await get("cross-site")).status).toBe(403);
    expect((await get("same-site")).status).toBe(403);
    expect((await get("same-origin")).status).toBe(200);
    expect((await get("none")).status).toBe(200); // typed into the address bar, a bookmark
    expect((await get()).status).toBe(200); // older browsers send no fetch metadata
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

  it("caps what one report (and one minute) can log", async () => {
    logged.length = 0;
    const longHost = `${"a".repeat(60)}.${"b".repeat(60)}.example`;
    const many = Array.from({ length: 10 }, (_, i) => ({
      type: "csp-violation",
      body: { effectiveDirective: `img-src`, blockedURL: `https://${i}${longHost}/x.png` },
    }));
    expect((await report(many, "application/reports+json", "198.18.9.1")).status).toBe(204);
    expect(logged.length).toBe(CSP_LOG_PER_REPORT);
    for (const l of logged) expect(String(l.details.blocked).length).toBeLessThanOrEqual(CSP_BLOCKED_MAX_CHARS);
    // The same violation again within the minute isn't logged again.
    const before = logged.length;
    expect((await report(many.slice(0, 1), "application/reports+json", "198.18.9.2")).status).toBe(204);
    expect(logged.length).toBe(before);
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

  it("revokes this browser's session server-side, in every process", async () => {
    const login = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "hunter2" }),
    });
    const session = login.headers
      .getSetCookie()
      .find((c) => c.startsWith("sv_session="))!
      .split(";")[0]!;
    expect((await app.request("/api/auth/me", { headers: { cookie: session } })).status).toBe(200);
    // A process that hasn't seen this token yet (empty cache) learns of the revocation from the database.
    const fresh = createApp({ db: other.db, ...appOptions });
    expect((await fresh.request("/api/auth/me", { headers: { cookie: session } })).status).toBe(200);
    const res = await app.request("/api/auth/forget-device", {
      method: "POST",
      headers: { cookie: session, "content-type": "application/json" },
    });
    expect(res.status).toBe(200);
    // A copy of the cookie (or a browser that never applied the response) is signed out.
    expect((await app.request("/api/auth/me", { headers: { cookie: session } })).status).toBe(401);
    expect((await createApp({ db: other.db, ...appOptions }).request("/api/auth/me", { headers: { cookie: session } })).status).toBe(401);
    // Only that token: this test file's own session still works.
    expect((await app.request("/api/auth/me", { headers: { cookie } })).status).toBe(200);
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
