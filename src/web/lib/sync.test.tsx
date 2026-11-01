/**
 * The sync engine against a mocked server (jsdom): idempotency keys on the wire, sync details
 * for Settings, per-date "saved" pulses and the persistent-storage request.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bootstrap, Settings } from "../../shared/schemas";

vi.mock("../components/Toast", () => ({ showToast: vi.fn(() => 0) }));

type Sync = typeof import("./sync");
type Reply = { status: number; body?: unknown };

let calls: Array<{ method: string; path: string; headers: Record<string, string> }> = [];
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
      calls.push({ method: init.method ?? "GET", path, headers: { ...(init.headers as Record<string, string>) } });
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
