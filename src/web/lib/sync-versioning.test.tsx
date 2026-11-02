/**
 * The sync engine's round-3 behaviour against a mocked server (jsdom + fake IndexedDB):
 * version-checked saves with merge-and-retry on 409, the dataset version carried by write
 * responses (→ 304 on the next revalidation), refused edits, "forget this device" and marking
 * a saved max seen in the same update as its ack.
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSettings } from "../../shared/defaults";
import type { Bootstrap, MaxEntry, Session, Settings } from "../../shared/schemas";
import { blankSet } from "../../shared/session";

const toasts = vi.hoisted(() => [] as Array<{ message: string }>);
vi.mock("../components/Toast", () => ({ showToast: vi.fn((t: { message: string }) => (toasts.push(t), 0)) }));

type Sync = typeof import("./sync");
type Reply = { status: number; body?: unknown; headers?: Record<string, string> };
type Call = { method: string; path: string; headers: Record<string, string>; body?: unknown };

let calls: Call[] = [];
let replies: Array<Reply | ((call: Call) => Reply)> = [];
let offline = false;
const loaded: Sync[] = [];

async function load(): Promise<Sync> {
  vi.resetModules();
  const m = await import("./sync");
  loaded.push(m);
  return m;
}

const settings: Settings = {
  ...defaultSettings({ bench: 1, deadlift: 2, backSquat: 3, frontSquat: 4, strictPress: 5 }, "2026-11-01"),
  onboarded: true,
};
const set = (id: string, done = false) => blankSet({ id, targetReps: 5, targetWeight: 100, done, reps: done ? 5 : null });
const session = (sets: ReturnType<typeof set>[], notes = ""): Session => ({
  date: "2026-11-02",
  label: "Push",
  cycle: 1,
  week: 1,
  deload: false,
  primaryMaxLb: 315,
  blocks: [{ id: "p", kind: "primary", exercises: [{ exerciseId: 1, measure: "reps", sets }] }],
  notes,
  completedAt: null,
  planSig: null,
});
const data = (over: Partial<Bootstrap> = {}): Bootstrap => ({
  settings,
  days: [],
  exercises: [{ id: 1, name: "Bench press", category: "primary", tracksMax: true, measure: "reps", archived: false }],
  maxEntries: [],
  sessions: [session([set("a"), set("b")])],
  seenAchievements: [],
  revs: { settings: "s1", sessions: { "2026-11-02": "r1" } },
  ...over,
});

beforeEach(() => {
  localStorage.clear();
  globalThis.indexedDB = new IDBFactory();
  calls = [];
  replies = [];
  toasts.length = 0;
  offline = false;
  Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      if (offline) throw new TypeError("Failed to fetch");
      const call: Call = {
        method: init.method ?? "GET",
        path: url.replace(/^\/api/, ""),
        headers: { ...(init.headers as Record<string, string>) },
        body: init.body ? JSON.parse(init.body as string) : undefined,
      };
      calls.push(call);
      const next = replies.shift() ?? { status: 200, body: { ok: true } };
      const r = typeof next === "function" ? next(call) : next;
      return new Response(r.status === 304 || r.body === undefined ? null : JSON.stringify(r.body), {
        status: r.status,
        headers: r.headers,
      });
    }),
  );
});

afterEach(() => {
  for (const m of loaded.splice(0)) m.stopSync();
  vi.unstubAllGlobals();
});

const signal = new AbortController().signal;

async function signedIn(d: Bootstrap = data(), etag = 'W/"e0"') {
  localStorage.setItem("strawvine:signed-in", "1");
  const sync = await load();
  await sync.initSync();
  replies = [{ status: 200, body: d, headers: { etag } }];
  await sync.fetchBootstrap({ signal });
  return sync;
}

const writes = () => calls.filter((c) => c.method !== "GET");

describe("version-checked saves", () => {
  it("sends the revision an edit was based on, and the new one for the next edit", async () => {
    const sync = await signedIn();
    replies = [
      (c) => ({ status: 200, body: c.body, headers: { etag: '"r2"' } }),
      (c) => ({ status: 200, body: c.body, headers: { etag: '"r3"' } }),
    ];
    sync.enqueue({ kind: "session", date: "2026-11-02", doc: session([set("a", true), set("b")]) });
    await vi.waitFor(() => expect(sync.getSyncInfo().unsynced).toBe(0));
    sync.enqueue({ kind: "session", date: "2026-11-02", doc: session([set("a", true), set("b", true)]) });
    await vi.waitFor(() => expect(sync.getSyncInfo().unsynced).toBe(0));
    expect(writes().map((c) => c.headers["If-Match"])).toEqual(['"r1"', '"r2"']);
    expect(toasts).toEqual([]);
  });

  it("an edit queued while the previous save is in flight isn't a conflict with it", async () => {
    const sync = await signedIn();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    vi.mocked(fetch).mockImplementationOnce(async (_u, init) => {
      calls.push({ method: "PUT", path: "/sessions/2026-11-02", headers: { ...(init!.headers as Record<string, string>) } });
      await gate;
      return new Response(init!.body as string, { status: 200, headers: { etag: '"r2"' } });
    });
    sync.enqueue({ kind: "session", date: "2026-11-02", doc: session([set("a", true), set("b")]) });
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    sync.enqueue({ kind: "session", date: "2026-11-02", doc: session([set("a", true), set("b", true)]) });
    replies = [(c) => ({ status: 200, body: c.body, headers: { etag: '"r3"' } })];
    release();
    await vi.waitFor(() => expect(sync.getSyncInfo().unsynced).toBe(0));
    expect(writes().map((c) => c.headers["If-Match"])).toEqual(['"r1"', '"r2"']);
  });

  it("asks for a new session not to overwrite one the server has (If-None-Match: *)", async () => {
    const sync = await signedIn();
    replies = [(c) => ({ status: 200, body: c.body, headers: { etag: '"n1"' } })];
    sync.enqueue({ kind: "session", date: "2026-11-03", doc: { ...session([set("x")]), date: "2026-11-03" } });
    await vi.waitFor(() => expect(sync.getSyncInfo().unsynced).toBe(0));
    expect(writes()[0]!.headers).toMatchObject({ "If-None-Match": "*" });
    expect(writes()[0]!.headers["If-Match"]).toBeUndefined();
  });

  it("on 409, merges the edit onto the server's copy, sends it once more and says so", async () => {
    const sync = await signedIn();
    // Another device logged set b; this one logs set a.
    const theirs = session([set("a"), set("b", true)], "from the phone");
    replies = [
      { status: 409, body: { error: "conflict", current: theirs, rev: "r7" } },
      (c) => ({ status: 200, body: c.body, headers: { etag: '"r8"' } }),
    ];
    sync.enqueue({ kind: "session", date: "2026-11-02", doc: session([set("a", true), set("b")]) });
    await vi.waitFor(() => expect(sync.getSyncInfo().unsynced).toBe(0));
    const [first, retry] = writes();
    expect(first!.headers["If-Match"]).toBe('"r1"');
    expect(retry!.headers["If-Match"]).toBe('"r7"');
    const sent = retry!.body as Session;
    expect(sent.blocks[0]!.exercises[0]!.sets.map((x) => x.done)).toEqual([true, true]);
    expect(sent.notes).toBe("from the phone");
    expect(sync.currentData()!.sessions[0]).toEqual(sent);
    expect(toasts.map((t) => t.message)).toEqual(["Merged changes from another device"]);

    // The next edit is based on the merged revision.
    replies = [(c) => ({ status: 200, body: c.body, headers: { etag: '"r9"' } })];
    sync.enqueue({ kind: "session", date: "2026-11-02", doc: { ...sent, notes: "both" } });
    await vi.waitFor(() => expect(sync.getSyncInfo().unsynced).toBe(0));
    expect(writes().at(-1)!.headers["If-Match"]).toBe('"r8"');
  });

  it("retries only once: a second conflict is reported, and Retry merges again", async () => {
    const sync = await signedIn();
    const theirs = session([set("a"), set("b", true)]);
    replies = [
      { status: 409, body: { error: "conflict", current: theirs, rev: "r7" } },
      { status: 409, body: { error: "conflict", current: theirs, rev: "r8" } },
    ];
    sync.enqueue({ kind: "session", date: "2026-11-02", doc: session([set("a", true), set("b")]) });
    await vi.waitFor(() => expect(sync.getSyncInfo().failed).toBe(1));
    expect(writes()).toHaveLength(2);
    expect(toasts.at(-1)!.message).toMatch(/^Couldn't save your workout/);
    replies = [
      { status: 409, body: { error: "conflict", current: theirs, rev: "r9" } },
      (c) => ({ status: 200, body: c.body, headers: { etag: '"r10"' } }),
    ];
    sync.retryFailed();
    await vi.waitFor(() => expect(sync.getSyncInfo().unsynced).toBe(0));
    expect(writes().at(-1)!.headers["If-Match"]).toBe('"r9"');
  });

  it("merges settings field by field: only the keys this device changed", async () => {
    const sync = await signedIn();
    const theirs = { ...settings, targets: { ...settings.targets, zone2Minutes: 45 } };
    replies = [
      { status: 409, body: { error: "conflict", current: theirs, rev: "s2" } },
      (c) => ({ status: 200, body: c.body, headers: { etag: '"s3"' } }),
    ];
    sync.enqueue({ kind: "settings", settings: { ...settings, targets: { ...settings.targets, steps: 9000 } } });
    await vi.waitFor(() => expect(sync.getSyncInfo().unsynced).toBe(0));
    expect(writes()[0]!.headers["If-Match"]).toBe('"s1"');
    expect(writes()[1]!.headers["If-Match"]).toBe('"s2"');
    expect((writes()[1]!.body as Settings).targets).toEqual({ steps: 9000, zone2Minutes: 45 });
    expect(toasts.map((t) => t.message)).toEqual(["Merged changes from another device"]);
  });

  it("keeps revisions with the device copy, and sends nothing from a copy that has none", async () => {
    const sync = await signedIn();
    await sync.persistNow();
    const again = await load();
    await again.initSync();
    replies = [(c) => ({ status: 200, body: c.body })];
    again.enqueue({ kind: "settings", settings: { ...settings, onboarded: false } });
    await vi.waitFor(() => expect(again.getSyncInfo().unsynced).toBe(0));
    expect(writes()[0]!.headers["If-Match"]).toBe('"s1"');

    const legacy = await signedIn(data({ revs: undefined }));
    calls = [];
    replies = [(c) => ({ status: 200, body: c.body })];
    legacy.enqueue({ kind: "settings", settings: { ...settings, onboarded: false } });
    await vi.waitFor(() => expect(legacy.getSyncInfo().unsynced).toBe(0));
    expect(writes()[0]!.headers["If-Match"]).toBeUndefined();
  });
});

describe("dataset version on writes", () => {
  it("a write that started from this copy's version makes the next revalidation a 304", async () => {
    const sync = await signedIn(data(), 'W/"e0"');
    replies = [
      {
        status: 200,
        body: { date: "2026-11-04", steps: 10 },
        headers: { "x-dataset-etag": 'W/"e1"', "x-dataset-etag-prev": 'W/"e0"' },
      },
    ];
    sync.enqueue({ kind: "day", date: "2026-11-04", patch: { steps: 10 } });
    await vi.waitFor(() => expect(sync.getSyncInfo().unsynced).toBe(0));
    replies = [{ status: 304, headers: { etag: 'W/"e1"' } }];
    const before = sync.currentData();
    await sync.fetchBootstrap({ signal });
    expect(calls.at(-1)!.headers["If-None-Match"]).toBe('W/"e1"');
    expect(sync.currentData()).toBe(before);

    // Stored with the device copy: a reload revalidates with it too.
    await sync.persistNow();
    const again = await load();
    await again.initSync();
    replies = [{ status: 304 }];
    await again.fetchBootstrap({ signal });
    expect(calls.at(-1)!.headers["If-None-Match"]).toBe('W/"e1"');
  });

  it("a write that didn't start from this copy's version (another device wrote) forces a download", async () => {
    const sync = await signedIn(data(), 'W/"e0"');
    replies = [
      {
        status: 200,
        body: { date: "2026-11-04", steps: 10 },
        headers: { "x-dataset-etag": 'W/"e5"', "x-dataset-etag-prev": 'W/"e4"' },
      },
    ];
    sync.enqueue({ kind: "day", date: "2026-11-04", patch: { steps: 10 } });
    await vi.waitFor(() => expect(sync.getSyncInfo().unsynced).toBe(0));
    replies = [{ status: 200, body: data(), headers: { etag: 'W/"e5"' } }];
    await sync.fetchBootstrap({ signal });
    expect(calls.at(-1)!.headers["If-None-Match"]).toBeUndefined();
  });

  it("chains across several writes, and a write without the header breaks the chain", async () => {
    const sync = await signedIn(data(), 'W/"e0"');
    const day = (n: number, prev: string | null, next: string | null): Reply => ({
      status: 200,
      body: { date: `2026-11-0${n}`, steps: n },
      headers: { ...(next ? { "x-dataset-etag": next } : {}), ...(prev ? { "x-dataset-etag-prev": prev } : {}) },
    });
    replies = [day(4, 'W/"e0"', 'W/"e1"'), day(5, 'W/"e1"', 'W/"e2"')];
    sync.enqueue({ kind: "day", date: "2026-11-04", patch: { steps: 4 } });
    sync.enqueue({ kind: "day", date: "2026-11-05", patch: { steps: 5 } });
    await vi.waitFor(() => expect(sync.getSyncInfo().unsynced).toBe(0));
    replies = [{ status: 304 }];
    await sync.fetchBootstrap({ signal });
    expect(calls.at(-1)!.headers["If-None-Match"]).toBe('W/"e2"');

    replies = [day(6, null, null)];
    sync.enqueue({ kind: "day", date: "2026-11-06", patch: { steps: 6 } });
    await vi.waitFor(() => expect(sync.getSyncInfo().unsynced).toBe(0));
    replies = [{ status: 200, body: data(), headers: { etag: 'W/"e9"' } }];
    await sync.fetchBootstrap({ signal });
    expect(calls.at(-1)!.headers["If-None-Match"]).toBeUndefined();
  });
});

describe("refused edits", () => {
  const tooMany = () => session(Array.from({ length: 31 }, (_, i) => set(`s${i}`)));

  it("lists edits refused at queue time (the last 20), survives a reload, and clears", async () => {
    const sync = await signedIn();
    sync.enqueue({ kind: "session", date: "2026-11-02", doc: tooMany() });
    expect(writes()).toEqual([]);
    expect(sync.getSyncInfo().refused).toEqual([
      {
        id: expect.any(String),
        label: expect.stringMatching(/^Workout · /),
        reason: "An exercise can have at most 30 sets.",
        at: expect.any(Number),
      },
    ]);
    for (let i = 0; i < 25; i++)
      sync.enqueue({
        kind: "addMax",
        tempId: -1 - i,
        exerciseId: 1,
        date: "2026-11-02",
        valueLb: 5000,
        source: "manual",
        note: null,
        createdAt: "",
      });
    const refused = sync.getSyncInfo().refused;
    expect(refused).toHaveLength(sync.REFUSED_KEEP);
    expect(refused.at(-1)!.label).toBe("New max · 5000 lb");
    expect(new Set(refused.map((r) => r.id)).size).toBe(20);

    const again = await load();
    await again.initSync();
    expect(again.getSyncInfo().refused).toHaveLength(20);
    again.clearRefused();
    expect(again.getSyncInfo().refused).toEqual([]);
    expect(localStorage.getItem("strawvine:refused")).toBeNull();
  });
});

describe("forget this device", () => {
  it("sends what's queued, asks the server, then wipes everything here and signs out", async () => {
    const sync = await signedIn();
    await sync.persistNow();
    const out = vi.fn();
    window.addEventListener(sync.SIGNED_OUT_EVENT, out);
    replies = [
      { status: 200, body: { date: "2026-11-04", steps: 1 } },
      { status: 200, body: { ok: true } },
    ];
    sync.enqueue({ kind: "day", date: "2026-11-04", patch: { steps: 1 } });
    await sync.forgetDevice();
    expect(writes().map((c) => c.method + " " + c.path)).toEqual(["PUT /days/2026-11-04", "POST /auth/forget-device"]);
    expect(sync.currentData()).toBeUndefined();
    expect(sync.isSignedIn()).toBe(false);
    expect(out).toHaveBeenCalled();
    window.removeEventListener(sync.SIGNED_OUT_EVENT, out);
    // Nothing left on disk for a reload to show.
    localStorage.setItem("strawvine:signed-in", "1"); // even if the flag came back somehow
    const again = await load();
    offline = true;
    await again.initSync();
    expect(again.currentData()).toBeUndefined();
  });

  it("changes nothing when the server can't be reached", async () => {
    const sync = await signedIn();
    offline = true;
    await expect(sync.forgetDevice()).rejects.toBeTruthy();
    expect(sync.currentData()).toBeDefined();
    expect(sync.isSignedIn()).toBe(true);
  });
});

describe("markSeenOnAck", () => {
  const saved: MaxEntry = {
    id: 77,
    exerciseId: 1,
    date: "2026-11-02",
    valueLb: 318,
    source: "amrap",
    note: null,
    createdAt: "2026-11-02T18:00:00Z",
  };

  it("applies the server's row and marks it seen in the same update, then tells the server", async () => {
    const sync = await signedIn();
    const states: Bootstrap[] = [];
    const unsubscribe = sync.queryClient.getQueryCache().subscribe((ev) => {
      if (ev.type === "updated" && ev.action.type === "success") states.push(ev.query.state.data as Bootstrap);
    });
    replies = [{ status: 201, body: saved }];
    const seq = sync.enqueue({
      kind: "addMax",
      tempId: sync.takeTempId(),
      exerciseId: 1,
      date: "2026-11-02",
      valueLb: 318,
      source: "amrap",
      note: null,
      createdAt: saved.createdAt,
      markSeenOnAck: true,
    });
    expect(await sync.waitForAck(seq, 2000)).toEqual(saved);
    // Every published state that has the saved row also has it seen.
    const withRow = states.filter((s) => s.maxEntries.some((e) => e.id === 77));
    expect(withRow.length).toBeGreaterThan(0);
    for (const s of withRow) expect(s.seenAchievements).toContain("max-77");
    // …and the temporary row never leaked into the entry as a field.
    expect(sync.currentData()!.maxEntries).toEqual([saved]);
    await vi.waitFor(() => expect(writes().map((c) => c.path)).toContain("/achievements/seen"));
    expect(writes().find((c) => c.path === "/achievements/seen")!.body).toEqual({ keys: ["max-77"] });
    unsubscribe();
  });

  it("works when the ack only arrives after coming back online", async () => {
    const sync = await signedIn();
    offline = true;
    sync.enqueue({
      kind: "addMax",
      tempId: sync.takeTempId(),
      exerciseId: 1,
      date: "2026-11-02",
      valueLb: 318,
      source: "amrap",
      note: null,
      createdAt: saved.createdAt,
      markSeenOnAck: true,
    });
    await new Promise((r) => setTimeout(r, 20));
    offline = false;
    const reply = (c: Call): Reply =>
      c.path === "/bootstrap"
        ? { status: 304, headers: { etag: 'W/"e0"' } }
        : c.path.endsWith("/maxes")
          ? { status: 201, body: saved }
          : { status: 200, body: { ok: true } };
    replies = [reply, reply, reply, reply];
    await sync.syncNow();
    await vi.waitFor(() => expect(sync.currentData()!.seenAchievements).toContain("max-77"));
    expect(sync.currentData()!.maxEntries.map((e) => e.id)).toEqual([77]);
  });

  it("without the option nothing is marked", async () => {
    const sync = await signedIn();
    replies = [{ status: 201, body: saved }];
    const seq = sync.enqueue({
      kind: "addMax",
      tempId: sync.takeTempId(),
      exerciseId: 1,
      date: "2026-11-02",
      valueLb: 318,
      source: "amrap",
      note: null,
      createdAt: saved.createdAt,
    });
    await sync.waitForAck(seq, 2000);
    expect(sync.currentData()!.seenAchievements).toEqual([]);
  });
});
