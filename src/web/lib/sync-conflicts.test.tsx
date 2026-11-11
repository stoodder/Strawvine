/**
 * Version-checked saves across devices, end to end through the sync engine (jsdom + fake
 * IndexedDB) against a fake server with the real revision rules: every save bumps the document's
 * revision; `If-Match` / `If-None-Match: *` that don't hold get a 409 with the current document;
 * documents are validated against the shared schemas. "Other devices" write to the fake server
 * directly, between this device's requests.
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSettings } from "../../shared/defaults";
import { sessionSchema, settingsSchema, type Bootstrap, type Session, type SetEntry, type Settings } from "../../shared/schemas";
import { blankSet } from "../../shared/session";

const toasts = vi.hoisted(() => [] as Array<{ message: string; tone?: string }>);
vi.mock("../components/Toast", () => ({ showToast: vi.fn((t: { message: string }) => (toasts.push(t), 0)) }));

type Sync = typeof import("./sync");
type Call = { method: string; path: string; headers: Record<string, string>; body?: unknown };
type Reply = {
  status: number;
  body?: unknown;
  /** A body that isn't JSON (a proxy's page), instead of `body`. */
  text?: string;
  headers?: Record<string, string>;
  /** Only for paths starting with this. */
  match?: string;
};

const D = "2026-11-02";
const settings: Settings = {
  ...defaultSettings({ bench: 1, deadlift: 2, backSquat: 3, frontSquat: 4, strictPress: 5 }, "2026-11-01"),
  onboarded: true,
};
const set = (id: string, over: Partial<SetEntry> = {}) => blankSet({ id, targetReps: 5, targetWeight: 100, ...over });
const logged = (id: string, reps = 5) => set(id, { done: true, reps, weight: 100 });
const session = (sets: SetEntry[], over: Partial<Session> = {}): Session => ({
  date: D,
  label: "Push",
  cycle: 1,
  week: 1,
  deload: false,
  primaryMaxLb: 315,
  blocks: [{ id: "p", kind: "primary", exercises: [{ exerciseId: 1, measure: "reps", sets }] }],
  notes: "",
  completedAt: null,
  planSig: null,
  ...over,
});
const setsOf = (s: Session | undefined) => s!.blocks[0]!.exercises[0]!.sets;
const doneOf = (s: Session | undefined) => setsOf(s).map((x) => x.done);

// ---------------------------------------------------------------------------
// The fake server
// ---------------------------------------------------------------------------

class FakeServer {
  sessions = new Map<string, { doc: Session; rev: string }>();
  settings: { doc: Settings; rev: string } = { doc: settings, rev: "s1" };
  private n = 1;
  version = 1;
  calls: Call[] = [];
  offline = false;
  /** Called before each write is handled (another device can write first). */
  beforeWrite: ((c: Call) => void) | null = null;
  /** Replies to use instead of handling (transient failures etc.), in order. */
  canned: Reply[] = [];
  /** How many of the next writes are handled but never answered (the connection drops first). */
  loseAnswers = 0;
  private gates: Array<{ match: (c: Call) => boolean; wait: Promise<void> }> = [];

  constructor() {
    this.sessions.set(D, { doc: session([set("a"), set("b"), set("c")]), rev: "r1" });
  }

  /** Another device saves a workout (or deletes it, with null). */
  otherDevice(date: string, doc: Session | null) {
    if (doc) this.sessions.set(date, { doc, rev: `r${++this.n}` });
    else this.sessions.delete(date);
    this.version++;
  }
  otherDeviceSettings(doc: Settings) {
    this.settings = { doc, rev: `s${++this.n}` };
    this.version++;
  }
  session(date = D) {
    return this.sessions.get(date)?.doc;
  }

  /** Holds the next matching request until `release()`. */
  hold(match: (c: Call) => boolean) {
    let release!: () => void;
    const wait = new Promise<void>((r) => (release = r));
    this.gates.push({ match, wait });
    return release;
  }

  writes() {
    return this.calls.filter((c) => c.method !== "GET");
  }

