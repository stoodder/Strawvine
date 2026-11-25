/**
 * Swapping the main lift for one session on Train, against a (mocked, reactive) store: the sheet
 * from the main lift's "swap", the swapped lift's sets with the day's accessories kept, the Undo
 * (on the session as it is then), "Back to the planned lift", the refusal once a set is logged, and
 * the next day's derived "…was done Tue. Do Deadlift today?" line (held while a field is typed in).
 * A day whose plan has no main lift (Friday) takes one ("Add a main lift") and loses it again; a
 * lift without a max gets one on the way; "Another exercise" skips the main lift and adds one.
 */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSettings } from "../../shared/defaults";
import { cyclePosition, mainLiftSets } from "../../shared/program";
import type { Exercise, MaxEntry, Session, Settings } from "../../shared/schemas";
import { blankSet, buildSession, mainLiftSwap } from "../../shared/session";
import { DockProvider } from "../components/Dock";
import { forgetFolds } from "../components/train/folds";
import { TrainScreen } from "./Train";

interface Data {
  settings: Settings;
  exercises: Exercise[];
  sessions: Session[];
  maxEntries: MaxEntry[];
  seenAchievements: [];
}
interface ToastCall {
  message: string;
  action?: { label: string; onAction: () => void };
}
const store = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const s = {
    data: null as unknown as Data,
    today: "",
    listeners,
    toasts: [] as ToastCall[],
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
    useData: () => ({ data: useSyncExternalStore(subscribe, () => store.data), today: store.today }),
    cachedSession: (date: string) => store.data.sessions.find((s) => s.date === date) ?? null,
    useSaveSession: () => save,
    useDeleteSession: () => remove,
    useSaveSettings: () => vi.fn(),
    // A max saved shows at once (as the real store's local entry does).
    useAddMax: () => async (input: Omit<MaxEntry, "id" | "createdAt" | "note"> & { note?: string | null }) => {
      const entry: MaxEntry = { id: -1 - store.data.maxEntries.length, createdAt: "2026-11-17T10:00:00Z", ...input, note: input.note ?? null };
      store.set({ ...store.data, maxEntries: [...store.data.maxEntries, entry] });
      return entry;
    },
    useDeleteMax: () => vi.fn(),
    useCreateExercise: () => vi.fn(),
    useEditExercise: () => vi.fn(),
    useMarkSeen: () => vi.fn(),
    usePendingDates: () => new Set<string>(),
  };
});
vi.mock("../lib/sync", () => ({ currentData: () => store.data }));
vi.mock("../components/Toast", () => {
  let n = 0;
  const api = {
    show: (t: ToastCall) => {
      store.toasts.push(t);
      return ++n;
    },
    dismiss: () => {},
  };
  return { useToast: () => api };
});

const TUE = "2026-11-17"; // week 3 of the first cycle (it starts Monday 2026-11-02)
const WED = "2026-11-18";
const [BENCH, DEADLIFT, SQUAT, FRONT, PRESS, ROW] = [1, 2, 3, 4, 5, 20];
const settings = {
  ...defaultSettings({ bench: BENCH, deadlift: DEADLIFT, backSquat: SQUAT, frontSquat: FRONT, strictPress: PRESS }, "2026-11-02"),
  onboarded: true,
};
const ex = (o: Partial<Exercise> & Pick<Exercise, "id" | "name">): Exercise => ({
  category: "primary",
  tracksMax: true,
  measure: "reps",
  weighted: true,
  archived: false,
  ...o,
});
const exercises = [
  ex({ id: BENCH, name: "Bench press" }),
  ex({ id: DEADLIFT, name: "Deadlift" }),
  ex({ id: SQUAT, name: "Back squat" }),
  ex({ id: FRONT, name: "Front squat" }),
  ex({ id: PRESS, name: "Strict press" }),
  ex({ id: ROW, name: "Barbell row", category: "accessory", tracksMax: false }),
];
const max = (exerciseId: number, valueLb: number): MaxEntry => ({
  id: exerciseId,
  exerciseId,
  date: "2026-11-01",
  valueLb,
  source: "manual",
  note: null,
  createdAt: "2026-11-01T10:00:00.000Z",
});
const maxEntries = [max(BENCH, 225), max(DEADLIFT, 405), max(SQUAT, 315), max(PRESS, 135)];
/** Last Tuesday's Pull: a barbell-row accessory to carry. */
const lastPull: Session = {
  ...buildSession("2026-11-10", { settings, exercises, maxEntries, sessions: [] }),
  blocks: [
    {
      id: "row",
      kind: "accessory",
      exercises: [
        {
          exerciseId: ROW,
          measure: "reps",
          sets: [blankSet({ id: "r1", targetReps: 10, targetWeight: 135, reps: 10, weight: 135, done: true })],
        },
      ],
    },
  ],
  completedAt: "2026-11-10T18:00:00Z",
};

