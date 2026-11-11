/**
 * The Train screen's set rows, end to end against a (mocked, reactive) store: the check logs and
 * unlogs at the targets (no toast: the check is its own undo), the values open the editor, an
 * AMRAP's check opens its rep counter and a weighted set without a load opens the editor instead
 * of logging — no long press anywhere. Plus what sits around the rows: the rest a check starts
 * (and ends, unlogged), Finish in the dock once everything is logged, the program link in the
 * header in every cycle state (and the way back from Program), what stands in for a main lift
 * before the program starts, and the order of the exercise options.
 */
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSettings } from "../../shared/defaults";
import type { Exercise, MaxEntry, Session, Settings } from "../../shared/schemas";
import { blankSet, buildSession } from "../../shared/session";
import { DockProvider } from "../components/Dock";
import { ProgramScreen } from "./Program";
import { TrainScreen } from "./Train";

interface Data {
  settings: Settings;
  exercises: Exercise[];
  sessions: Session[];
  maxEntries: MaxEntry[];
  seenAchievements: [];
}
const store = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const s = {
    data: null as unknown as Data,
    listeners,
    toasts: [] as string[],
    set(data: Data) {
      s.data = data;
      for (const l of listeners) l();
    },
  };
  return s;
});
vi.mock("../lib/store", async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (l: () => void) => {
    store.listeners.add(l);
    return () => store.listeners.delete(l);
  };
  const others = (date: string) => store.data.sessions.filter((s) => s.date !== date);
  const save = (session: Session) => store.set({ ...store.data, sessions: [...others(session.date), session] });
  const remove = (date: string) => store.set({ ...store.data, sessions: others(date) });
  return {
    useData: () => ({ data: useSyncExternalStore(subscribe, () => store.data), today: TODAY }),
    cachedSession: (date: string) => store.data.sessions.find((s) => s.date === date) ?? null,
    useSaveSession: () => save,
    useDeleteSession: () => remove,
    useSaveSettings: () => (next: Settings) => {
      store.set({ ...store.data, settings: next });
      return Promise.resolve(next);
    },
    useAddMax: () => vi.fn(),
    useDeleteMax: () => vi.fn(),
    useCreateExercise: () => vi.fn(),
    useEditExercise: () => vi.fn(),
    useMarkSeen: () => vi.fn(),
    usePendingDates: () => new Set<string>(),
  };
});
vi.mock("../lib/sync", () => ({ currentData: () => store.data }));
vi.mock("../components/Toast", () => {
  const api = { show: (t: { message: string }) => store.toasts.push(t.message), dismiss: () => {} };
  return { useToast: () => api };
});

/** A Monday in week 3 of the first cycle (the cycle starts Monday 2026-11-02): bench press, AMRAP last set. */
const TODAY = "2026-11-16";
const BENCH = 1;
const DEADLIFT = 2;
const PULL_UP = 20;
const CURL = 21;
const HANG = 22;
const settings = {
  ...defaultSettings({ bench: BENCH, deadlift: DEADLIFT, backSquat: 3, frontSquat: 4, strictPress: 5 }, "2026-11-02"),
  onboarded: true,
};
const ex = (o: Partial<Exercise> & Pick<Exercise, "id" | "name">): Exercise => ({
  category: "accessory",
  tracksMax: false,
  measure: "reps",
  weighted: true,
  archived: false,
  ...o,
});
const exercises = [
  ex({ id: BENCH, name: "Bench press", category: "primary", tracksMax: true }),
  ex({ id: DEADLIFT, name: "Deadlift", category: "primary", tracksMax: true }),
  ex({ id: PULL_UP, name: "Pull-up", weighted: false }),
  ex({ id: CURL, name: "Curl" }),
  ex({ id: HANG, name: "Hang", measure: "seconds" }),
];
const maxEntries: MaxEntry[] = [
  { id: 1, exerciseId: BENCH, date: "2026-11-01", valueLb: 225, source: "manual", note: null, createdAt: "2026-11-01T10:00:00.000Z" },
];
const base = (): Data => ({ settings, exercises, sessions: [], maxEntries, seenAchievements: [] });
/** Today's session as planned, plus accessories: unweighted reps, weighted reps with no load yet, weighted time. */
const planned = (date = TODAY): Session => ({
  ...buildSession(date, { ...base(), sessions: [] }),
  blocks: [
    ...buildSession(date, { ...base(), sessions: [] }).blocks.map((b) => ({
      ...b,
      exercises: b.exercises.map((e) => ({ ...e, sets: e.sets.map((s, i) => ({ ...s, id: `m${i + 1}` })) })),
    })),
    {
      id: "pull",
      kind: "accessory",
      exercises: [{ exerciseId: PULL_UP, measure: "reps", sets: [blankSet({ id: "p1", targetReps: 8 }), blankSet({ id: "p2", targetReps: 8 })] }],
    },
    { id: "curl", kind: "accessory", exercises: [{ exerciseId: CURL, measure: "reps", sets: [blankSet({ id: "c1", targetReps: 10 })] }] },
    {
      id: "hang",
      kind: "accessory",
      exercises: [{ exerciseId: HANG, measure: "seconds", sets: [blankSet({ id: "h1", targetReps: 30, targetWeight: 25 })] }],
    },
  ],
});