  bootstrap(): Bootstrap {
    const sessions = [...this.sessions.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
    return {
      settings: this.settings.doc,
      days: [],
      exercises: [1, 2, 3, 10, 11].map((id) => ({
        id,
        name: `L${id}`,
        category: "primary" as const,
        tracksMax: true,
        measure: "reps" as const,
        weighted: true,
        archived: false,
      })),
      maxEntries: [],
      sessions: sessions.map(([, s]) => s.doc),
      seenAchievements: [],
      revs: { settings: this.settings.rev, sessions: Object.fromEntries(sessions.map(([d, s]) => [d, s.rev])) },
    };
  }

  async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    if (this.offline) throw new TypeError("Failed to fetch");
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init.headers as Record<string, string>) ?? {})) headers[k.toLowerCase()] = v;
    const call: Call = {
      method: init.method ?? "GET",
      path: url.replace(/^\/api/, ""),
      headers,
      body: init.body ? JSON.parse(init.body as string) : undefined,
    };
    this.calls.push(call);
    const gate = this.gates.findIndex((g) => g.match(call));
    if (gate >= 0) {
      const [g] = this.gates.splice(gate, 1);
      await g!.wait;
    }
    const i = this.canned.findIndex((r) => !r.match || call.path.startsWith(r.match));
    const r = i >= 0 ? this.canned.splice(i, 1)[0]! : this.handle(call);
    if (call.method !== "GET" && this.loseAnswers > 0) {
      this.loseAnswers--;
      throw new TypeError("Failed to fetch");
    }
    const body = r.status === 304 ? null : (r.text ?? (r.body === undefined ? null : JSON.stringify(r.body)));
    return new Response(body, { status: r.status, headers: r.headers });
  }

  private conflict(pre: Call["headers"], cur: { rev: string } | undefined): boolean {
    if (!cur) return false; // a document deleted since is not a conflict
    if (pre["if-match"]) return pre["if-match"].replace(/"/g, "") !== cur.rev;
    return pre["if-none-match"] === "*";
  }

  private written(body: unknown, extra: Record<string, string> = {}): Reply {
    const prev = this.version++;
    return { status: 200, body, headers: { "x-dataset-etag": `"d${this.version}"`, "x-dataset-etag-prev": `"d${prev}"`, ...extra } };
  }

  private handle(c: Call): Reply {
    if (c.method === "GET" && c.path === "/bootstrap") {
      const etag = `W/"d${this.version}"`;
      if (c.headers["if-none-match"] === etag) return { status: 304, headers: { etag } };
      return { status: 200, body: this.bootstrap(), headers: { etag } };
    }
    if (c.method !== "GET") this.beforeWrite?.(c);
    const m = /^\/sessions\/(.+)$/.exec(c.path);
    if (m && c.method === "PUT") {
      const parsed = sessionSchema.safeParse(c.body);
      if (!parsed.success) return { status: 400, body: { error: "invalid", issues: [{ message: parsed.error.issues[0]!.message }] } };
      const cur = this.sessions.get(m[1]!);
      if (this.conflict(c.headers, cur)) return { status: 409, body: { error: "conflict", current: cur!.doc, rev: cur!.rev } };
      const rev = `r${++this.n}`;
      this.sessions.set(m[1]!, { doc: parsed.data, rev });
      return this.written(parsed.data, { etag: `"${rev}"` });
    }
    if (m && c.method === "DELETE") {
      const cur = this.sessions.get(m[1]!);
      if (cur && c.headers["if-match"] && c.headers["if-match"].replace(/"/g, "") !== cur.rev)
        return { status: 409, body: { error: "conflict", current: cur.doc, rev: cur.rev } };
      this.sessions.delete(m[1]!);
      return this.written({ ok: true });
    }
    if (c.path === "/settings" && c.method === "PUT") {
      const parsed = settingsSchema.safeParse(c.body);
      if (!parsed.success) return { status: 400, body: { error: "invalid" } };
      if (this.conflict(c.headers, this.settings))
        return { status: 409, body: { error: "conflict", current: this.settings.doc, rev: this.settings.rev } };
      this.settings = { doc: parsed.data, rev: `s${++this.n}` };
      return this.written(parsed.data, { etag: `"${this.settings.rev}"` });
    }
    if (c.path.startsWith("/days/")) return this.written({ date: c.path.slice(6), ...(c.body as object) });
    return this.written({ ok: true });
  }
}

let server: FakeServer;
const loaded: Sync[] = [];

async function load(): Promise<Sync> {
  vi.resetModules();
  const m = await import("./sync");
  loaded.push(m);
  return m;
}

beforeEach(() => {
  localStorage.clear();
  globalThis.indexedDB = new IDBFactory();
  toasts.length = 0;
  server = new FakeServer();
  Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => server.fetch(url, init)),
  );
});

afterEach(() => {
  for (const m of loaded.splice(0)) m.stopSync();
  vi.unstubAllGlobals();
});

const signal = new AbortController().signal;

async function device(): Promise<Sync> {
  localStorage.setItem("strawvine:signed-in", "1");
  const sync = await load();
  await sync.initSync();
  await sync.fetchBootstrap({ signal });
  return sync;
}

const shown = (sync: Sync, date = D) => sync.currentData()!.sessions.find((s) => s.date === date);
const settled = (sync: Sync) => vi.waitFor(() => expect(sync.getSyncInfo().unsynced).toBe(0));
const withSets = (s: Session, f: (sets: SetEntry[]) => SetEntry[]): Session => ({
  ...s,
  blocks: [{ ...s.blocks[0]!, exercises: [{ ...s.blocks[0]!.exercises[0]!, sets: f(setsOf(s)) }] }],
});
const logAt = (s: Session, i: number, reps = 5) =>
  withSets(s, (xs) => xs.map((x, n) => (n === i ? { ...x, done: true, reps, weight: 100 } : x)));
/** Takes the device off/on line (the engine follows the browser's online/offline events). */
const offline = (on: boolean) => {
  Object.defineProperty(navigator, "onLine", { value: !on, configurable: true });
  window.dispatchEvent(new Event(on ? "offline" : "online"));
};

describe("an edit made while a conflicting save is in flight", () => {
  it("doesn't undo the merge: the other device's sets survive the later edit", async () => {
    const sync = await device();
    server.otherDevice(D, logAt(server.session()!, 1)); // the phone logs set b
    const release = server.hold((c) => c.method === "PUT");
    sync.enqueue({ kind: "session", date: D, doc: logAt(shown(sync)!, 0) }); // this device logs set a
    await vi.waitFor(() => expect(server.writes()).toHaveLength(1));
    sync.enqueue({ kind: "session", date: D, doc: { ...shown(sync)!, notes: "felt good" } }); // made on the pre-merge screen
    release();
    await settled(sync);
    expect(doneOf(server.session())).toEqual([true, true, false]);
    expect(server.session()!.notes).toBe("felt good");
    expect(shown(sync)).toEqual(server.session());
    expect(toasts.map((t) => t.message)).toEqual(["Merged changes from another device"]);
    // Nothing went out unchecked.
    expect(server.writes().every((w) => w.headers["if-match"])).toBe(true);
  });
});

