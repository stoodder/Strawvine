/**
 * The sync engine against a mocked server (jsdom): idempotency keys on the wire, sync details
 * for Settings, per-date "saved" pulses and the persistent-storage request.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bootstrap, Settings } from "../../shared/schemas";

vi.mock("../components/Toast", () => ({ showToast: vi.fn(() => 0) }));

type Sync = typeof import("./sync");
type Reply = { status: number; body?: unknown };

let calls: Array<{ method: string; path: string; headers: Record<string, string>; body?: unknown }> = [];
let replies: Array<Reply | ((path: string) => Reply)> = [];

async function load(): Promise<Sync> {
  vi.resetModules();
  return import("./sync");
}

beforeEach(() => {
  localStorage.clear();
  calls = [];
  replies = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const path = url.replace(/^\/api/, "");
      calls.push({
        method: init.method ?? "GET",
        path,
        headers: { ...(init.headers as Record<string, string>) },
        body: init.body ? JSON.parse(init.body as string) : undefined,
      });
      const next = replies.shift() ?? { status: 200, body: { ok: true } };
      const r = typeof next === "function" ? next(path) : next;
      return new Response(r.body === undefined ? "" : JSON.stringify(r.body), { status: r.status });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const exercise = { kind: "createExercise", tempId: -1, name: "Row", category: "accessory", measure: "reps", tracksMax: false } as const;
const savedExercise = { id: 42, name: "Row", category: "accessory", measure: "reps", tracksMax: false, archived: false };

describe("idempotent creates", () => {
  it("persists the key before sending and re-sends the same key on retry", async () => {
    const sync = await load();
    replies = [
      { status: 503, body: { error: "down" } },
      { status: 201, body: savedExercise },
    ];
    sync.enqueue({ ...exercise, tempId: sync.takeTempId() });
    const stored = JSON.parse(localStorage.getItem("strawvine:outbox")!);
    const key = stored.entries[0].op.idemKey as string;
    expect(key).toBeTruthy();

    await sync.syncNow(); // the 503 attempt already started; this skips the backoff and retries
    await vi.waitFor(() => expect(calls.filter((c) => c.path === "/exercises")).toHaveLength(2));
    const posts = calls.filter((c) => c.path === "/exercises");
    expect(posts.map((c) => c.headers["Idempotency-Key"])).toEqual([key, key]);
    expect(sync.getSyncInfo()).toMatchObject({ pending: 0, failed: 0, items: [] });
  });

  it("keys creates found in an outbox saved by an older version", async () => {
    localStorage.setItem("strawvine:signed-in", "1");
    localStorage.setItem(
      "strawvine:outbox",
      JSON.stringify({ entries: [{ seq: 1, op: { ...exercise }, state: "pending" }], nextSeq: 2, nextAck: 1, nextTemp: -2, tempMap: {} }),
    );
    const sync = await load();
    replies = [{ status: 201, body: savedExercise }];
    await sync.initSync();
    await sync.syncNow();
    expect(calls.find((c) => c.path === "/exercises")?.headers["Idempotency-Key"]).toMatch(/^[A-Za-z0-9._:-]{8,80}$/);
  });
});

describe("weighted exercise creates sent by a window on an older build", () => {
  // That build drops `weighted` from a create this window queued, so the server saves it weighted.
  const ackedElsewhere = () =>
    JSON.stringify({
      entries: [
        {
          seq: 1,
          rev: 1,
          op: { ...exercise, weighted: false, idemKey: "key-older-build-1" },
          state: "acked",
          result: { ...savedExercise, weighted: true },
          ackNo: 1,
        },
      ],
      nextSeq: 2,
      nextAck: 2,
      nextTemp: -2,
      tempMap: { "-1": 42 },
    });
  const patches = () => calls.filter((c) => c.method === "PATCH").map((c) => [c.path, c.body]);

  it("sends a weighted create without the flag, an unweighted one with it", async () => {
    const sync = await load();
    replies = [
      { status: 201, body: { ...savedExercise, weighted: true } },
      { status: 201, body: { ...savedExercise, id: 43, weighted: false } },
    ];
    sync.enqueue({ ...exercise, tempId: sync.takeTempId(), weighted: true });
    sync.enqueue({ ...exercise, tempId: sync.takeTempId(), weighted: false });
    await vi.waitFor(() => expect(calls.filter((c) => c.path === "/exercises")).toHaveLength(2));
    const posts = calls.filter((c) => c.path === "/exercises");
    expect(posts.map((c) => (c.body as { weighted?: boolean }).weighted)).toEqual([undefined, false]);
    await sync.syncNow();
    expect(patches()).toEqual([]);
  });

  it("turns the flag off when the other window's ack arrives", async () => {
    localStorage.setItem("strawvine:signed-in", "1");
    const sync = await load();
    await sync.initSync();
    replies = [{ status: 200, body: { ...savedExercise, weighted: false } }];
    localStorage.setItem("strawvine:outbox", ackedElsewhere());
    window.dispatchEvent(new StorageEvent("storage", { key: "strawvine:outbox", storageArea: localStorage }));
    await sync.syncNow();
    await vi.waitFor(() => expect(patches()).toEqual([["/exercises/42", { weighted: false }]]));
    // Queued once, and every window sees it queued.
    const stored = JSON.parse(localStorage.getItem("strawvine:outbox")!) as { entries: Array<{ weightedFix?: boolean }> };
    expect(stored.entries[0]!.weightedFix).toBe(true);
    window.dispatchEvent(new StorageEvent("storage", { key: "strawvine:outbox", storageArea: localStorage }));
    await sync.syncNow();
    expect(patches()).toHaveLength(1);
  });

  it("and when it's found on load", async () => {
    localStorage.setItem("strawvine:signed-in", "1");
    localStorage.setItem("strawvine:outbox", ackedElsewhere());
    const sync = await load();
    replies = [{ status: 200, body: { ...savedExercise, weighted: false } }];
    await sync.initSync();
    await sync.syncNow();
    await vi.waitFor(() => expect(patches()).toEqual([["/exercises/42", { weighted: false }]]));
  });
});

describe("replay", () => {
  it("an edit queued while a pass is finishing (right after an ack) is still sent promptly", async () => {
    const sync = await load();
    replies = [
      { status: 201, body: { id: 9, exerciseId: 1, date: "2026-11-01", valueLb: 100, source: "initial", note: null, createdAt: "x" } },
      { status: 200, body: { onboarded: true } },
    ];
    const seq = sync.enqueue({
      kind: "addMax",
      tempId: sync.takeTempId(),
      exerciseId: 1,
      date: "2026-11-01",
      valueLb: 100,
      source: "initial",
      note: null,
      createdAt: new Date().toISOString(),
    });
    // Like onboarding: await the create's ack, then queue the settings.
    await sync.waitForAck(seq, 3000);
    sync.enqueue({ kind: "settings", settings: { onboarded: true } as Settings });
    await vi.waitFor(() => expect(calls.map((c) => c.method + " " + c.path)).toContain("PUT /settings"), { timeout: 500 });
  });
});

describe("sync details", () => {
  it("lists unsynced changes, separates failed ones and records when the outbox drained", async () => {
    const sync = await load();
    expect(sync.getSyncInfo().lastSyncedAt).toBeNull();
    replies = [{ status: 400, body: { error: "invalid", issues: [{ path: "steps", message: "Too many" }] } }];
    sync.enqueue({ kind: "day", date: "2026-11-02", patch: { steps: 999_999 } });
    expect(sync.getPendingDates().has("2026-11-02")).toBe(true);
    await sync.syncNow();
    let info = sync.getSyncInfo();
    expect(info).toMatchObject({ online: true, pending: 0, failed: 1, lastSyncedAt: null });
    expect(info.items).toEqual([
      { id: expect.any(String), label: expect.stringMatching(/^Log · /), failed: true, error: "steps: Too many" },
    ]);
    expect(sync.getPendingDates().has("2026-11-02")).toBe(true); // still not on the server

    sync.discardFailed();
    replies = [{ status: 200, body: { date: "2026-11-03", steps: 5 } }];
    sync.enqueue({ kind: "day", date: "2026-11-03", patch: { steps: 5 } });
    expect(sync.getSyncInfo()).toMatchObject({ pending: 1, failed: 0 });
    await sync.syncNow();
    info = sync.getSyncInfo();
    expect(info.pending).toBe(0);
    expect(info.lastSyncedAt).toBeGreaterThan(0);
    expect(Number(localStorage.getItem("strawvine:last-synced"))).toBe(info.lastSyncedAt);
    expect(sync.getPendingDates().size).toBe(0);

    // Persisted across reloads.
    const again = await load();
    expect(again.getSyncInfo().lastSyncedAt).toBe(info.lastSyncedAt);
  });

  it("pulses a date each time the server confirms a day write for it", async () => {
    const sync = await load();
    const seen: number[] = [];
    sync.subscribeSavedPulse(() => seen.push(sync.getSavedPulse("2026-11-02")));
    replies = [
      { status: 200, body: { date: "2026-11-02", steps: 1 } },
      { status: 200, body: { date: "2026-11-02", steps: 2 } },
    ];
    sync.enqueue({ kind: "day", date: "2026-11-02", patch: { steps: 1 } });
    await sync.syncNow();
    expect(sync.getSavedPulse("2026-11-02")).toBe(1);
    sync.enqueue({ kind: "day", date: "2026-11-02", patch: { steps: 2 } });
    await sync.syncNow();
    expect(sync.getSavedPulse("2026-11-02")).toBe(2);
    expect(sync.getSavedPulse("2026-11-03")).toBe(0);
    expect(seen).toEqual([1, 2]);
  });
});

describe("persistent storage", () => {
  const boot = (onboarded: boolean): Bootstrap => ({
    settings: { onboarded } as Settings,
    days: [],
    exercises: [],
    maxEntries: [],
    sessions: [],
    seenAchievements: [],
  });

  it("asks once, after a bootstrap of an onboarded account, and tolerates refusal", async () => {
    const persist = vi.fn(async () => false);
    Object.defineProperty(navigator, "storage", { value: { persisted: async () => false, persist }, configurable: true });
    const sync = await load();
    const signal = new AbortController().signal;

    replies = [{ status: 200, body: boot(false) }];
    await sync.fetchBootstrap({ signal });
    await Promise.resolve();
    expect(persist).not.toHaveBeenCalled();

    replies = [
      { status: 200, body: boot(true) },
      { status: 200, body: boot(true) },
    ];
    await sync.fetchBootstrap({ signal });
    await sync.fetchBootstrap({ signal });
    await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(1));
    expect(sync.getSyncInfo().lastSyncedAt).toBeGreaterThan(0);
  });
});