/** Where the router is, and the state the last navigation carried. */
function Where() {
  const { pathname, hash, state } = useLocation();
  return (
    <output data-testid="where" data-state={JSON.stringify(state)}>
      {pathname + hash}
    </output>
  );
}
const where = () => screen.getByTestId("where").textContent;
const navState = () => JSON.parse(screen.getByTestId("where").getAttribute("data-state")!) as unknown;

/** Train, with the real Program screen behind its header link when `program` says so. */
function renderTrain(path = "/train", { program = false }: { program?: boolean } = {}) {
  return render(
    <DockProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/train" element={<TrainScreen />} />
          <Route path="/train/:date" element={<TrainScreen />} />
          <Route path="/program" element={program ? <ProgramScreen /> : <h1>Program</h1>} />
        </Routes>
        <Where />
      </MemoryRouter>
    </DockProvider>,
    { container: document.getElementById("root")! },
  );
}
/** The app closed (unmounted, the page gone): the next `renderTrain` is a fresh load. localStorage stays. */
const reload = () => {
  cleanup();
  document.body.innerHTML = '<div id="root"></div>';
};
const today = () => store.data.sessions.find((s) => s.date === TODAY)!;
const setById = (id: string) =>
  today()
    .blocks.flatMap((b) => b.exercises)
    .flatMap((e) => e.sets)
    .find((s) => s.id === id)!;
const check = (name: RegExp) => screen.getByRole("button", { name });
const dock = () => within(screen.getByRole("region", { name: "Notifications" }));
const finishInDock = () => dock().queryByRole("button", { name: /^Finish · / });
const restPill = () => dock().queryByRole("group", { name: "Rest timer" });
/** Every set of a session logged at its targets (`except`: set ids left open). */
const allLogged = (s: Session, except: string[] = []): Session => ({
  ...s,
  blocks: s.blocks.map((b) => ({
    ...b,
    exercises: b.exercises.map((e) => ({
      ...e,
      sets: e.sets.map((x) => (except.includes(x.id) ? x : { ...x, done: true, reps: x.targetReps, weight: x.targetWeight })),
    })),
  })),
});

/**
 * A stand-in IntersectionObserver (jsdom has none): reports `onScreen` for whatever is observed,
 * at once and again whenever `scrollPage` changes it — the page's own Finish button coming on and
 * going off screen.
 */
const viewport = { onScreen: false, observers: new Set<{ report: () => void }>() };
class FakeIntersectionObserver {
  private targets: Element[] = [];
  constructor(private callback: (entries: Array<{ isIntersecting: boolean; target: Element }>) => void) {
    viewport.observers.add(this);
  }
  report() {
    if (this.targets.length) this.callback(this.targets.map((target) => ({ isIntersecting: viewport.onScreen, target })));
  }
  observe(el: Element) {
    this.targets.push(el);
    this.report();
  }
  unobserve() {}
  disconnect() {
    viewport.observers.delete(this);
  }
}
const watchViewport = (onScreen: boolean) => {
  viewport.onScreen = onScreen;
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
};
const scrollPage = (onScreen: boolean) =>
  act(() => {
    viewport.onScreen = onScreen;
    for (const o of viewport.observers) o.report();
  });

// jsdom has no scrolling: revealing the next open set above the dock is a no-op here.
window.scrollBy = () => {};

beforeEach(() => {
  localStorage.clear();
  store.toasts.length = 0;
  store.data = { ...base(), sessions: [planned()] };
});
afterEach(() => {
  vi.unstubAllGlobals();
  viewport.observers.clear();
});

