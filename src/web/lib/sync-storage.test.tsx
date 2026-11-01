/**
 * The sync engine with a real (fake) IndexedDB: the device copy written right after the first
 * download and restored on reload, per-piece writes, 304 revalidation, sign-out wipes, two
 * windows sharing one outbox, and rejected edits.
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bootstrap, DayLog, Session, Settings } from "../../shared/schemas";

const toasts = vi.hoisted(() => [] as Array<{ message: string }>);
vi.mock("../components/Toast", () => ({ showToast: vi.fn((t: { message: string }) => (toasts.push(t), 0)) }));

type Sync = typeof import("./sync");
type Reply = { status: number; body?: unknown; headers?: Record<string, string> };

let calls: Array<{ method: string; path: string; headers: Record<string, string>; body?: unknown }> = [];
let replies: Array<Reply | ((path: string, init: RequestInit) => Reply)> = [];
let offline = false;
const loaded: Sync[] = [];

/** A fresh copy of the module, as after a reload (localStorage and IndexedDB persist). */
async function load(): Promise<Sync> {
  vi.resetModules();
  const m = await import("./sync");
  loaded.push(m);
  return m;
}

const day = (date: string, steps: number) => ({ date, steps }) as unknown as DayLog;
const data = (days = 3): Bootstrap => ({
  settings: { onboarded: true } as Settings,
  days: Array.from({ length: days }, (_, i) => day(`202${4 + (i % 3)}-01-0${1 + Math.floor(i / 3)}`, i)).sort((a, b) =>
    a.date < b.date ? -1 : 1,
  ),
  exercises: [],
  maxEntries: [],
  sessions: [],
  seenAchievements: [],
});

