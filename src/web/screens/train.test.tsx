/**
 * The Train screen's set rows, end to end against a (mocked, reactive) store: the check logs and
 * unlogs at the targets, the values open the editor, an AMRAP's check opens its rep counter and a
 * weighted set without a load opens the editor instead of logging — no long press anywhere.
 * Plus what sits around the rows: Finish in the dock, the program link in the header and the
 * order of the exercise options.
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSettings } from "../../shared/defaults";
import type { Exercise, MaxEntry, Session, Settings } from "../../shared/schemas";
import { blankSet, buildSession } from "../../shared/session";
import { DockProvider } from "../components/Dock";
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
const PULL_UP = 20;
const CURL = 21;
const HANG = 22;
const settings = {
  ...defaultSettings({ bench: BENCH, deadlift: 2, backSquat: 3, frontSquat: 4, strictPress: 5 }, "2026-11-02"),
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

function renderTrain(path = "/train") {
  return render(
    <DockProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/train" element={<TrainScreen />} />
          <Route path="/train/:date" element={<TrainScreen />} />
          <Route path="/program" element={<h1>Program</h1>} />
        </Routes>
      </MemoryRouter>
    </DockProvider>,
    { container: document.getElementById("root")! },
  );
}
const today = () => store.data.sessions.find((s) => s.date === TODAY)!;
const setById = (id: string) =>
  today()
    .blocks.flatMap((b) => b.exercises)
    .flatMap((e) => e.sets)
    .find((s) => s.id === id)!;
const check = (name: RegExp) => screen.getByRole("button", { name });
const dock = () => within(screen.getByRole("region", { name: "Notifications" }));
const finishInDock = () => dock().queryByRole("button", { name: /^Finish · / });

// jsdom has no scrolling: revealing the next open set above the dock is a no-op here.
window.scrollBy = () => {};

beforeEach(() => {
  localStorage.clear();
  store.toasts.length = 0;
  store.data = { ...base(), sessions: [planned()] };
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

  it("the check logs a main-lift set at its targets, and unlogs it again", async () => {
    const user = userEvent.setup();
    renderTrain();
    const before = setById("m1");
    await user.click(check(/^Bench press set 1: /));
    expect(setById("m1")).toMatchObject({ done: true, reps: before.targetReps, weight: before.targetWeight });
    expect(check(/^Bench press set 1: /).getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(check(/^Bench press set 1: /));
    expect(setById("m1").done).toBe(false);
    expect(check(/^Bench press set 1: /).getAttribute("aria-pressed")).toBe("false");
  });

  it("the check logs an accessory set (with a short Undo toast), and unlogs it", async () => {
    const user = userEvent.setup();
    renderTrain();
    await user.click(check(/^Pull-up set 1: 8 reps$/));
    expect(setById("p1")).toMatchObject({ done: true, reps: 8, weight: null });
    expect(setById("p2").done).toBe(false);
    expect(store.toasts).toEqual(["Pull-up · set 1 logged"]);
    await user.click(check(/^Pull-up set 1: 8 reps$/));
    expect(setById("p1").done).toBe(false);
    expect(store.toasts).toEqual(["Pull-up · set 1 logged", "Pull-up · set 1 unlogged"]);
  });

  it("the values open the set editor and log nothing; saving a target there changes the row", async () => {
    const user = userEvent.setup();
    renderTrain();
    await user.click(screen.getByRole("button", { name: "Edit Pull-up set 1: 8 reps" }));
    const editor = within(screen.getByRole("dialog", { name: "Pull-up · set 1" }));
    expect(setById("p1").done).toBe(false);
    await user.click(editor.getByRole("button", { name: "Decrease reps" }));
    await user.click(editor.getByRole("button", { name: "Save target" }));
    expect(setById("p1")).toMatchObject({ done: false, targetReps: 7 });
    // The target carries to the open set after it.
    expect(setById("p2").targetReps).toBe(7);
    expect(await screen.findByRole("button", { name: "Edit Pull-up set 1: 7 reps" })).toBeTruthy();
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
    for (let i = 0; i < 4; i++) await user.click(editor.getByRole("button", { name: "Increase load" }));
    await user.click(editor.getByRole("button", { name: "Log set" }));
    expect(setById("c1")).toMatchObject({ done: true, reps: 10, weight: 20 });
    expect((await screen.findByRole("button", { name: "Curl set 1: 10 reps at 20 lb" })).getAttribute("aria-pressed")).toBe("true");
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

describe("Finish in the dock", () => {
  it("appears once a set is logged, with the count; the page's own button stays", async () => {
    const user = userEvent.setup();
    renderTrain();
    expect(finishInDock()).toBeNull();
    expect(screen.getByRole("button", { name: "Finish session" })).toHaveProperty("disabled", true);
    await user.click(check(/^Pull-up set 1: /));
    expect(finishInDock()!.textContent).toBe("Finish·1/8 sets");
    expect(finishInDock()!.getAttribute("aria-label")).toBe("Finish · 1/8 sets");
    expect(screen.getByRole("button", { name: "Finish session" })).toHaveProperty("disabled", false);
    // Unlogged again: nothing to finish.
    await user.click(check(/^Pull-up set 1: /));
    expect(finishInDock()).toBeNull();
  });

  it("asks about unlogged sets like the page's button (and steps aside while it asks), then finishes", async () => {
    const user = userEvent.setup();
    renderTrain();
    await user.click(check(/^Pull-up set 1: /));
    await user.click(finishInDock()!);
    const question = await screen.findByRole("group", { name: /Finish with 7 sets unlogged\?/ });
    expect(finishInDock()).toBeNull();
    expect(today().completedAt).toBeNull();
    await user.click(within(question).getByRole("button", { name: "Keep logging" }));
    await screen.findByRole("button", { name: "Finish session" });
    expect(finishInDock()).not.toBeNull();

    await user.click(finishInDock()!);
    await user.click(within(await screen.findByRole("group", { name: /unlogged\?/ })).getByRole("button", { name: "Finish" }));
    expect(today().completedAt).not.toBeNull();
    expect(await screen.findByRole("heading", { name: "Session complete" })).toBeTruthy();
    expect(finishInDock()).toBeNull();
  });

  it("finishes straight away when every set is logged", async () => {
    const user = userEvent.setup();
    const s = planned();
    const all: Session = {
      ...s,
      blocks: s.blocks.map((b) => ({
        ...b,
        exercises: b.exercises.map((e) => ({
          ...e,
          sets: e.sets.map((x) => ({ ...x, done: true, reps: x.targetReps, weight: x.targetWeight })),
        })),
      })),
    };
    store.data = { ...base(), sessions: [all] };
    renderTrain();
    expect(finishInDock()!.getAttribute("aria-label")).toBe("Finish · 8/8 sets");
    await user.click(finishInDock()!);
    expect(screen.queryByText(/unlogged\?/)).toBeNull();
    expect(today().completedAt).not.toBeNull();
    expect(finishInDock()).toBeNull();
  });

  it("is not offered on a finished session", () => {
    const s = planned();
    const first = s.blocks[0]!;
    const done: Session = {
      ...s,
      completedAt: `${TODAY}T18:00:00.000Z`,
      blocks: [
        { ...first, exercises: first.exercises.map((e) => ({ ...e, sets: e.sets.map((x) => ({ ...x, done: true, reps: 5, weight: 100 })) })) },
        ...s.blocks.slice(1),
      ],
    };
    store.data = { ...base(), sessions: [done] };
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

describe("Train's header", () => {
  it("says where the week sits in plain words, as a link to the program", () => {
    renderTrain();
    const link = screen.getByRole("link", { name: "Program: Week 3 of 5" });
    expect(link.getAttribute("href")).toBe("/program");
    expect(link.textContent).toBe("Week 3 of 5");
    expect(document.body.textContent).not.toMatch(/C1 · W3\/5/);
  });

  it("names the deload week", () => {
    store.data = { ...base(), sessions: [] };
    renderTrain("/train/2026-11-30");
    expect(screen.getByRole("link", { name: "Program: Deload week" })).toBeTruthy();
  });

  it("leads with the cycle from the second one on", () => {
    store.data = { ...base(), settings: { ...settings, program: { ...settings.program, cycleStartDate: "2026-10-05" } }, sessions: [] };
    renderTrain();
    expect(screen.getByRole("link", { name: "Program: Cycle 2 · Week 2 of 5" }).textContent).toBe("Cycle 2 · Week 2 of 5");
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