describe("set rows on Train", () => {
  it("lists every set as a row with its two controls; nothing explains a hidden gesture", () => {
    renderTrain();
    const bench = within(screen.getByRole("list", { name: "Bench press sets" }));
    expect(bench.getAllByRole("listitem")).toHaveLength(4);
    expect(bench.getAllByRole("button", { name: /^Bench press set \d: / })).toHaveLength(4);
    expect(bench.getAllByRole("button", { name: /^Edit Bench press set \d: / })).toHaveLength(4);
    const pull = within(screen.getByRole("list", { name: "Pull-up sets" }));
    expect(pull.getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual([
      "Edit Pull-up set 1: 8 reps",
      "Pull-up set 1: 8 reps",
      "Edit Pull-up set 2: 8 reps",
      "Pull-up set 2: 8 reps",
    ]);
    expect(screen.queryByText(/hold to edit/i)).toBeNull();
    expect(document.body.textContent).not.toMatch(/Shift\+F10|context-menu/i);
    // "+ Set" ends each exercise's rows.
    expect(screen.getByRole("button", { name: "Add Pull-up set" }).textContent).toBe(" set");
    expect(screen.getByRole("button", { name: "Add a back-off set of Bench press" }).textContent).toBe(" set");
  });

  it("the check logs a main-lift set at its targets, and unlogs it again — no toast either way", async () => {
    const user = userEvent.setup();
    renderTrain();
    const before = setById("m1");
    await user.click(check(/^Bench press set 1: /));
    expect(setById("m1")).toMatchObject({ done: true, reps: before.targetReps, weight: before.targetWeight });
    expect(check(/^Bench press set 1: /).getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(store.toasts).toEqual([]);
    await user.click(check(/^Bench press set 1: /));
    expect(setById("m1").done).toBe(false);
    expect(check(/^Bench press set 1: /).getAttribute("aria-pressed")).toBe("false");
    expect(store.toasts).toEqual([]);
  });

  it("the check logs an accessory set and unlogs it — no toast: the check is its own undo", async () => {
    const user = userEvent.setup();
    renderTrain();
    await user.click(check(/^Pull-up set 1: 8 reps$/));
    expect(setById("p1")).toMatchObject({ done: true, reps: 8, weight: null });
    expect(setById("p2").done).toBe(false);
    expect(store.toasts).toEqual([]);
    await user.click(check(/^Pull-up set 1: 8 reps$/));
    expect(setById("p1").done).toBe(false);
    // A weighted set with its load, too.
    await user.click(check(/^Hang set 1: /));
    await user.click(check(/^Hang set 1: /));
    expect(store.toasts).toEqual([]);
  });

  it("the values open the set editor and log nothing; saving a target there changes the row (with an Undo toast)", async () => {
    const user = userEvent.setup();
    renderTrain();
    await user.click(screen.getByRole("button", { name: "Edit Pull-up set 1: 8 reps" }));
    const editor = within(screen.getByRole("dialog", { name: "Pull-up · set 1" }));
    expect(setById("p1").done).toBe(false);
    // Opened by its values, the editor has nothing to explain.
    expect(document.querySelector("[data-editor-hint]")).toBeNull();
    await user.click(editor.getByRole("button", { name: "Decrease reps" }));
    await user.click(editor.getByRole("button", { name: "Save target" }));
    expect(setById("p1")).toMatchObject({ done: false, targetReps: 7 });
    // The target carries to the open set after it.
    expect(setById("p2").targetReps).toBe(7);
    expect(await screen.findByRole("button", { name: "Edit Pull-up set 1: 7 reps" })).toBeTruthy();
    // A changed value has no other undo.
    expect(store.toasts).toEqual(["Pull-up · set 1 updated"]);
  });

  it("the editor's toasts: only for a save that changed a value", async () => {
    const user = userEvent.setup();
    renderTrain();
    const openEditor = async () => {
      await user.click(await screen.findByRole("button", { name: /^Edit Pull-up set 1: / }));
      return within(screen.getByRole("dialog", { name: "Pull-up · set 1" }));
    };
    // Saved as it was: nothing to undo.
    await user.click((await openEditor()).getByRole("button", { name: "Save target" }));
    expect(store.toasts).toEqual([]);
    // Logged as it stood — what the row's check does, and undoes.
    await user.click((await openEditor()).getByRole("button", { name: "Log set" }));
    expect(setById("p1")).toMatchObject({ done: true, reps: 8 });
    expect(store.toasts).toEqual([]);
    // Updated to what was really done.
    const editor = await openEditor();
    await user.click(editor.getByRole("button", { name: "Increase reps" }));
    await user.click(editor.getByRole("button", { name: "Update" }));
    expect(setById("p1")).toMatchObject({ done: true, reps: 9 });
    expect(store.toasts).toEqual(["Pull-up · set 1 updated"]);
    // Logged with a different amount than planned.
    await user.click(await screen.findByRole("button", { name: /^Edit Pull-up set 2: / }));
    const second = within(screen.getByRole("dialog", { name: "Pull-up · set 2" }));
    await user.click(second.getByRole("button", { name: "Decrease reps" }));
    await user.click(second.getByRole("button", { name: "Log set" }));
    expect(store.toasts).toEqual(["Pull-up · set 1 updated", "Pull-up · set 2 logged"]);
  });

  it("the other edits keep their Undo toast: delete a set, log the remaining sets, skip, remove", async () => {
    const user = userEvent.setup();
    renderTrain();
    const options = async () => {
      await user.click(await screen.findByRole("button", { name: "Pull-up options" }));
      return within(screen.getByRole("dialog", { name: "Pull-up" }));
    };
    await user.click((await options()).getByRole("button", { name: "Delete set 2" }));
    expect(store.toasts.at(-1)).toBe("Pull-up · set 2 deleted");
    await user.click((await options()).getByRole("button", { name: /^Log remaining sets/ }));
    expect(store.toasts.at(-1)).toBe("Pull-up · 1 set logged");
    await user.click((await options()).getByRole("button", { name: /^Skip today/ }));
    expect(store.toasts.at(-1)).toBe("Skipped today · stays in next Monday's plan");
    await user.click(await screen.findByRole("button", { name: "Curl options" }));
    await user.click(within(screen.getByRole("dialog", { name: "Curl" })).getByRole("button", { name: /^Remove —/ }));
    expect(store.toasts.at(-1)).toBe("Curl removed");
    expect(store.toasts).toHaveLength(4);
  });

  it("an open AMRAP's check opens the rep counter instead of logging; so do its values", async () => {
    const user = userEvent.setup();
    renderTrain();
    const amrap = check(/^Bench press set 4: .*AMRAP$/);
    expect(amrap.getAttribute("aria-haspopup")).toBe("dialog");
    await user.click(amrap);
    expect(screen.getByRole("dialog", { name: /AMRAP/ })).toBeTruthy();
    expect(setById("m4").done).toBe(false);
    await user.click(screen.getByRole("button", { name: "Close" }));
    await user.click(await screen.findByRole("button", { name: /^Edit Bench press set 4: .*AMRAP$/ }));
    expect(screen.getByRole("dialog", { name: /AMRAP/ })).toBeTruthy();
    expect(setById("m4").done).toBe(false);
  });

  it("a weighted set with no load: the check opens the editor (to set the load) instead of logging", async () => {
    const user = userEvent.setup();
    renderTrain();
    const curl = check(/^Curl set 1: 10 reps \(no load\)$/);
    expect(curl.getAttribute("aria-haspopup")).toBe("dialog");
    await user.click(curl);
    const editor = within(screen.getByRole("dialog", { name: "Curl · set 1" }));
    expect(setById("c1").done).toBe(false);
    // The sheet says why it opened instead of logging — as the description of Log set.
    expect(editor.getByText("No load yet — set it to log this set")).toBeTruthy();
    expect(editor.getByRole("button", { name: "Log set", description: "No load yet — set it to log this set" })).toBeTruthy();
    for (let i = 0; i < 4; i++) await user.click(editor.getByRole("button", { name: "Increase load" }));
    await user.click(editor.getByRole("button", { name: "Log set" }));
    expect(setById("c1")).toMatchObject({ done: true, reps: 10, weight: 20 });
    expect((await screen.findByRole("button", { name: "Curl set 1: 10 reps at 20 lb" })).getAttribute("aria-pressed")).toBe("true");
    // The load was set there: that save keeps its Undo.
    expect(store.toasts).toEqual(["Curl · set 1 logged"]);
  });

  it("the no-load hint is for the check's detour only: closed and reopened by the values, the editor has none", async () => {
    const user = userEvent.setup();
    renderTrain();
    await user.click(check(/^Curl set 1: 10 reps \(no load\)$/));
    expect(document.querySelector("[data-editor-hint]")!.textContent).toBe("No load yet — set it to log this set");
    await user.click(within(screen.getByRole("dialog", { name: "Curl · set 1" })).getByRole("button", { name: "Close" }));
    await user.click(await screen.findByRole("button", { name: /^Edit Curl set 1: / }));
    const editor = within(screen.getByRole("dialog", { name: "Curl · set 1" }));
    expect(document.querySelector("[data-editor-hint]")).toBeNull();
    expect(editor.getByRole("button", { name: "Log set" }).hasAttribute("aria-describedby")).toBe(false);
  });

  it("a weighted set that has its load is logged by the check, load and all", async () => {
    const user = userEvent.setup();
    renderTrain();
    await user.click(check(/^Hang set 1: 30s at 25 lb$/));
    expect(setById("h1")).toMatchObject({ done: true, reps: 30, weight: 25 });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("“+ Set” adds a row like the last one", async () => {
    const user = userEvent.setup();
    renderTrain();
    await user.click(screen.getByRole("button", { name: "Add Pull-up set" }));
    expect(within(screen.getByRole("list", { name: "Pull-up sets" })).getAllByRole("listitem")).toHaveLength(3);
    expect(screen.getByRole("button", { name: "Pull-up set 3: 8 reps" })).toBeTruthy();
  });

  it("a preview shows the same rows, with nothing to press", () => {
    store.data = { ...base(), sessions: [{ ...planned("2026-11-09"), completedAt: "2026-11-09T18:00:00.000Z" }] };
    renderTrain("/train/2026-11-23");
    const pull = within(screen.getByRole("list", { name: "Pull-up sets" }));
    expect(pull.getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Set 1: 8 reps1 8 reps", "Set 2: 8 reps2 8 reps"]);
    expect(pull.queryByRole("button")).toBeNull();
    expect(within(screen.getByRole("list", { name: "Bench press sets" })).queryByRole("button")).toBeNull();
    expect(screen.queryByRole("button", { name: "Add Pull-up set" })).toBeNull();
  });
});

describe("the rest a check starts", () => {
  it("logging a set starts the rest; unlogging that set stops it", async () => {
    const user = userEvent.setup();
    renderTrain();
    expect(restPill()).toBeNull();
    await user.click(check(/^Pull-up set 1: /));
    expect(restPill()).not.toBeNull();
    await user.click(check(/^Pull-up set 1: /));
    expect(restPill()).toBeNull();
    // The main lift alike.
    await user.click(check(/^Bench press set 1: /));
    expect(restPill()).not.toBeNull();
    await user.click(check(/^Bench press set 1: /));
    expect(restPill()).toBeNull();
  });

  it("unlogging an earlier set leaves the rest the latest set started", async () => {
    const user = userEvent.setup();
    renderTrain();
    await user.click(check(/^Pull-up set 1: /));
    await user.click(check(/^Pull-up set 2: /));
    await user.click(check(/^Pull-up set 1: /));
    expect(setById("p1").done).toBe(false);
    expect(restPill()).not.toBeNull();
    // …and unlogging the one that did start it stops it.
    await user.click(check(/^Pull-up set 2: /));
    expect(restPill()).toBeNull();
  });

  it("still knows which set started the rest after a reload", async () => {
    const user = userEvent.setup();
    renderTrain();
    await user.click(check(/^Pull-up set 1: /));
    expect(restPill()).not.toBeNull();
    reload();
    renderTrain();
    expect(restPill()).not.toBeNull();
    await user.click(check(/^Pull-up set 1: /));
    expect(setById("p1").done).toBe(false);
    expect(restPill()).toBeNull();
  });

  it("a rest several sets started at once (log remaining) isn't any one set's to stop", async () => {
    const user = userEvent.setup();
    renderTrain();
    await user.click(screen.getByRole("button", { name: "Pull-up options" }));
    await user.click(within(screen.getByRole("dialog", { name: "Pull-up" })).getByRole("button", { name: /^Log remaining sets/ }));
    expect(restPill()).not.toBeNull();
    await user.click(await screen.findByRole("button", { name: /^Pull-up set 2: / }));
    expect(setById("p2").done).toBe(false);
    expect(restPill()).not.toBeNull();
  });

  it("a rest started in the set editor is stopped by unlogging that set", async () => {
    const user = userEvent.setup();
    renderTrain();
    await user.click(check(/^Curl set 1: /));
    const editor = within(screen.getByRole("dialog", { name: "Curl · set 1" }));
    await user.click(editor.getByRole("button", { name: "Increase load" }));
    await user.click(editor.getByRole("button", { name: "Log set" }));
    expect(restPill()).not.toBeNull();
    await user.click(await screen.findByRole("button", { name: /^Curl set 1: / }));
    expect(setById("c1").done).toBe(false);
    expect(restPill()).toBeNull();
  });
});

describe("the main lift's plates", () => {
  const plates = () => screen.queryByRole("img", { name: /^Plates/ });

  it("name the next open set — not the first one — and move on as sets are logged", async () => {
    const user = userEvent.setup();
    renderTrain();
    // 225 max, week 3: every set is over an empty bar.
    expect(plates()!.getAttribute("aria-label")).toMatch(/^Plates, Set 1, per side: /);
    expect(plates()!.textContent).toMatch(/^Set 1 · per side/);
    await user.click(check(/^Bench press set 1: /));
    expect(plates()!.getAttribute("aria-label")).toMatch(/^Plates, Set 2, per side: /);
    // Logged out of order: the plates are for the first set still open.
    await user.click(check(/^Bench press set 3: /));
    expect(plates()!.getAttribute("aria-label")).toMatch(/^Plates, Set 2, per side: /);
    await user.click(check(/^Bench press set 2: /));
    expect(plates()!.getAttribute("aria-label")).toMatch(/^Plates, Set 4, per side: /);
    await user.click(check(/^Bench press set 1: /));
    expect(plates()!.getAttribute("aria-label")).toMatch(/^Plates, Set 1, per side: /);
  });

  it("go once every main-lift set is logged", () => {
    store.data = { ...base(), sessions: [allLogged(planned())] };
    renderTrain();
    expect(plates()).toBeNull();
  });

  it("a preview shows the first set's plates without naming a set", () => {
    store.data = { ...base(), sessions: [] };
    renderTrain("/train/2026-11-23");
    expect(screen.getByText("Preview")).toBeTruthy();
    expect(plates()!.getAttribute("aria-label")).toMatch(/^Plates per side: /);
    expect(plates()!.textContent).toMatch(/^per side/);
    expect(plates()!.textContent).not.toMatch(/Set \d/);
  });
});

describe("Finish in the dock", () => {
  it("stays out of the dock while sets are open: Finish is the page's own button", async () => {
    const user = userEvent.setup();
    renderTrain();
    expect(finishInDock()).toBeNull();
    expect(screen.getByRole("button", { name: "Finish session" })).toHaveProperty("disabled", true);
    await user.click(check(/^Pull-up set 1: /));
    expect(finishInDock()).toBeNull();
    expect(screen.getByRole("button", { name: "Finish session" })).toHaveProperty("disabled", false);
  });

  it("the page's button asks about unlogged sets, then finishes — the dock stays clear throughout", async () => {
    const user = userEvent.setup();
    renderTrain();
    await user.click(check(/^Pull-up set 1: /));
    await user.click(screen.getByRole("button", { name: "Finish session" }));
    const question = await screen.findByRole("group", { name: /Finish with 7 sets unlogged\?/ });
    expect(finishInDock()).toBeNull();
    expect(today().completedAt).toBeNull();
    await user.click(within(question).getByRole("button", { name: "Keep logging" }));
    await user.click(await screen.findByRole("button", { name: "Finish session" }));
    await user.click(within(await screen.findByRole("group", { name: /unlogged\?/ })).getByRole("button", { name: "Finish" }));
    expect(today().completedAt).not.toBeNull();
    expect(await screen.findByRole("heading", { name: "Session complete" })).toBeTruthy();
    expect(finishInDock()).toBeNull();
  });

  it("appears with the last set logged, in the accent, and goes when one is unlogged", async () => {
    const user = userEvent.setup();
    store.data = { ...base(), sessions: [allLogged(planned(), ["p2"])] };
    renderTrain();
    expect(finishInDock()).toBeNull();
    await user.click(check(/^Pull-up set 2: /));
    expect(finishInDock()!.textContent).toBe("Finish·8/8 sets");
    expect(finishInDock()!.getAttribute("aria-label")).toBe("Finish · 8/8 sets");
    expect(finishInDock()!.className).toContain("bg-accent");
    await user.click(check(/^Pull-up set 2: /));
    expect(finishInDock()).toBeNull();
  });

  it("finishes straight away when pressed: nothing is unlogged, so nothing is asked", async () => {
    const user = userEvent.setup();
    store.data = { ...base(), sessions: [allLogged(planned())] };
    renderTrain();
    expect(finishInDock()!.getAttribute("aria-label")).toBe("Finish · 8/8 sets");
    await user.click(finishInDock()!);
    expect(screen.queryByText(/unlogged\?/)).toBeNull();
    expect(today().completedAt).not.toBeNull();
    expect(finishInDock()).toBeNull();
    // Focus lands on the recap that replaced it.
    expect(document.activeElement).toBe(await screen.findByRole("heading", { name: "Session complete" }));
  });

  it("only while the page's own Finish button is off screen", async () => {
    watchViewport(true);
    store.data = { ...base(), sessions: [allLogged(planned())] };
    renderTrain();
    // The button is on screen: one Finish, not two on top of each other.
    expect(finishInDock()).toBeNull();
    await scrollPage(false);
    expect(finishInDock()).not.toBeNull();
    await scrollPage(true);
    expect(finishInDock()).toBeNull();
  });

  it("with the button on screen, logging the last set doesn't bring it up either", async () => {
    const user = userEvent.setup();
    watchViewport(true);
    store.data = { ...base(), sessions: [allLogged(planned(), ["p2"])] };
    renderTrain();
    await user.click(check(/^Pull-up set 2: /));
    expect(finishInDock()).toBeNull();
    await scrollPage(false);
    expect(finishInDock()!.getAttribute("aria-label")).toBe("Finish · 8/8 sets");
  });

  it("a skipped main lift counts for nothing: no dock Finish with nothing logged, one once the rest is", async () => {
    const user = userEvent.setup();
    const s = planned();
    const skipped: Session = { ...s, blocks: s.blocks.map((b) => (b.kind === "primary" ? { ...b, skipped: true } : b)) };
    store.data = { ...base(), sessions: [skipped] };
    renderTrain();
    // The day can be finished empty — from the page, not the dock.
    expect(screen.getByRole("button", { name: "Finish session" })).toHaveProperty("disabled", false);
    expect(finishInDock()).toBeNull();
    for (const name of [/^Pull-up set 1: /, /^Pull-up set 2: /, /^Hang set 1: /]) await user.click(check(name));
    // Curl's set is still open (it needs a load).
    expect(finishInDock()).toBeNull();
    await user.click(check(/^Curl set 1: /));
    const editor = within(screen.getByRole("dialog", { name: "Curl · set 1" }));
    await user.click(editor.getByRole("button", { name: "Increase load" }));
    await user.click(editor.getByRole("button", { name: "Log set" }));
    await screen.findByRole("button", { name: "Curl set 1: 10 reps at 5 lb" });
    expect(finishInDock()!.getAttribute("aria-label")).toBe("Finish · 4/4 sets");
  });

  it("a session with only a skipped main lift never puts Finish in the dock", () => {
    const s = planned();
    store.data = {
      ...base(),
      sessions: [{ ...s, blocks: s.blocks.filter((b) => b.kind === "primary").map((b) => ({ ...b, skipped: true })) }],
    };
    renderTrain();
    expect(screen.getByRole("button", { name: "Finish session" })).toHaveProperty("disabled", false);
    expect(finishInDock()).toBeNull();
  });

  it("an accessory skipped today doesn't hold it back", () => {
    const s = allLogged(planned(), ["c1"]);
    store.data = {
      ...base(),
      sessions: [{ ...s, blocks: s.blocks.map((b) => (b.id === "curl" ? { ...b, exercises: b.exercises.map((e) => ({ ...e, skipped: true })) } : b)) }],
    };
    renderTrain();
    expect(finishInDock()!.getAttribute("aria-label")).toBe("Finish · 7/7 sets");
  });

  it("is not offered on a finished session", () => {
    store.data = { ...base(), sessions: [{ ...allLogged(planned()), completedAt: `${TODAY}T18:00:00.000Z` }] };
    renderTrain();
    expect(screen.getByRole("heading", { name: "Session complete" })).toBeTruthy();
    expect(finishInDock()).toBeNull();
  });

  it("is not offered on a preview", () => {
    // Next Monday's preview carries the accessories over; nothing is logged or finished there.
    renderTrain("/train/2026-11-23");
    expect(screen.getByText("Preview")).toBeTruthy();
    expect(finishInDock()).toBeNull();
    expect(screen.queryByRole("button", { name: "Finish session" })).toBeNull();
  });
});

describe("logged rows: mid-session they recede, on a record they are the content", () => {
  const numeral = (name: RegExp) => screen.getByRole("button", { name }).querySelector(".num")!;
  const logged = () => allLogged(planned(), ["m2", "p2"]);

  it("today, in progress: logged rows are subdued, open ones bright", () => {
    store.data = { ...base(), sessions: [logged()] };
    renderTrain();
    expect(numeral(/^Edit Bench press set 1: /).className).toContain("text-mute");
    expect(numeral(/^Edit Bench press set 2: /).className).toContain("text-fg");
    expect(numeral(/^Edit Bench press set 2: /).className).not.toContain("text-fg-2");
    expect(numeral(/^Edit Pull-up set 1: /).className).toContain("text-mute");
    expect(numeral(/^Edit Pull-up set 2: /).className).toMatch(/text-fg(?!-)/);
  });

  it("today, finished: logged rows read a step brighter", () => {
    store.data = { ...base(), sessions: [{ ...logged(), completedAt: `${TODAY}T18:00:00.000Z` }] };
    renderTrain();
    expect(numeral(/^Edit Bench press set 1: /).className).toContain("text-fg-2");
    expect(numeral(/^Edit Bench press set 1: /).className).not.toContain("text-mute");
    expect(numeral(/^Edit Pull-up set 1: /).className).toContain("text-fg-2");
    // A set left open is still the bright one.
    expect(numeral(/^Edit Pull-up set 2: /).className).toMatch(/text-fg(?!-)/);
  });

  it("a past day, finished or not: the same", () => {
    const past = "2026-11-09";
    store.data = { ...base(), sessions: [allLogged(planned(past), ["p2"])] };
    renderTrain(`/train/${past}`);
    expect(numeral(/^Edit Bench press set 1: /).className).toContain("text-fg-2");
    expect(numeral(/^Edit Pull-up set 1: /).className).toContain("text-fg-2");
    expect(numeral(/^Edit Pull-up set 1: /).className).not.toContain("text-mute");
  });
});

describe("Train's header", () => {
  const link = () => screen.getByRole("link", { name: /^Program/ });
  /** What the link shows at a width: the full label from 360 px, the short one below. */
  const shown = (form: "wide" | "narrow") =>
    [...link().querySelectorAll("span")].find((el) => el.className.includes(form === "wide" ? "max-[359px]:hidden" : "min-[360px]:hidden"))
      ?.textContent ?? link().textContent;

  it("says where the week sits in plain words, as a link to the program", () => {
    renderTrain();
    expect(link().getAttribute("aria-label")).toBe("Program: Week 3 of 5");
    expect(link().getAttribute("href")).toBe("/program");
    expect(shown("wide")).toBe("Week 3 of 5");
    expect(document.body.textContent).not.toMatch(/C1 · W3\/5/);
  });

  it("on a narrow screen it shows the short form, each form hidden at the other width", () => {
    renderTrain();
    expect(shown("narrow")).toBe("Week 3");
    expect([...link().querySelectorAll("span")].map((el) => [el.textContent, el.className])).toEqual([
      ["Week 3 of 5", "max-[359px]:hidden"],
      ["Week 3", "min-[360px]:hidden"],
    ]);
  });

  it("names the deload week (narrow: Deload)", () => {
    store.data = { ...base(), sessions: [] };
    renderTrain("/train/2026-11-30");
    expect(link().getAttribute("aria-label")).toBe("Program: Deload week");
    expect([shown("wide"), shown("narrow")]).toEqual(["Deload week", "Deload"]);
  });

  it("leads with the cycle from the second one on (narrow: without the cycle's length)", () => {
    store.data = { ...base(), settings: { ...settings, program: { ...settings.program, cycleStartDate: "2026-10-05" } }, sessions: [] };
    renderTrain();
    expect(link().getAttribute("aria-label")).toBe("Program: Cycle 2 · Week 2 of 5");
    expect([shown("wide"), shown("narrow")]).toEqual(["Cycle 2 · Week 2 of 5", "Cycle 2 · Week 2"]);
  });

  it("is there before the first cycle starts too, saying when it does", () => {
    // The plan was pushed back a week: the cycle starts next Monday.
    store.data = { ...base(), settings: { ...settings, program: { ...settings.program, cycleStartDate: "2026-11-23" } }, sessions: [] };
    renderTrain();
    expect(link().getAttribute("aria-label")).toBe("Program: starts Mon Nov 23");
    expect(link().getAttribute("href")).toBe("/program");
    expect([shown("wide"), shown("narrow")]).toEqual(["Starts Mon Nov 23", "Starts Mon"]);
  });

  it("is there on a rest day and on a day from before the program", () => {
    store.data = { ...base(), sessions: [] };
    renderTrain("/train/2026-11-15");
    expect(screen.getByText(/No lifting was scheduled/)).toBeTruthy();
    expect(link().getAttribute("aria-label")).toBe("Program: Week 2 of 5");
    reload();
    renderTrain("/train/2026-10-27"); // before the cycle start, seen after it
    expect(link().getAttribute("aria-label")).toBe("Program: started Mon Nov 2");
  });

  it("tells Program where it came from", async () => {
    const user = userEvent.setup();
    store.data = { ...base(), sessions: [] };
    renderTrain("/train/2026-11-10");
    await user.click(link());
    expect(where()).toBe("/program");
    expect(navState()).toEqual({ from: "/train/2026-11-10" });
  });

  it("from today's Train the way back is /train", async () => {
    const user = userEvent.setup();
    renderTrain();
    await user.click(link());
    expect(navState()).toEqual({ from: "/train" });
  });
});

describe("Train and Program, together", () => {
  it("the header link opens Program, and Program's back control returns to the day it was opened from", async () => {
    const user = userEvent.setup();
    store.data = { ...base(), sessions: [] };
    renderTrain("/train/2026-11-10", { program: true });
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Pull");
    await user.click(screen.getByRole("link", { name: "Program: Week 2 of 5" }));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Program");
    const back = screen.getByRole("link", { name: /Back/ });
    expect(back.getAttribute("href")).toBe("/train/2026-11-10");
    await user.click(back);
    expect(where()).toBe("/train/2026-11-10");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Pull");
  });

  it("pushed back a week from Program in week 1, Train still links to Program and says when the program starts", async () => {
    const user = userEvent.setup();
    // Monday of week 1: the cycle starts today.
    store.data = { ...base(), settings: { ...settings, program: { ...settings.program, cycleStartDate: TODAY } }, sessions: [] };
    renderTrain("/train", { program: true });
    expect(screen.getByRole("list", { name: "Bench press sets" })).toBeTruthy();
    await user.click(screen.getByRole("link", { name: "Program: Week 1 of 5" }));
    await user.click(screen.getByRole("button", { name: "Start a week later" }));
    expect(store.data.settings.program.cycleStartDate).toBe("2026-11-23");
    await user.click(screen.getByRole("link", { name: /Back/ }));
    expect(where()).toBe("/train");
    // No main lift is calculated before the start — and it isn't for want of a max.
    expect(screen.queryByRole("list", { name: "Bench press sets" })).toBeNull();
    expect(screen.getByRole("link", { name: "Program: starts Mon Nov 23" })).toBeTruthy();
    expect(screen.getByText(/Your program starts Monday, Nov 23\./)).toBeTruthy();
    expect(screen.queryByText(/Set a max/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Set max/ })).toBeNull();
  });
});

describe("in place of a main lift", () => {
  const TUE = "2026-11-10"; // last Tuesday — Pull: deadlift
  const mainLift = () => within(screen.getByRole("heading", { level: 2, name: "Main lift" }).closest("section")!);

  it("before the program starts: when it starts, with a link to the program — not a max prompt (the lift has one)", async () => {
    const user = userEvent.setup();
    store.data = {
      ...base(),
      settings: { ...settings, program: { ...settings.program, cycleStartDate: "2026-11-23" } },
      maxEntries: [...maxEntries, { ...maxEntries[0]!, id: 2, exerciseId: DEADLIFT, valueLb: 405 }],
      sessions: [],
    };
    renderTrain(`/train/${TUE}`);
    expect(mainLift().getByText(/Your program starts Monday, Nov 23\./)).toBeTruthy();
    expect(screen.queryByText(/Set a max/)).toBeNull();
    const open = mainLift().getByRole("link", { name: "Open the program →" });
    expect(open.getAttribute("href")).toBe("/program");
    await user.click(open);
    expect(where()).toBe("/program");
    expect(navState()).toEqual({ from: `/train/${TUE}` });
  });

  it("before the program starts, without a max: still when it starts", () => {
    store.data = { ...base(), settings: { ...settings, program: { ...settings.program, cycleStartDate: "2026-11-23" } }, sessions: [] };
    renderTrain(`/train/${TUE}`);
    expect(mainLift().getByText(/Your program starts Monday, Nov 23\./)).toBeTruthy();
    expect(screen.queryByText(/Set a max/)).toBeNull();
  });

  it("the cycle is running and the day's lift has no max: the max prompt names that lift and opens its sheet", async () => {
    const user = userEvent.setup();
    store.data = { ...base(), sessions: [] };
    renderTrain(`/train/${TUE}`);
    expect(mainLift().getByText(/Set a max for Deadlift and the working sets calculate themselves\./)).toBeTruthy();
    expect(screen.queryByText(/Your program start/)).toBeNull();
    await user.click(mainLift().getByRole("button", { name: "Set max →" }));
    expect(screen.getByRole("dialog", { name: /Deadlift/ })).toBeTruthy();
  });

  it("a lift with its max just shows its sets", () => {
    store.data = { ...base(), maxEntries: [...maxEntries, { ...maxEntries[0]!, id: 2, exerciseId: DEADLIFT, valueLb: 405 }], sessions: [] };
    renderTrain(`/train/${TUE}`);
    expect(screen.getByRole("list", { name: "Deadlift sets" })).toBeTruthy();
    expect(screen.queryByText(/Set a max|Your program start/)).toBeNull();
  });
});

describe("a preview's footnote says only what's true", () => {
  it("accessories carried over and a main lift: both", () => {
    store.data = { ...base(), sessions: [{ ...planned("2026-11-09"), completedAt: "2026-11-09T18:00:00.000Z" }] };
    renderTrain("/train/2026-11-23");
    expect(screen.getByText("Carried over from your last Monday; main-lift loads use today's max and move with any AMRAP before then.")).toBeTruthy();
    expect(screen.queryByText(/Nothing to carry over yet/)).toBeNull();
  });

  it("nothing carried over: says so, and nothing claims a carry-over", () => {
    store.data = { ...base(), sessions: [] };
    renderTrain("/train/2026-11-23");
    expect(screen.getByText(/Nothing to carry over yet — the accessories you log on a Monday show up here\./)).toBeTruthy();
    expect(screen.queryByText(/Carried over from your last/)).toBeNull();
    // The main lift's note stands on its own.
    expect(screen.getByText("Main-lift loads use today's max and move with any AMRAP before then.")).toBeTruthy();
  });

  it("nothing carried over and no main lift: just that", () => {
    store.data = { ...base(), sessions: [] };
    renderTrain("/train/2026-11-20"); // Friday: carries, no main lift
    expect(screen.getByText(/Nothing to carry over yet/)).toBeTruthy();
    expect(screen.queryByText(/Carried over from your last|Main-lift loads/)).toBeNull();
  });
});

describe("exercise options", () => {
  it("lists actions by how often they're used: log, sets, superset, skip, edit exercise, remove", async () => {
    const user = userEvent.setup();
    renderTrain();
    await user.click(screen.getByRole("button", { name: "Pull-up options" }));
    const sheet = within(screen.getByRole("dialog", { name: "Pull-up" }));
    const names = sheet
      .getAllByRole("button")
      .map((b) => (b.getAttribute("aria-label") ?? b.textContent ?? "").trim())
      .filter((n) => n !== "Close");
    expect(names.map((n) => n.replace(/(Log remaining sets)\d+$/, "$1"))).toEqual([
      "Log remaining sets",
      "Edit set 1: 8 reps",
      "Delete set 1",
      "Edit set 2: 8 reps",
      "Delete set 2",
      expect.stringMatching(/^Superset with another exercise/),
      expect.stringMatching(/^Skip today/),
      expect.stringMatching(/^Edit exercise/),
      expect.stringMatching(/^Remove — also from future Mondays/),
    ]);
  });
});