beforeEach(() => {
  localStorage.clear();
  globalThis.indexedDB = new IDBFactory();
  calls = [];
  replies = [];
  toasts.length = 0;
  offline = false;
  setNavigatorOnline(true);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      if (offline) throw new TypeError("Failed to fetch");
      const path = url.replace(/^\/api/, "");
      calls.push({
        method: init.method ?? "GET",
        path,
        headers: { ...(init.headers as Record<string, string>) },
        body: init.body ? JSON.parse(init.body as string) : undefined,
      });
      const next = replies.shift() ?? { status: 200, body: { ok: true } };
      const r = typeof next === "function" ? next(path, init) : next;
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
/** What a freshly loaded module (and its query library) sees as the connection state. */
function setNavigatorOnline(v: boolean) {
  Object.defineProperty(navigator, "onLine", { value: v, configurable: true });
}
const settle = () => new Promise((r) => setTimeout(r, 30));

/** Signs in and downloads `d`; returns the module. */
async function signedIn(d: Bootstrap = data(), etag = '"v1"') {
  localStorage.setItem("strawvine:signed-in", "1");
  const sync = await load();
  await sync.initSync();
  replies = [{ status: 200, body: d, headers: { etag } }];
  await sync.fetchBootstrap({ signal });
  return sync;
}

describe("the device copy", () => {
  it("is written right after the first download, so a reload offline moments later still has data", async () => {
    const d = data(9);
    await signedIn(d);
    await vi.waitFor(async () => {
      const again = await load();
      offline = true;
      await again.initSync();
      expect(again.currentData()?.days).toEqual(d.days);
    });
  });

  it("a copy that takes longer than 1.5 s to read is still adopted when it arrives", async () => {
    const d = data(6);
    const sync = await signedIn(d);
    await sync.persistNow();
    vi.resetModules();
    vi.doMock("./idb", async (importOriginal) => {
      const real = await importOriginal<typeof import("./idb")>();
      return {
        ...real,
        idbReadSet: (...args: Parameters<typeof real.idbReadSet>) =>
          new Promise((r) => setTimeout(() => r(real.idbReadSet(...args)), 1800)),
      };
    });
    const slow = await import("./sync");
    loaded.push(slow);
    offline = true;
    await slow.initSync();
    expect(slow.currentData()).toBeUndefined();
    expect(slow.getSyncState().restoring).toBe(true);
    await vi.waitFor(() => expect(slow.currentData()?.days).toEqual(d.days), { timeout: 2000 });
    expect(slow.getSyncState().restoring).toBe(false);
    vi.doUnmock("./idb");
  });

  it("revalidates with the stored ETag and keeps everything as is on 304", async () => {
    const sync = await signedIn(data(), '"v1"');
    const before = sync.currentData();
    replies = [{ status: 304, headers: { etag: '"v1"' } }];
    const after = await sync.fetchBootstrap({ signal });
    expect(calls.at(-1)!.headers["If-None-Match"]).toBe('"v1"');
    expect(after).toBe(before);

    // The ETag is stored with the copy: after a reload it's sent again.
    await sync.persistNow();
    const again = await load();
    await again.initSync();
    replies = [{ status: 304 }];
    await again.fetchBootstrap({ signal });
    expect(calls.at(-1)!.headers["If-None-Match"]).toBe('"v1"');
  });

  it("writes only the pieces that changed, and nothing when nothing did", async () => {
    const sync = await signedIn(data(9));
    await sync.persistNow();
    const put = vi.spyOn(IDBObjectStore.prototype, "put");
    await sync.persistNow();
    expect(put).not.toHaveBeenCalled();

    replies = [{ status: 200, body: day("2025-01-01", 77) }];
    sync.enqueue({ kind: "day", date: "2025-01-01", patch: { steps: 77 } });
    await vi.waitFor(() => expect(sync.getSyncInfo().unsynced).toBe(0));
    await sync.persistNow();
    const keys = put.mock.calls.map((c) => c[1]);
    expect(keys).toEqual(["b:days:2025", "b:meta"]);
    put.mockRestore();
  });

  it("keeps the displayed arrays when the server confirms exactly what's shown", async () => {
    const sync = await signedIn(data(3));
    const before = sync.currentData()!;
    replies = [{ status: 200, body: { date: "2024-01-01", steps: 5 } }];
    sync.enqueue({ kind: "day", date: "2024-01-01", patch: { steps: 5 } });
    const shown = sync.currentData()!;
    expect(shown.days).not.toBe(before.days);
    await vi.waitFor(() => expect(sync.getSyncInfo().unsynced).toBe(0));
    expect(sync.currentData()!.days).toBe(shown.days);
  });
});

describe("sign-out", () => {
  it("wipes the copy and the outbox, and a reopened app offline shows nothing", async () => {
    const sync = await signedIn(data(6));
    await sync.persistNow();
    offline = true;
    sync.enqueue({ kind: "day", date: "2026-02-01", patch: { steps: 1 } });
    const r = await sync.signOut();
    expect(r).toEqual({ ok: false, reason: "offline" });
    expect(sync.isSignedIn()).toBe(false);
    expect(sync.currentData()).toBeUndefined();
    expect(sync.getSyncInfo().unsynced).toBe(0);
    expect(localStorage.getItem("strawvine:logout-pending")).toBe("1");

    const again = await load();
    await again.initSync();
    expect(again.currentData()).toBeUndefined();
    await settle();
    const { meta } = await (await import("./idb")).idbReadSet("b:meta", () => []);
    expect(meta).toBeUndefined();

    // Back online: the server sign-out is sent before anything else (and before a new sign-in).
    offline = false;
    calls = [];
    const api = await import("./api");
    replies = [
      { status: 200, body: { ok: true } },
      { status: 200, body: { ok: true } },
    ];
    await api.api("/auth/login", { method: "POST", body: { password: "x" } });
    expect(calls.map((c) => c.path)).toEqual(["/auth/logout", "/auth/login"]);
    expect(localStorage.getItem("strawvine:logout-pending")).toBeNull();
  });

  it("keeps unsynced edits when asked (but still wipes the copy)", async () => {
    const sync = await signedIn(data(3));
    offline = true;
    sync.enqueue({ kind: "day", date: "2026-02-01", patch: { steps: 1 } });
    offline = false;
    replies = [{ status: 200, body: { ok: true } }];
    expect(await sync.signOut({ keepUnsynced: true })).toEqual({ ok: true });
    expect(sync.currentData()).toBeUndefined();
    const again = await load();
    await again.initSync();
    expect(again.getSyncInfo().unsynced).toBe(1);
    expect(again.currentData()).toBeUndefined();
  });

  it("a write already in flight can't bring the copy back", async () => {
    const sync = await signedIn(data(9));
    const writing = sync.persistNow();
    void sync.signOut();
    await writing;
    await settle();
    const { meta } = await (await import("./idb")).idbReadSet("b:meta", () => []);
    expect(meta).toBeUndefined();
    expect(localStorage.getItem("strawvine:signed-in")).toBeNull();
  });
});

describe("rejected edits", () => {
  it("later edits aren't swallowed by a failed one, and Discard drops only the failed one", async () => {
    const sync = await signedIn(data(3));
    replies = [{ status: 400, body: { error: "invalid", issues: [{ path: "steps", message: "Too many" }] } }];
    sync.enqueue({ kind: "day", date: "2024-01-01", patch: { steps: 999_999 } });
    await vi.waitFor(() => expect(sync.getSyncInfo().failed).toBe(1));

    replies = [
      { status: 200, body: day("2024-01-01", 0) },
      { status: 200, body: data(3) },
    ];
    sync.enqueue({ kind: "day", date: "2024-01-01", patch: { calories: 2100 } as never });
    await vi.waitFor(() => expect(calls.some((c) => c.method === "PUT" && (c.body as { calories?: number }).calories === 2100)).toBe(true));
    const put = calls.find((c) => c.method === "PUT" && (c.body as { calories?: number }).calories === 2100)!;
    expect(put.body).toEqual({ calories: 2100 });
    await vi.waitFor(() => expect(sync.getSyncInfo()).toMatchObject({ failed: 1, pending: 0 }));

    sync.discardFailed();
    expect(sync.getSyncInfo()).toMatchObject({ failed: 0, pending: 0, unsynced: 0 });
  });

  it("refuses an edit the server would reject, with a toast, instead of queueing it", async () => {
    const sync = await signedIn(data(3));
    const ex = { exerciseId: 1, measure: "reps", sets: [] };
    const doc = {
      date: "2026-03-01",
      label: "",
      cycle: null,
      week: null,
      deload: false,
      primaryMaxLb: null,
      notes: "",
      completedAt: null,
      blocks: [{ id: "a", kind: "accessory", exercises: Array(7).fill(ex) }],
    } as unknown as Session;
    expect(sync.enqueue({ kind: "session", date: doc.date, doc })).toBe(-1);
    expect(toasts.at(-1)?.message).toMatch(/superset/);
    expect(sync.getSyncInfo().unsynced).toBe(0);
  });
});

describe("two windows", () => {
  it("edits from both windows survive, and only one window sends them", async () => {
    localStorage.setItem("strawvine:signed-in", "1");
    offline = true;
    setNavigatorOnline(false);
    const a = await load();
    await a.initSync();
    const b = await load();
    await b.initSync();

    a.enqueue({ kind: "day", date: "2026-01-01", patch: { steps: 1 } });
    b.enqueue({ kind: "day", date: "2026-01-02", patch: { steps: 2 } });
    a.enqueue({ kind: "day", date: "2026-01-03", patch: { steps: 3 } });
    const stored = JSON.parse(localStorage.getItem("strawvine:outbox")!) as { entries: { seq: number }[] };
    expect(stored.entries).toHaveLength(3);
    expect(new Set(stored.entries.map((e) => e.seq)).size).toBe(3);
    expect(calls).toEqual([]);

    // Window b is killed; a comes back online and sends everything, once.
    b.stopSync();
    offline = false;
    replies = [1, 2, 3].map((n) => ({ status: 200, body: day(`2026-01-0${n}`, n) }));
    setNavigatorOnline(true);
    window.dispatchEvent(new Event("online"));
    await vi.waitFor(() => expect(a.getSyncInfo().unsynced).toBe(0));
    const puts = calls.filter((c) => c.method === "PUT").map((c) => c.path);
    expect(puts.sort()).toEqual(["/days/2026-01-01", "/days/2026-01-02", "/days/2026-01-03"]);
  });

  it("a window applies acks made by the other one", async () => {
    localStorage.setItem("strawvine:signed-in", "1");
    const a = await load();
    await a.initSync();
    replies = [{ status: 200, body: data(3), headers: { etag: '"v1"' } }];
    await a.fetchBootstrap({ signal });
    const b = await load();
    await b.initSync();
    replies = [{ status: 304 }];
    await b.fetchBootstrap({ signal }).catch(() => {});
    if (!b.currentData()) {
      replies = [{ status: 200, body: data(3), headers: { etag: '"v1"' } }];
      await b.fetchBootstrap({ signal });
    }
    // b goes quiet (hidden/frozen); a saves settings.
    replies = [{ status: 200, body: { onboarded: true, theme: "x" } }];
    a.enqueue({ kind: "settings", settings: { onboarded: true, theme: "x" } as unknown as Settings });
    await vi.waitFor(() => expect(a.getSyncInfo().unsynced).toBe(0));
    // The storage event (or the broadcast) brings it to b without a refetch.
    window.dispatchEvent(new StorageEvent("storage", { key: "strawvine:outbox", storageArea: localStorage }));
    await vi.waitFor(() => expect((b.currentData()!.settings as unknown as { theme: string }).theme).toBe("x"));
  });

  it("signing out in one window signs the other out too", async () => {
    localStorage.setItem("strawvine:signed-in", "1");
    const a = await load();
    await a.initSync();
    replies = [{ status: 200, body: data(3) }];
    await a.fetchBootstrap({ signal });
    const b = await load();
    await b.initSync();
    expect(b.currentData()).toBeDefined();
    const out = vi.fn();
    window.addEventListener(b.SIGNED_OUT_EVENT, out);
    replies = [{ status: 200, body: { ok: true } }];
    await a.signOut();
    window.dispatchEvent(new StorageEvent("storage", { key: "strawvine:signed-in", storageArea: localStorage }));
    expect(b.currentData()).toBeUndefined();
    expect(out).toHaveBeenCalled();
    window.removeEventListener(b.SIGNED_OUT_EVENT, out);
  });
});