const renderTrain = (path = "/train") =>
  render(
    <DockProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/train" element={<TrainScreen />} />
          <Route path="/train/:date" element={<TrainScreen />} />
        </Routes>
      </MemoryRouter>
    </DockProvider>,
    { container: document.getElementById("root")! },
  );
const saved = (date: string) => store.data.sessions.find((s) => s.date === date);
const mainOf = (s: Session) => s.blocks.find((b) => b.kind === "primary")!.exercises[0]!;
const sheet = () => within(screen.getByRole("dialog", { name: "Swap the main lift" }));
const lastToast = () => store.toasts[store.toasts.length - 1]!;

window.scrollBy = () => {};
/** The app closed and opened again (a fresh page). */
const reload = () => {
  cleanup();
  document.body.innerHTML = '<div id="root"></div>';
};

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  forgetFolds();
  store.toasts.length = 0;
  store.today = TUE;
  store.data = { settings, exercises, sessions: [lastPull], maxEntries, seenAchievements: [] };
});

describe("swapping the main lift on Train", () => {
  it("swaps Tuesday's deadlift for the back squat: squat's sets from its max, Pull's accessories, an Undo", async () => {
    renderTrain();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Pull");
    expect(screen.getByRole("list", { name: "Deadlift sets" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Swap Deadlift for another lift" }));
    expect(
      sheet()
        .getAllByRole("button")
        .filter((b) => b.hasAttribute("data-swap-to"))
        .map((b) => b.getAttribute("aria-label")),
    ).toEqual(["Bench press · Mon", "Back squat · Wed", "Strict press · Thu", "Front squat · no max yet: set it first"]);
    await userEvent.click(sheet().getByRole("button", { name: "Back squat · Wed" }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Swap the main lift" })).toBeNull());
    const s = saved(TUE)!;
    expect(s.label).toBe("Pull");
    expect(mainOf(s).exerciseId).toBe(SQUAT);
    const week = cyclePosition(settings.program, TUE)!.week;
    expect(mainOf(s).sets.map((x) => x.targetWeight)).toEqual(
      mainLiftSets(settings.program, 315, week, { progressionDay: true }).map((p) => p.weightLb),
    );
    expect(s.blocks.filter((b) => b.kind === "accessory").map((b) => b.exercises[0]!.exerciseId)).toEqual([ROW]);
    expect(mainLiftSwap(s)).toEqual({ from: DEADLIFT, to: SQUAT });
    expect(screen.getByRole("list", { name: "Back squat sets" })).toBeTruthy();
    expect(document.querySelector("[data-swapped]")!.textContent).toBe("In place of Deadlift · this session only");

    // Undo: the swap was the only change to the day, so it is the plan (unsaved) again.
    expect(lastToast().message).toBe("Back squat in place of Deadlift today");
    act(() => lastToast().action!.onAction());
    expect(saved(TUE)).toBeUndefined();
    expect(screen.getByRole("list", { name: "Deadlift sets" })).toBeTruthy();
  });

  it("Undo keeps what was done since, and declines once the swapped lift has a logged set", async () => {
    renderTrain();
    await userEvent.click(screen.getByRole("button", { name: "Swap Deadlift for another lift" }));
    await userEvent.click(sheet().getByRole("button", { name: "Back squat · Wed" }));
    const undo = lastToast().action!.onAction;
    // A note written since (another device): Undo keeps it.
    act(() => store.set({ ...store.data, sessions: [lastPull, { ...saved(TUE)!, notes: "gym closes at 2" }] }));
    act(() => undo());
    expect(mainOf(saved(TUE)!).exerciseId).toBe(DEADLIFT);
    expect(saved(TUE)!.notes).toBe("gym closes at 2");

    // Swapped again, then a squat set logged: its Undo says why it can't.
    await userEvent.click(screen.getByRole("button", { name: "Swap Deadlift for another lift" }));
    await userEvent.click(sheet().getByRole("button", { name: "Back squat · Wed" }));
    const undo2 = lastToast().action!.onAction;
    await userEvent.click(screen.getByRole("button", { name: /^Back squat set 1: / }));
    expect(mainOf(saved(TUE)!).sets[0]!.done).toBe(true);
    act(() => undo2());
    expect(lastToast().message).toBe("Can't undo: a set of Back squat is logged");
    expect(mainOf(saved(TUE)!).exerciseId).toBe(SQUAT);
  });

  it("says why once a main-lift set is logged; nothing is swapped", async () => {
    renderTrain();
    await userEvent.click(screen.getByRole("button", { name: /^Deadlift set 1: / }));
    await userEvent.click(screen.getByRole("button", { name: "Swap Deadlift for another lift" }));
    expect(sheet().getByRole("status").textContent).toMatch(/^A set of Deadlift is logged\. Logged sets are never thrown away/);
    expect(sheet().queryByRole("button", { name: "Back squat · Wed" })).toBeNull();
    expect(mainOf(saved(TUE)!).exerciseId).toBe(DEADLIFT);
  });

  it("goes back to the planned lift from the sheet", async () => {
    renderTrain();
    await userEvent.click(screen.getByRole("button", { name: "Swap Deadlift for another lift" }));
    await userEvent.click(sheet().getByRole("button", { name: "Back squat · Wed" }));
    await userEvent.click(screen.getByRole("button", { name: "Swap Back squat for another lift" }));
    expect(sheet().queryByRole("button", { name: /^Back squat/ })).toBeNull();
    await userEvent.click(sheet().getByRole("button", { name: /Back to the planned lift/ }));
    expect(mainOf(saved(TUE)!).exerciseId).toBe(DEADLIFT);
    expect(mainLiftSwap(saved(TUE)!)).toBeNull();
    expect(document.querySelector("[data-swapped]")).toBeNull();
    expect(lastToast().message).toBe("Back to Deadlift");
  });

  it("Wednesday: 'Back squat was done Tue. Do Deadlift today?' builds Legs with the deadlift; gone once saved", async () => {
    renderTrain();
    await userEvent.click(screen.getByRole("button", { name: "Swap Deadlift for another lift" }));
    await userEvent.click(sheet().getByRole("button", { name: "Back squat · Wed" }));
    for (const s of mainOf(saved(TUE)!).sets) {
      if (s.amrap) continue;
      await userEvent.click(
        screen.getByRole("button", { name: new RegExp(`^Back squat set ${mainOf(saved(TUE)!).sets.indexOf(s) + 1}: `) }),
      );
    }
    act(() => {
      store.today = WED;
      store.set({ ...store.data });
    });
    reload();
    renderTrain(`/train/${WED}`);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Legs");
    const line = document.querySelector("[data-swap-suggestion]")!;
    expect(line.textContent).toBe("Back squat was done Tue. Do Deadlift today?");
    await userEvent.click(within(line as HTMLElement).getByRole("button", { name: "Do Deadlift today?" }));
    const wed = saved(WED)!;
    expect(wed.label).toBe("Legs");
    expect(mainOf(wed).exerciseId).toBe(DEADLIFT);
    expect(mainLiftSwap(wed)).toEqual({ from: SQUAT, to: DEADLIFT });
    expect(document.querySelector("[data-swap-suggestion]")).toBeNull();
  });

  it("Wednesday's line holds while the notes are typed in (the day saves under it), inert, and goes after", async () => {
    renderTrain();
    await userEvent.click(screen.getByRole("button", { name: "Swap Deadlift for another lift" }));
    await userEvent.click(sheet().getByRole("button", { name: "Back squat · Wed" }));
    await userEvent.click(screen.getByRole("button", { name: /^Back squat set 1: / }));
    act(() => {
      store.today = WED;
      store.set({ ...store.data });
    });
    reload();
    renderTrain(`/train/${WED}`);
    const line = () => document.querySelector("[data-swap-suggestion]");
    expect(line()!.textContent).toBe("Back squat was done Tue. Do Deadlift today?");
    const notes = screen.getByRole("textbox", { name: "Session notes" });
    await userEvent.click(notes);
    await userEvent.type(notes, "hotel gym");
    await waitFor(() => expect(saved(WED)?.notes).toBe("hotel gym"));
    // The day has a session now: the same line, nothing to tap.
    expect(line()!.textContent).toBe("Back squat was done Tue. Do Deadlift today?");
    expect(within(line() as HTMLElement).queryByRole("button")).toBeNull();
    expect(document.activeElement).toBe(notes);
    act(() => notes.blur());
    await waitFor(() => expect(line()).toBeNull());
  });

  it("a preview of Wednesday only says what was done", async () => {
    const tue = { ...buildSession(TUE, store.data), date: TUE };
    act(() => store.set({ ...store.data, sessions: [lastPull, tue] }));
    renderTrain();
    await userEvent.click(screen.getByRole("button", { name: "Swap Deadlift for another lift" }));
    await userEvent.click(sheet().getByRole("button", { name: "Back squat · Wed" }));
    await userEvent.click(screen.getByRole("button", { name: /^Back squat set 1: / }));
    reload();
    renderTrain(`/train/${WED}`);
    expect(document.querySelector("[data-swap-suggestion]")!.textContent).toBe("Back squat was done Tue.");
    expect(screen.queryByRole("button", { name: /Do Deadlift/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Swap / })).toBeNull();
  });
});

describe("adding a main lift to a day whose plan has none", () => {
  const FRI = "2026-11-20"; // week 3; Thursday's strict press not done
  const addSheet = () => within(screen.getByRole("dialog", { name: "Add a main lift" }));

  it("Friday: adds Strict press (still to do this week) from its max; remove, and Undo of both", async () => {
    store.today = FRI;
    renderTrain();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Carries & pull");
    expect(screen.queryByRole("button", { name: /^Swap / })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Add one for this session" }));
    expect(addSheet().getAllByRole("heading", { level: 4 })[0]!.textContent).toBe("Still to do this week");
    const first = addSheet()
      .getAllByRole("button")
      .find((b) => b.hasAttribute("data-swap-to"))!;
    expect(first.getAttribute("aria-label")).toBe("Strict press · Thu");
    await userEvent.click(first);

    const s = saved(FRI)!;
    expect(s.label).toBe("Carries & pull");
    expect(mainOf(s).exerciseId).toBe(PRESS);
    const week = cyclePosition(settings.program, FRI)!.week;
    expect(mainOf(s).sets.map((x) => [x.targetWeight, x.amrap])).toEqual(
      mainLiftSets(settings.program, 135, week, { progressionDay: false }).map((p) => [p.weightLb, false]),
    );
    expect(s.planSig).toBeNull();
    expect(screen.getByRole("list", { name: "Strict press sets" })).toBeTruthy();
    expect(document.querySelector("[data-added]")!.textContent).toBe("Added for this session");
    expect(screen.queryByRole("button", { name: "Add one for this session" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Skip Strict press/ })).toBeNull();
    expect(lastToast().message).toBe("Strict press added for this session");
    // Undo: the day as planned again (unsaved).
    act(() => lastToast().action!.onAction());
    expect(saved(FRI)).toBeUndefined();
    expect(screen.queryByRole("list", { name: "Strict press sets" })).toBeNull();

    // Added again, then removed from its header; Undo of the removal puts it back.
    await userEvent.click(screen.getByRole("button", { name: "Add one for this session" }));
    await userEvent.click(addSheet().getByRole("button", { name: "Strict press · Thu" }));
    await userEvent.click(screen.getByRole("button", { name: "Remove Strict press from this session" }));
    expect(lastToast().message).toBe("Strict press removed");
    expect(saved(FRI) && saved(FRI)!.blocks.some((b) => b.kind === "primary")).toBeFalsy();
    expect(screen.getByRole("button", { name: "Add one for this session" })).toBeTruthy();
    act(() => lastToast().action!.onAction());
    expect(mainOf(saved(FRI)!).exerciseId).toBe(PRESS);

    // A logged set: no remove (the swap's rule).
    await userEvent.click(screen.getByRole("button", { name: /^Strict press set 1: / }));
    expect(screen.queryByRole("button", { name: "Remove Strict press from this session" })).toBeNull();
  });

  it("a lift without a max: its max sheet opens from the row, and saving a max makes the swap", async () => {
    renderTrain();
    await userEvent.click(screen.getByRole("button", { name: "Swap Deadlift for another lift" }));
    await userEvent.click(sheet().getByRole("button", { name: "Front squat · no max yet: set it first" }));
    const maxSheet = within(screen.getByRole("dialog", { name: "Front squat" }));
    await userEvent.type(maxSheet.getByRole("textbox", { name: "New max" }), "275");
    await userEvent.click(maxSheet.getByRole("button", { name: "Set max and swap" }));
    await waitFor(() => expect(mainOf(saved(TUE)!).exerciseId).toBe(FRONT));
    const week = cyclePosition(settings.program, TUE)!.week;
    expect(mainOf(saved(TUE)!).sets.map((x) => x.targetWeight)).toEqual(
      mainLiftSets(settings.program, 275, week, { progressionDay: true }).map((p) => p.weightLb),
    );
    expect(saved(TUE)!.primaryMaxLb).toBe(275);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(lastToast().message).toBe("Front squat in place of Deadlift today");
    act(() => lastToast().action!.onAction());
    expect(saved(TUE)).toBeUndefined();
  });

  it("…closing the max sheet without a max goes back to the swap sheet; nothing swapped", async () => {
    renderTrain();
    await userEvent.click(screen.getByRole("button", { name: "Swap Deadlift for another lift" }));
    await userEvent.click(sheet().getByRole("button", { name: "Front squat · no max yet: set it first" }));
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Swap the main lift" })).toBeTruthy());
    expect(saved(TUE)).toBeUndefined();
  });

  it("'Another exercise' skips the main lift and opens Add exercise", async () => {
    renderTrain();
    await userEvent.click(screen.getByRole("button", { name: "Swap Deadlift for another lift" }));
    await userEvent.click(sheet().getByRole("button", { name: /^Another exercise/ }));
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Add exercise" })).toBeTruthy());
    expect(saved(TUE)!.blocks.find((b) => b.kind === "primary")!.skipped).toBe(true);
    expect(mainOf(saved(TUE)!).exerciseId).toBe(DEADLIFT);
  });
});
