/**
 * The Train screen after an exercise's measure changed (§6.5): a saved session shows an exercise
 * with nothing logged in the new measure without rewriting it; the first set logged writes the
 * shown measure and targets into that block only; a block with logged sets keeps its measure, and
 * its progression hint is read in that measure.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSettings } from "../../../shared/defaults";
import type { Exercise, Session, SetEntry, Settings } from "../../../shared/schemas";
import { blankSet, buildSession } from "../../../shared/session";
import { TrainScreen } from "../../screens/Train";

const store = vi.hoisted(() => ({
  data: null as unknown as { settings: Settings; exercises: Exercise[]; sessions: Session[]; maxEntries: []; seenAchievements: [] },
  save: vi.fn(),
}));
vi.mock("../../lib/store", () => ({
  useData: () => ({ data: store.data, today: TODAY }),
  cachedSession: (date: string) => store.data.sessions.find((s) => s.date === date) ?? null,
  useSaveSession: () => store.save,
  useDeleteSession: () => vi.fn(),
  useAddMax: () => vi.fn(),
  useDeleteMax: () => vi.fn(),
  useCreateExercise: () => vi.fn(),
  useEditExercise: () => vi.fn(),
  useMarkSeen: () => vi.fn(),
  usePendingDates: () => new Set<string>(),
}));
vi.mock("../../lib/sync", () => ({ currentData: () => store.data }));
vi.mock("../Toast", () => ({ useToast: () => ({ show: vi.fn(() => 1), dismiss: vi.fn() }) }));

const TODAY = "2026-11-16";
const ROWS = 30;
const settings = {
  ...defaultSettings({ bench: 1, deadlift: 2, backSquat: 3, frontSquat: 4, strictPress: 5 }, "2026-11-02"),
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
/** Rows, now timed (it used to be counted in reps). */
const exercises = [
  ex({ id: 1, name: "Bench press", category: "primary", tracksMax: true }),
  ex({ id: ROWS, name: "Rows", measure: "seconds" }),
];
const logged = (targetReps: number, reps: number, weight: number): SetEntry =>
  blankSet({ targetReps, targetWeight: weight, reps, weight, done: true });
const withRows = (date: string, sets: SetEntry[]): Session => ({
  ...buildSession(date, { settings, exercises: [], maxEntries: [], sessions: [] }),
  blocks: [{ id: `b-${date}`, kind: "accessory", exercises: [{ exerciseId: ROWS, measure: "reps", sets }] }],
});
/** Last Monday: every rep at 50 lb. */
const lastWeek = withRows("2026-11-09", [logged(12, 12, 50), logged(12, 12, 50)]);

const renderTrain = () =>
  render(
    <MemoryRouter initialEntries={["/train"]}>
      <Routes>
        <Route path="/train" element={<TrainScreen />} />
      </Routes>
    </MemoryRouter>,
    { container: document.getElementById("root")! },
  );
/** The sets' check controls (each row also has an "Edit Rows set N: …" values control). */
const rows = () => screen.getAllByRole("button", { name: /^Rows set \d/ });

beforeEach(() => {
  store.save.mockClear();
  localStorage.clear();
});

describe("Train after a measure change", () => {
  it("shows an unlogged block in the new measure, and logging writes it into that block", async () => {
    const today = withRows(TODAY, [
      blankSet({ id: "r1", targetReps: 8, targetWeight: 50 }),
      blankSet({ id: "r2", targetReps: 8, targetWeight: 50 }),
    ]);
    store.data = { settings, exercises, sessions: [lastWeek, today], maxEntries: [], seenAchievements: [] };
    renderTrain();
    expect(rows().map((b) => b.getAttribute("aria-label"))).toEqual(["Rows set 1: 30s at 50 lb", "Rows set 2: 30s at 50 lb"]);
    // Nothing saved by looking, and no hint from last week's reps for a timed block.
    expect(store.save).not.toHaveBeenCalled();
    expect(screen.queryByText(/Last time/)).toBeNull();

    await userEvent.setup().click(rows()[0]!);
    expect(store.save).toHaveBeenCalledTimes(1);
    const saved = store.save.mock.calls[0]![0] as Session;
    const block = saved.blocks.find((b) => b.id === `b-${TODAY}`)!.exercises[0]!;
    expect(block.measure).toBe("seconds");
    expect(block.sets.map((s) => [s.id, s.done, s.reps, s.targetReps, s.weight])).toEqual([
      ["r1", true, 30, 30, 50],
      ["r2", false, null, 30, null],
    ]);
  });

  it("keeps a block with a logged set in its measure, with the hint read in that measure", () => {
    const today = withRows(TODAY, [logged(12, 12, 50), blankSet({ targetReps: 12, targetWeight: 50 })]);
    store.data = { settings, exercises, sessions: [lastWeek, today], maxEntries: [], seenAchievements: [] };
    renderTrain();
    expect(rows().map((b) => b.getAttribute("aria-label"))).toEqual(["Rows set 1: 12 reps at 50 lb", "Rows set 2: 12 reps at 50 lb"]);
    // Last week's reps say something about today's reps: all met at 50 → try 55.
    expect(screen.getByText(/Last time/).textContent).toMatch(/50 lb · all reps → try 55/);
  });
});