describe("after a second conflict in a row", () => {
  it("the merged copy stays on screen, and the next edit starts from the server's newest copy", async () => {
    const sync = await device();
    let k = 0;
    // Two other devices save just before each of this device's first two attempts.
    server.beforeWrite = () => {
      k++;
      if (k === 1) server.otherDevice(D, logAt(server.session()!, 1, 8));
      if (k === 2) server.otherDevice(D, logAt(server.session()!, 1, 10));
    };
    sync.enqueue({ kind: "session", date: D, doc: logAt(shown(sync)!, 0) });
    await vi.waitFor(() => expect(sync.getSyncInfo().failed).toBe(1));
    expect(toasts.at(-1)!.message).toMatch(/^Couldn't save your workout/);
    expect(setsOf(shown(sync)).map((x) => [x.done, x.reps])).toEqual([
      [true, 5],
      [true, 10],
      [false, null],
    ]);
    server.beforeWrite = null;
    sync.enqueue({ kind: "session", date: D, doc: logAt(shown(sync)!, 2) });
    await settled(sync);
    expect(setsOf(server.session()).map((x) => [x.done, x.reps])).toEqual([
      [true, 5],
      [true, 10],
      [true, 5],
    ]);
    expect(server.writes()).toHaveLength(3); // no wasted conflict on the last save
  });

  it("Retry merges again and saves", async () => {
    const sync = await device();
    let k = 0;
    server.beforeWrite = () => {
      if (++k <= 2) server.otherDevice(D, { ...server.session()!, notes: `device ${k}` });
    };
    sync.enqueue({ kind: "session", date: D, doc: logAt(shown(sync)!, 0) });
    await vi.waitFor(() => expect(sync.getSyncInfo().failed).toBe(1));
    sync.retryFailed();
    await settled(sync);
    expect(server.session()!.notes).toBe("device 2");
    expect(doneOf(server.session())).toEqual([true, false, false]);
  });
});

describe("three devices", () => {
  it("each device's sets and notes survive a chain of offline edits and conflicts", async () => {
    const sync = await device();
    offline(true);
    sync.enqueue({ kind: "session", date: D, doc: logAt(shown(sync)!, 0) }); // this device, offline
    server.otherDevice(D, logAt(server.session()!, 1)); // device 2
    server.otherDevice(D, { ...server.session()!, notes: "device 3" }); // device 3
    offline(false);
    await settled(sync);
    expect(doneOf(server.session())).toEqual([true, true, false]);
    expect(server.session()!.notes).toBe("device 3");

    // Device 2 logs set c and device 3 edits the notes again, while this device's edit is in flight.
    const release = server.hold((c) => c.method === "PUT");
    sync.enqueue({ kind: "session", date: D, doc: { ...shown(sync)!, label: "Push A" } });
    await vi.waitFor(() => expect(server.writes()).toHaveLength(3));
    server.otherDevice(D, logAt(server.session()!, 2));
    server.otherDevice(D, { ...server.session()!, notes: "device 3, again" });
    sync.enqueue({ kind: "session", date: D, doc: { ...shown(sync)!, completedAt: "2026-11-02T19:00:00Z" } });
    release();
    await settled(sync);
    const final = server.session()!;
    expect(doneOf(final)).toEqual([true, true, true]);
    expect([final.label, final.notes, final.completedAt]).toEqual(["Push A", "device 3, again", "2026-11-02T19:00:00Z"]);
    expect(shown(sync)).toEqual(final);
  });
});

describe("deleting workouts", () => {
  it("is version-checked: a workout changed on another device since is kept, calmly", async () => {
    const sync = await device();
    server.otherDevice(D, logAt(server.session()!, 1));
    sync.enqueue({ kind: "session", date: D, doc: null });
    await settled(sync);
    const del = server.writes()[0]!;
    expect([del.method, del.headers["if-match"]]).toEqual(["DELETE", '"r1"']);
    expect(server.session()).toBeDefined();
    expect(shown(sync)).toEqual(server.session()); // the server's copy is shown again
    expect(toasts.map((t) => t.message)).toEqual(["Your workout for Nov 2 changed on another device, so it wasn't deleted."]);
    expect(sync.getSyncInfo().failed).toBe(0);
  });

  it("deletes a workout nobody changed since", async () => {
    const sync = await device();
    sync.enqueue({ kind: "session", date: D, doc: null });
    await settled(sync);
    expect(server.session()).toBeUndefined();
    expect(shown(sync)).toBeUndefined();
  });

  it("create → delete offline sends nothing, so another device's new workout that day stays", async () => {
    const sync = await device();
    const day = "2026-11-03";
    offline(true);
    sync.enqueue({ kind: "session", date: day, doc: { ...session([set("x")]), date: day } });
    sync.enqueue({ kind: "session", date: day, doc: null });
    expect(sync.getSyncInfo().unsynced).toBe(0);
    server.otherDevice(day, { ...session([logged("y")]), date: day });
    offline(false);
    await settled(sync);
    expect(server.writes()).toEqual([]);
    expect(server.session(day)).toBeDefined();
  });

  it("delete → Undo offline: one save, checked against the revision the delete knew", async () => {
    const sync = await device();
    const before = shown(sync)!;
    offline(true);
    sync.enqueue({ kind: "session", date: D, doc: null });
    sync.enqueue({ kind: "session", date: D, doc: before });
    offline(false);
    await settled(sync);
    expect(server.writes().map((w) => [w.method, w.headers["if-match"]])).toEqual([["PUT", '"r1"']]);
  });

  it("a delete queued behind the save in flight goes out at the saved revision", async () => {
    const sync = await device();
    const day = "2026-11-04";
    const release = server.hold((c) => c.method === "PUT");
    sync.enqueue({ kind: "session", date: day, doc: { ...session([set("x")]), date: day } });
    await vi.waitFor(() => expect(server.writes()).toHaveLength(1));
    sync.enqueue({ kind: "session", date: day, doc: null });
    release();
    await settled(sync);
    const [put, del] = server.writes();
    expect(put!.headers["if-none-match"]).toBe("*");
    expect(del!.method).toBe("DELETE");
    expect(del!.headers["if-match"]).toMatch(/^"r\d+"$/);
    expect(server.session(day)).toBeUndefined();
  });

  it("a draft deleted while its save hit another device's workout: that workout stays untouched", async () => {
    const sync = await device();
    const day = "2026-11-05";
    server.otherDevice(day, { ...session([logged("y")]), date: day }); // after this device's last download
    const release = server.hold((c) => c.method === "PUT");
    sync.enqueue({ kind: "session", date: day, doc: { ...session([set("x")]), date: day } }); // this device knew of none
    await vi.waitFor(() => expect(server.writes()).toHaveLength(1));
    sync.enqueue({ kind: "session", date: day, doc: null });
    release();
    await settled(sync);
    expect(server.writes()).toHaveLength(1); // the conflicting create, nothing after
    expect(setsOf(server.session(day)).map((x) => x.id)).toEqual(["y"]);
    expect(shown(sync, day)).toEqual(server.session(day));
  });
});

describe("superset split here while another device logs", () => {
  it("doesn't duplicate an exercise or a set", async () => {
    const two = (sets: [SetEntry[], SetEntry[]]): Session => ({
      ...session([]),
      blocks: [
        {
          id: "X",
          kind: "accessory",
          exercises: [
            { exerciseId: 10, measure: "reps", sets: sets[0] },
            { exerciseId: 11, measure: "reps", sets: sets[1] },
          ],
        },
      ],
    });
    server.otherDevice(
      D,
      two([
        [set("a1"), set("a2")],
        [set("b1"), set("b2")],
      ]),
    );
    const sync = await device();
    server.otherDevice(
      D,
      two([
        [set("a1"), set("a2")],
        [logged("b1"), set("b2")],
      ]),
    );
    const cur = shown(sync)!;
    const [a, b] = cur.blocks[0]!.exercises;
    sync.enqueue({
      kind: "session",
      date: D,
      doc: {
        ...cur,
        blocks: [
          { ...cur.blocks[0]!, exercises: [b!] },
          { id: "Y", kind: "accessory", exercises: [a!] },
        ],
      },
    });
    await settled(sync);
    const final = server.session()!;
    expect(final.blocks.map((x) => [x.id, x.exercises.map((e) => e.exerciseId)])).toEqual([
      ["X", [11]],
      ["Y", [10]],
    ]);
    expect(final.blocks[0]!.exercises[0]!.sets[0]!.done).toBe(true);
  });
});

describe("server limits", () => {
  const many = (p: string, n: number, done: boolean) => Array.from({ length: n }, (_, i) => (done ? logged(`${p}${i}`) : set(`${p}${i}`)));

  it("a merge over the limits is trimmed (no logged set lost) and saved", async () => {
    const sync = await device();
    server.otherDevice(
      D,
      withSets(server.session()!, (xs) => [...xs, ...many("t", 15, true)]),
    );
    sync.enqueue({ kind: "session", date: D, doc: withSets(shown(sync)!, (xs) => [...xs, ...many("m", 20, false)]) });
    await settled(sync);
    expect(setsOf(server.session())).toHaveLength(30);
    expect(setsOf(server.session()).filter((x) => x.done)).toHaveLength(15);
  });

  it("logged work over the limits: not saved, with the reason, and no endless retries", async () => {
    const sync = await device();
    server.otherDevice(
      D,
      withSets(server.session()!, (xs) => [...xs, ...many("t", 15, true)]),
    );
    sync.enqueue({ kind: "session", date: D, doc: withSets(shown(sync)!, (xs) => [...xs, ...many("m", 16, true)]) });
    await vi.waitFor(() => expect(sync.getSyncInfo().failed).toBe(1));
    expect(sync.getSyncInfo().items[0]!.error).toMatch(/more than 30 logged sets/);
    sync.retryFailed();
    await vi.waitFor(() => expect(sync.getSyncInfo().failed).toBe(1));
    expect(server.writes()).toHaveLength(1); // refused here, never re-sent
  });
});

describe("settings", () => {
  it("strength targets added on two devices both survive; a list both changed is named", async () => {
    const sync = await device();
    const t = (id: string, exerciseId: number) => ({ id, exerciseId, targetLb: 400, setOn: D });
    const weeks = settings.program.weeks;
    server.otherDeviceSettings({
      ...settings,
      strengthTargets: [t("there", 1)],
      program: { ...settings.program, weeks: weeks.map((w, i) => (i === 0 ? { ...w, reps: [3, 3, 3] } : w)) },
    });
    sync.enqueue({
      kind: "settings",
      settings: {
        ...settings,
        strengthTargets: [t("here", 2)],
        program: { ...settings.program, weeks: weeks.map((w, i) => (i === 0 ? { ...w, reps: [5] } : w)) },
      },
    });
    await settled(sync);
    expect(server.settings.doc.strengthTargets.map((x) => x.id).sort()).toEqual(["here", "there"]);
    expect(server.settings.doc.program.weeks[0]!.reps).toEqual([5]);
    expect(toasts.map((x) => x.message)).toEqual(["Merged changes from another device (kept this device's program weeks)"]);
  });
});

/**
 * The server applied a save but its answer never arrived (a dropped connection, a timeout, the
 * app closed mid-request). To this device the save is still unsent, on the copy from before it —
 * so an edit that puts a field back (an Undo) must not be folded into it: the retry's 409 is this
 * device's own save, and a merge from the old copy would read the Undo as "nothing changed here".
 */
describe("a save the server applied but never answered", () => {
  const start = (s: Settings, cycleStartDate: string): Settings => ({ ...s, program: { ...s.program, cycleStartDate } });
  const steps = (s: Settings, n: number): Settings => ({ ...s, targets: { ...s.targets, steps: n } });
  const live = (sync: Sync) => sync.currentData()!.settings;
  const WAS = settings.program.cycleStartDate;
  const DELAYED = "2026-11-09";
  const settingsWrites = () => server.writes().map((w) => [w.headers["if-match"], (w.body as Settings).program.cycleStartDate]);

  it("Delay a week, then Undo: the server ends on the original date (and nothing is called a merge)", async () => {
    const sync = await device();
    server.loseAnswers = 1;
    sync.enqueue({ kind: "settings", settings: start(live(sync), DELAYED) });
    await vi.waitFor(() => expect(sync.getSyncState().retrying).toBe(true));
    expect(server.settings.doc.program.cycleStartDate).toBe(DELAYED);
    sync.enqueue({ kind: "settings", settings: start(live(sync), WAS) }); // Undo
    await settled(sync);
    expect(server.settings.doc).toEqual(settings);
    expect(live(sync)).toEqual(settings);
    expect(toasts).toEqual([]);
    // The lost save, its retry (409: already there — taken as the answer), then the Undo on its revision.
    expect(settingsWrites()).toEqual([
      ['"s1"', DELAYED],
      ['"s1"', DELAYED],
      ['"s2"', WAS],
    ]);
  });

  it("then offline: a steps target and the Undo — only the move is taken back", async () => {
    const sync = await device();
    server.loseAnswers = 1;
    sync.enqueue({ kind: "settings", settings: start(live(sync), DELAYED) });
    await vi.waitFor(() => expect(sync.getSyncState().retrying).toBe(true));
    offline(true);
    sync.enqueue({ kind: "settings", settings: steps(live(sync), 12000) });
    sync.enqueue({ kind: "settings", settings: start(live(sync), WAS) }); // Undo, on the live settings
    expect(sync.getSyncInfo().unsynced).toBe(2); // the lost save, and one edit behind it
    offline(false);
    await settled(sync);
    expect(server.settings.doc).toEqual(steps(settings, 12000));
    expect(live(sync)).toEqual(server.settings.doc);
    expect(toasts).toEqual([]);
  });

  it("with another device's change on top: merged, and the Undo still takes the date back", async () => {
    const sync = await device();
    server.loseAnswers = 1;
    sync.enqueue({ kind: "settings", settings: start(live(sync), DELAYED) });
    await vi.waitFor(() => expect(sync.getSyncState().retrying).toBe(true));
    offline(true);
    server.otherDeviceSettings({ ...server.settings.doc, targets: { ...settings.targets, zone2Minutes: 45 } });
    sync.enqueue({ kind: "settings", settings: start(live(sync), WAS) }); // Undo
    offline(false);
    await settled(sync);
    expect(server.settings.doc).toEqual({ ...settings, targets: { ...settings.targets, zone2Minutes: 45 } });
    expect(live(sync)).toEqual(server.settings.doc);
    expect(toasts.map((t) => t.message)).toEqual(["Merged changes from another device"]);
  });

  it("the app closed mid-save: the Undo after reopening isn't lost either", async () => {
    const first = await device();
    await first.persistNow();
    server.hold((c) => c.method === "PUT"); // the answer never reaches the page that asked
    first.enqueue({ kind: "settings", settings: start(live(first), DELAYED) });
    await vi.waitFor(() => expect(server.writes()).toHaveLength(1));
    first.stopSync();
    offline(true); // reopened without a connection, on the copy from before the save
    const sync = await load();
    await sync.initSync();
    expect(live(sync).program.cycleStartDate).toBe(DELAYED); // the unsent edit is still shown
    sync.enqueue({ kind: "settings", settings: start(live(sync), WAS) }); // Undo
    server.settings = { doc: start(settings, DELAYED), rev: "s2" }; // …while the server did save it
    offline(false);
    await settled(sync);
    expect(server.settings.doc).toEqual(settings);
    expect(toasts).toEqual([]);
  });

  it("a set logged, then un-logged: it stays un-logged", async () => {
    const sync = await device();
    server.loseAnswers = 1;
    sync.enqueue({ kind: "session", date: D, doc: logAt(shown(sync)!, 0) });
    await vi.waitFor(() => expect(sync.getSyncState().retrying).toBe(true));
    expect(doneOf(server.session())).toEqual([true, false, false]);
    sync.enqueue({ kind: "session", date: D, doc: withSets(shown(sync)!, (xs) => xs.map((x, i) => (i === 0 ? set("a") : x))) });
    await settled(sync);
    expect(doneOf(server.session())).toEqual([false, false, false]);
    expect(shown(sync)).toEqual(server.session());
    expect(toasts).toEqual([]);
  });

  it("a new workout, then deleted: it is deleted on the server too", async () => {
    const sync = await device();
    const date = "2026-11-03";
    server.loseAnswers = 1;
    sync.enqueue({ kind: "session", date, doc: session([set("x")], { date }) });
    await vi.waitFor(() => expect(sync.getSyncState().retrying).toBe(true));
    expect(server.session(date)).toBeDefined();
    sync.enqueue({ kind: "session", date, doc: null });
    await settled(sync);
    expect(server.session(date)).toBeUndefined();
    expect(shown(sync, date)).toBeUndefined();
    expect(toasts).toEqual([]);
  });
});

/**
 * A save went out and was never answered; before its retry, a revalidation takes in another
 * device's save. The screen still shows this device's document (the unsent edit covers the
 * refreshed copy), so what is done next is done without having seen the other device's change —
 * and must not be let through on the refreshed revision.
 */
describe("a save never answered, then this device's copy is refreshed with another device's change", () => {
  /** `op` goes out and never arrives; the phone then saves `theirs`, and this device re-reads the server (its retry still waiting). */
  async function triedThenRefreshed(sync: Sync, op: Parameters<Sync["enqueue"]>[0], date: string, theirs: Session) {
    server.offline = true; // the request leaves, nothing comes back
    sync.enqueue(op);
    await vi.waitFor(() => expect(sync.getSyncState().retrying).toBe(true));
    offline(true); // no retry until the device is back
    server.offline = false;
    server.otherDevice(date, theirs);
    await sync.fetchBootstrap({ signal }); // a revalidation gets through before the retry does
    expect(sync.getSyncInfo().unsynced).toBe(1);
  }
  const ifMatch = () => server.writes().map((w) => `${w.method} ${w.headers["if-match"] ?? w.headers["if-none-match"]}`);

  it("deleting the workout: refused — the set logged on the other device is still there", async () => {
    const sync = await device();
    await triedThenRefreshed(sync, { kind: "session", date: D, doc: logAt(shown(sync)!, 0) }, D, logAt(server.session()!, 1));
    expect(doneOf(shown(sync))).toEqual([true, false, false]); // the screen: this device's edit, not the phone's set b
    sync.enqueue({ kind: "session", date: D, doc: null });
    offline(false);
    await settled(sync);
    expect(doneOf(server.session())).toEqual([false, true, false]);
    expect(shown(sync)).toEqual(server.session());
    expect(toasts.map((t) => t.message)).toEqual(["Your workout for Nov 2 changed on another device, so it wasn't deleted."]);
    // The save's retry (409, dropped for the delete), then the delete at the revision the screen was built on.
    expect(ifMatch()).toEqual(['PUT "r1"', 'DELETE "r1"']);
  });

  it("a delete never answered, then the workout rebuilt: merged with the other device's, whose logged set survives", async () => {
    const sync = await device();
    await triedThenRefreshed(sync, { kind: "session", date: D, doc: null }, D, logAt(server.session()!, 1));
    expect(shown(sync)).toBeUndefined(); // the screen: deleted
    sync.enqueue({ kind: "session", date: D, doc: session([set("n1"), set("n2")]) });
    offline(false);
    await settled(sync);
    const saved = server.session()!.blocks.flatMap((b) => b.exercises.flatMap((x) => x.sets));
    expect(saved.find((x) => x.id === "b")).toMatchObject({ done: true, reps: 5 });
    expect(shown(sync)).toEqual(server.session());
    expect(toasts.map((t) => t.message)).toEqual([
      "Your workout for Nov 2 changed on another device, so it wasn't deleted.",
      "Merged changes from another device",
    ]);
    expect(ifMatch().slice(0, 2)).toEqual(['DELETE "r1"', 'PUT "r1"']); // nothing went out on the refreshed revision unmerged
  });

  it("the save refused (403) and dropped for the edit behind it: that edit is merged, not saved over the other device's set", async () => {
    const sync = await device();
    await triedThenRefreshed(sync, { kind: "session", date: D, doc: logAt(shown(sync)!, 0) }, D, logAt(server.session()!, 1));
    sync.enqueue({ kind: "session", date: D, doc: logAt(shown(sync)!, 2) }); // set c, on what the screen shows
    server.canned = [{ status: 403, body: { error: "Forbidden" }, match: "/sessions/" }]; // a proxy answers the retry
    offline(false);
    await settled(sync);
    expect(doneOf(server.session())).toEqual([true, true, true]);
    expect(shown(sync)).toEqual(server.session());
    expect(toasts.map((t) => t.message)).toEqual(["Merged changes from another device"]);
    expect(ifMatch()).toEqual(['PUT "r1"', 'PUT "r1"', 'PUT "r2"']);
  });

  it("a draft whose save never arrived, deleted: the workout another device made that day isn't touched", async () => {
    const sync = await device();
    const date = "2026-11-03";
    const phone = session([logged("p1")], { date, label: "Pull" });
    await triedThenRefreshed(sync, { kind: "session", date, doc: session([set("x")], { date }) }, date, phone);
    expect(setsOf(shown(sync, date)).map((x) => x.id)).toEqual(["x"]); // the screen: this device's draft
    sync.enqueue({ kind: "session", date, doc: null });
    offline(false);
    await settled(sync);
    expect(server.session(date)).toEqual(phone);
    expect(shown(sync, date)).toEqual(phone);
    expect(server.writes().map((w) => w.method)).toEqual(["PUT"]); // the draft's retry (409); no DELETE
    expect(toasts).toEqual([]);
  });
});

describe("a change the server can't take", () => {
  const half = "great \ud83d!"; // an emoji cut in half: ill-formed text, which the database refuses
  const sessionPuts = () => server.writes().filter((w) => w.path.startsWith("/sessions/"));
  const error500 = (n: number): Reply[] =>
    Array.from({ length: n }, () => ({ status: 500, body: { error: "Something went wrong" }, match: "/sessions/" }));
  /** Skips the retry backoff until `done()`: every "Sync now" is another attempt. */
  async function retryUntil(sync: Sync, done: () => boolean) {
    for (let i = 0; i < 40 && !done(); i++) await sync.syncNow();
    expect(done()).toBe(true);
  }

  it("text with half an emoji is refused on the device: not queued, not sent, listed with the reason", async () => {
    const sync = await device();
    expect(sync.enqueue({ kind: "session", date: D, doc: { ...shown(sync)!, notes: half } })).toBe(-1);
    expect(sync.enqueue({ kind: "day", date: D, patch: { journal: half } })).toBe(-1);
    expect(sync.getSyncInfo()).toMatchObject({ unsynced: 0, failed: 0 });
    expect(sync.getSyncInfo().refused.map((r) => [r.label, r.reason])).toEqual([
      ["Workout · Nov 2", "The text has a broken character (half of an emoji) — delete it and save again."],
      ["Log · Nov 2", "The text has a broken character (half of an emoji) — delete it and save again."],
    ]);
    expect(toasts[0]!.message).toBe("Not saved: The text has a broken character (half of an emoji) — delete it and save again.");
    expect(shown(sync)!.notes).toBe("");
    // The corrected text is saved like any edit.
    sync.enqueue({ kind: "session", date: D, doc: { ...shown(sync)!, notes: "great \ud83d\ude00!" } });
    await settled(sync);
    expect(server.session()!.notes).toBe("great \ud83d\ude00!");
    expect(server.writes()).toHaveLength(1);
  });

  it("one queued by an earlier build isn't sent: marked not saved with the reason, and what was waiting behind it goes out", async () => {
    // As that build left it: tried (answered 500 each time), with a day log stuck behind it.
    const first = server.session()!;
    localStorage.setItem(
      "strawvine:outbox",
      JSON.stringify({
        entries: [
          {
            seq: 1,
            op: { kind: "session", date: D, doc: { ...first, notes: half }, baseRev: "r1", base: first },
            state: "pending",
            tried: true,
          },
          { seq: 2, op: { kind: "day", date: D, patch: { steps: 9000 } }, state: "pending" },
        ],
        nextSeq: 3,
        nextAck: 1,
        nextTemp: -1,
        tempMap: {},
      }),
    );
    const sync = await device();
    await vi.waitFor(() => expect(sync.getSyncInfo().failed).toBe(1));
    await vi.waitFor(() => expect(sync.getSyncInfo().pending).toBe(0));
    expect(sync.getSyncInfo().items).toEqual([
      {
        id: "1",
        label: "Workout · Nov 2",
        failed: true,
        error: "The text has a broken character (half of an emoji) — delete it and save again.",
      },
    ]);
    expect(server.writes().map((w) => w.path)).toEqual([`/days/${D}`]); // the workout never left the device again
    // Typing the note again replaces it…
    sync.enqueue({ kind: "session", date: D, doc: { ...shown(sync)!, notes: "great" } });
    await settled(sync);
    expect(server.session()!.notes).toBe("great");
    expect(sessionPuts().map((w) => w.headers["if-match"])).toEqual(['"r1"']);
  });

  it("…or Discard drops it, and the server's copy shows again", async () => {
    const first = server.session()!;
    localStorage.setItem(
      "strawvine:outbox",
      JSON.stringify({
        entries: [
          {
            seq: 1,
            op: { kind: "session", date: D, doc: { ...first, notes: half }, baseRev: "r1", base: first },
            state: "pending",
            tried: true,
          },
        ],
        nextSeq: 2,
        nextAck: 1,
        nextTemp: -1,
        tempMap: {},
      }),
    );
    const sync = await device();
    await vi.waitFor(() => expect(sync.getSyncInfo().failed).toBe(1));
    expect(shown(sync)!.notes).toBe(half); // still shown here until retried or discarded
    sync.discardFailed();
    expect(sync.getSyncInfo()).toMatchObject({ unsynced: 0, failed: 0 });
    expect(shown(sync)).toEqual(first);
    expect(server.writes()).toEqual([]);
  });

  it("a save answered with a server error every time stops being retried: not saved (Retry / Discard), and the rest of the queue is sent", async () => {
    const sync = await device();
    server.canned = error500(sync.SERVER_ERROR_TRIES + 5);
    sync.enqueue({ kind: "session", date: D, doc: { ...shown(sync)!, notes: "poison" } });
    sync.enqueue({ kind: "day", date: D, patch: { steps: 9000 } }); // waits its turn behind it
    await vi.waitFor(() => expect(sync.getSyncState().retrying).toBe(true));
    expect(sync.getSyncInfo()).toMatchObject({ pending: 2, failed: 0 });
    await retryUntil(sync, () => sync.getSyncInfo().failed === 1);
    expect(sessionPuts()).toHaveLength(sync.SERVER_ERROR_TRIES);
    await vi.waitFor(() => expect(sync.getSyncInfo().pending).toBe(0)); // the day log went out
    expect(server.writes().at(-1)!.path).toBe(`/days/${D}`);
    expect(sync.getSyncInfo().items).toEqual([
      {
        id: expect.any(String),
        label: "Workout · Nov 2",
        failed: true,
        error: "The server keeps failing on this change (error 500). Retry later, or discard it.",
      },
    ]);
    expect(sync.getSyncState()).toMatchObject({ failed: 1, retrying: false });
    expect(toasts.at(-1)!.message).toBe(
      "Couldn't save your workout for 2026-11-02: The server keeps failing on this change (error 500). Retry later, or discard it.",
    );
    expect(shown(sync)!.notes).toBe("poison"); // still shown here
    // Nothing more is sent on its own…
    await sync.syncNow();
    expect(sessionPuts()).toHaveLength(sync.SERVER_ERROR_TRIES);
    // …Discard drops it: the server's copy shows again and nothing is left to send.
    sync.discardFailed();
    expect(sync.getSyncInfo()).toMatchObject({ unsynced: 0, failed: 0 });
    await vi.waitFor(() => expect(shown(sync)).toEqual(server.session()));
    expect(shown(sync)!.notes).toBe("");
  });

  it("Retry sends it again once the server can take it", async () => {
    const sync = await device();
    server.canned = error500(sync.SERVER_ERROR_TRIES);
    sync.enqueue({ kind: "session", date: D, doc: logAt(shown(sync)!, 0) });
    await vi.waitFor(() => expect(sync.getSyncState().retrying).toBe(true));
    await retryUntil(sync, () => sync.getSyncInfo().failed === 1);
    expect(sync.getSyncState()).toMatchObject({ pending: 1, failed: 1, retrying: false }); // "1 not saved", not "Can't reach server"
    sync.retryFailed();
    await settled(sync);
    expect(doneOf(server.session())).toEqual([true, false, false]);
    expect(sessionPuts().map((w) => w.headers["if-match"])).toEqual(Array(sync.SERVER_ERROR_TRIES + 1).fill('"r1"'));
  });

  it("a corrected document queued behind it takes its place, before or after it was given up on", async () => {
    const sync = await device();
    server.canned = error500(sync.SERVER_ERROR_TRIES);
    sync.enqueue({ kind: "session", date: D, doc: { ...shown(sync)!, notes: "poison" } });
    await vi.waitFor(() => expect(sync.getSyncState().retrying).toBe(true));
    sync.enqueue({ kind: "session", date: D, doc: { ...shown(sync)!, notes: "fine" } }); // behind the save that went out
    expect(sync.getSyncInfo().unsynced).toBe(2);
    await retryUntil(sync, () => sync.getSyncInfo().unsynced === 0);
    expect(server.session()!.notes).toBe("fine");
    expect(sync.getSyncInfo().failed).toBe(0);
    expect(sessionPuts()).toHaveLength(sync.SERVER_ERROR_TRIES + 1);
    expect(toasts).toEqual([]);

    // Given up on first, corrected after.
    server.canned = error500(sync.SERVER_ERROR_TRIES);
    sync.enqueue({ kind: "session", date: D, doc: { ...shown(sync)!, notes: "poison again" } });
    await vi.waitFor(() => expect(sync.getSyncState().retrying).toBe(true));
    await retryUntil(sync, () => sync.getSyncInfo().failed === 1);
    sync.enqueue({ kind: "session", date: D, doc: { ...shown(sync)!, notes: "fine again" } });
    await settled(sync);
    expect(server.session()!.notes).toBe("fine again");
    expect(sync.getSyncInfo().failed).toBe(0);
  });

  it("an edit of the change starts the count over", async () => {
    const sync = await device();
    const n = sync.SERVER_ERROR_TRIES;
    const dayError = (): Reply => ({ status: 500, body: { error: "Something went wrong" }, match: "/days/" });
    server.canned = Array.from({ length: n - 1 }, dayError);
    sync.enqueue({ kind: "day", date: D, patch: { steps: 1 } });
    await vi.waitFor(() => expect(sync.getSyncState().retrying).toBe(true));
    await retryUntil(sync, () => server.writes().length === n - 1);
    // One short of giving up: the patch is edited (merged into the unsent one — a new change).
    server.canned = Array.from({ length: n - 1 }, dayError);
    sync.enqueue({ kind: "day", date: D, patch: { steps: 2 } });
    await retryUntil(sync, () => sync.getSyncInfo().unsynced === 0);
    expect(sync.getSyncInfo().failed).toBe(0);
    expect(server.writes()).toHaveLength(2 * (n - 1) + 1);
  });

  it("no answer from the app itself — a gateway's error page, a dropped connection — is retried for as long as it takes", async () => {
    const sync = await device();
    const tries = sync.SERVER_ERROR_TRIES + 4;
    // A proxy's 503 page (not JSON), and one that answers 200 with a sign-in page.
    server.canned = Array.from({ length: tries + 10 }, (_, i) =>
      i % 2
        ? { status: 503, match: "/sessions/" }
        : { status: 200, headers: { "content-type": "text/html" }, match: "/sessions/", text: "<html>" },
    );
    sync.enqueue({ kind: "session", date: D, doc: logAt(shown(sync)!, 0) });
    await vi.waitFor(() => expect(sync.getSyncState().retrying).toBe(true));
    await retryUntil(sync, () => sessionPuts().length >= tries);
    expect(sync.getSyncInfo()).toMatchObject({ pending: 1, failed: 0 });
    server.canned = []; // the connection is back
    await retryUntil(sync, () => sync.getSyncInfo().unsynced === 0);
    expect(doneOf(server.session())).toEqual([true, false, false]);
    expect(toasts).toEqual([]);
  });
});

describe("a 409 that isn't a version conflict", () => {
  it("is a refusal even when it carries a document: nothing is merged or re-sent, and the reason is shown", async () => {
    const sync = await device();
    const theirs = logAt(server.session()!, 1);
    server.canned = [{ status: 409, body: { error: "This workout is locked", current: theirs, rev: "r9" }, match: "/sessions/" }];
    sync.enqueue({ kind: "session", date: D, doc: logAt(shown(sync)!, 0) });
    await vi.waitFor(() => expect(sync.getSyncInfo().failed).toBe(1));
    expect(sync.getSyncInfo().items[0]).toMatchObject({ failed: true, error: "This workout is locked" });
    expect(doneOf(shown(sync))).toEqual([true, false, false]); // this device's edit, unmerged
    expect(server.writes()).toHaveLength(1);
    expect(toasts.map((t) => t.message)).toEqual(["Couldn't save your workout for 2026-11-02: This workout is locked"]);
  });
});

describe("an Undo while the save it takes back is still in flight", () => {
  it("is sent after it, on its revision: the server ends on the original settings", async () => {
    const sync = await device();
    const release = server.hold((c) => c.method === "PUT");
    const before = sync.currentData()!.settings;
    sync.enqueue({ kind: "settings", settings: { ...before, program: { ...before.program, cycleStartDate: "2026-11-09" } } });
    await vi.waitFor(() => expect(server.writes()).toHaveLength(1));
    const delayed = sync.currentData()!.settings;
    sync.enqueue({ kind: "settings", settings: { ...delayed, targets: { ...delayed.targets, steps: 12000 } } });
    const now = sync.currentData()!.settings;
    sync.enqueue({ kind: "settings", settings: { ...now, program: { ...now.program, cycleStartDate: before.program.cycleStartDate } } });
    release();
    await settled(sync);
    expect(server.settings.doc).toEqual({ ...settings, targets: { ...settings.targets, steps: 12000 } });
    expect(server.writes().map((w) => w.headers["if-match"])).toEqual(['"s1"', '"s2"']);
    expect(toasts).toEqual([]);
  });
});

describe("two windows", () => {
  it("an edit right after the other window's save starts from that save's revision (no wasted conflict)", async () => {
    vi.stubGlobal("BroadcastChannel", undefined); // the shared outbox is the only link
    const a = await device();
    const b = await device();
    a.enqueue({ kind: "session", date: D, doc: logAt(shown(a)!, 0) });
    await settled(a);
    const saved = server.sessions.get(D)!.rev;
    b.enqueue({ kind: "session", date: D, doc: { ...logAt(shown(a)!, 0), notes: "from b" } });
    await vi.waitFor(() => expect(server.writes()).toHaveLength(2));
    await settled(b);
    expect(server.writes()[1]!.headers["if-match"]).toBe(`"${saved}"`);
    expect(server.session()!.notes).toBe("from b");
  });
});

describe("forget this device", () => {
  it("waits while changes are getting through, reporting the count, then says none were dropped", async () => {
    const sync = await device();
    server.canned = [
      { status: 503, body: { error: "busy" }, match: "/days/" },
      { status: 503, body: { error: "busy" }, match: "/days/" },
    ];
    sync.enqueue({ kind: "day", date: D, patch: { steps: 1 } });
    sync.enqueue({ kind: "day", date: "2026-11-03", patch: { steps: 2 } });
    const progress: number[] = [];
    const res = await sync.forgetDevice({ onProgress: (n) => progress.push(n) });
    expect(res).toEqual({ pendingDropped: 0 });
    expect(progress[0]).toBe(2);
    expect(progress.at(-1)).toBe(0);
    expect(server.writes().filter((w) => w.path.startsWith("/days/"))).toHaveLength(4);
    expect(sync.isSignedIn()).toBe(false);
  });

  it("counts what couldn't be sent (rejected, or no progress in time)", async () => {
    const sync = await device();
    server.canned = [{ status: 400, body: { error: "bad" }, match: "/days/" }];
    sync.enqueue({ kind: "day", date: D, patch: { steps: 1 } });
    await vi.waitFor(() => expect(sync.getSyncInfo().failed).toBe(1));
    server.canned = Array.from({ length: 50 }, () => ({ status: 503, body: { error: "busy" }, match: "/days/" }));
    sync.enqueue({ kind: "day", date: "2026-11-03", patch: { steps: 2 } });
    const res = await sync.forgetDevice({ patienceMs: 300 });
    expect(res).toEqual({ pendingDropped: 2 });
  });
});
