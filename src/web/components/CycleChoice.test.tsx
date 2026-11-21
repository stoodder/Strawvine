/**
 * The choice at the end of a cycle (SPEC §7) where "Cycle N complete" offers it: the cycle that just
 * ended, nothing saved in the new one yet. Repeat files the choice with the celebration; Set up a new
 * cycle starts a copy of the plan on this cycle's Monday and goes to Program, with an Undo.
 */
import { act, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Achievement } from "../../shared/gamify";
import type { Session, Settings } from "../../shared/schemas";
import { Celebrations } from "./Celebrations";
import { CycleEndNote } from "./program/CycleEndNote";
import { useCycleChoice } from "./program/useCycleChoice";

// Cycle 1 ran Oct 5 – Nov 8; today is cycle 2's Tuesday.
const TODAY = "2026-11-10";

const store = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const state = {
    snapshot: { achievements: [] as import("../../shared/gamify").Achievement[], seen: [] as string[] },
    settings: null as unknown as import("../../shared/schemas").Settings,
    sessions: [] as import("../../shared/schemas").Session[],
    marked: [] as string[][],
    saved: [] as import("../../shared/schemas").Settings[],
    toasts: [] as Array<{ message: string; onClose?: () => void; action?: { label: string; onAction: () => void } }>,
    listeners,
    set(patch: { achievements?: import("../../shared/gamify").Achievement[]; seen?: string[] }) {
      state.snapshot = { ...state.snapshot, ...patch };
      for (const l of listeners) l();
    },
  };
  return state;
});
vi.mock("../lib/store", async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (l: () => void) => (store.listeners.add(l), () => void store.listeners.delete(l));
  return {
    useData: () => {
      const s = useSyncExternalStore(subscribe, () => store.snapshot);
      return {
        data: { seenAchievements: s.seen, settings: store.settings, sessions: store.sessions, exercises: [], maxEntries: [], days: [] },
        today: TODAY,
        achievements: s.achievements,
      };
    },
    useMarkSeen: () => (keys: string[]) => {
      store.marked.push(keys);
      store.set({ seen: [...store.snapshot.seen, ...keys] });
    },
    useSaveSettings: () => (next: Settings) => {
      store.saved.push(next);
      store.settings = next;
      store.set({});
      return Promise.resolve(next);
    },
  };
});
vi.mock("../lib/sync", () => ({ currentData: () => ({ settings: store.settings, sessions: store.sessions }) }));
vi.mock("../lib/haptics", () => ({ celebrate: vi.fn() }));
vi.mock("./Toast", () => ({
  useToast: () => ({ show: (t: (typeof store.toasts)[number]) => store.toasts.push(t), dismiss: vi.fn() }),
}));

const cycle1: Achievement = { key: "cycle-1", title: "Cycle 1 complete", detail: "5 weeks banked.", date: "2026-11-08", tier: "milestone" };

function Where() {
  const { pathname, hash } = useLocation();
  return <output data-testid="where">{pathname + hash}</output>;
}
const wait = (ms = 2000) => {
  for (let left = ms; left > 0; left -= 50) act(() => void vi.advanceTimersByTime(Math.min(50, left)));
};

beforeEach(async () => {
  const { defaultSettings } = await import("../../shared/defaults");
  store.settings = { ...defaultSettings({ bench: 1, deadlift: 2, backSquat: 3, frontSquat: 4, strictPress: 5 }, "2026-10-01"), onboarded: true };
  store.sessions = [];
  store.marked = [];
  store.saved = [];
  store.toasts = [];
  store.snapshot = { achievements: [], seen: [] };
  vi.useFakeTimers();
});
afterEach(() => {
  // A toast that holds cycle celebrations releases them when it closes.
  for (const t of store.toasts) t.onClose?.();
  vi.advanceTimersByTime(5000);
  vi.useRealTimers();
});

const showCelebrations = () =>
  render(
    <MemoryRouter initialEntries={["/train"]}>
      <Routes>
        <Route path="*" element={<Where />} />
      </Routes>
      <Celebrations />
    </MemoryRouter>,
  );

describe("Cycle N complete with the choice", () => {
  it("Keep this plan files the celebration and the choice together, and says so (with a way to change it)", () => {
    showCelebrations();
    act(() => store.set({ achievements: [cycle1] }));
    wait();
    expect(screen.queryByRole("button", { name: /^Continue/ })).toBeNull();
    expect(document.querySelector("[data-cycle-choice]")!.textContent).toContain("For cycle 2:");
    // The default: focused first.
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Keep this plan" }));
    act(() => screen.getByRole("button", { name: "Keep this plan" }).click());
    expect(store.marked).toEqual([["cycle-1", "repeat-cycle-1"]]);
    expect(store.saved).toEqual([]);
    const toast = store.toasts.at(-1)!;
    expect([toast.message, toast.action?.label]).toEqual(["Cycle 2 keeps this plan", "Change"]);
    act(() => toast.action!.onAction());
    expect(screen.getByTestId("where").textContent).toBe("/program#now");
  });

  it("Set up a new plan starts the copy on this cycle's Monday and goes to Program; Undo removes it", () => {
    showCelebrations();
    act(() => store.set({ achievements: [cycle1] }));
    wait();
    act(() => screen.getByRole("button", { name: "Set up a new plan" }).click());
    expect(store.marked).toEqual([["cycle-1"]]);
    const s = store.saved.at(-1)!;
    expect(s.program.cycleStartDate).toBe("2026-11-09");
    expect(s.program.earlierPlans!.map((p) => [p.id, p.start])).toEqual([["first", "2026-10-05"]]);
    expect(screen.getByTestId("where").textContent).toBe("/program#layout");
    expect(store.toasts.at(-1)!.message).toBe("New plan set up from Mon Nov 9");
    act(() => store.toasts.at(-1)!.action!.onAction());
    expect(store.saved.at(-1)!.program).not.toHaveProperty("earlierPlans");
    expect(store.saved.at(-1)!.program.cycleStartDate).toBe("2026-10-05");
  });

  it("Undo of Set up a new plan declines once the new plan was changed: the edits stay", async () => {
    const { updatePlan } = await import("../../shared/plans");
    showCelebrations();
    act(() => store.set({ achievements: [cycle1] }));
    wait();
    act(() => screen.getByRole("button", { name: "Set up a new plan" }).click());
    const undo = store.toasts.at(-1)!;
    // Its steps target changed (here, or on another device) before Undo is tapped.
    const id = store.saved.at(-1)!.program.planId!;
    store.settings = updatePlan(store.settings, id, { targets: { steps: 9000, zone2Minutes: 30 } });
    const saves = store.saved.length;
    act(() => undo.action!.onAction());
    expect(store.saved.length).toBe(saves);
    expect(store.toasts.at(-1)!.message).toBe("Can't undo: the new plan was changed since.");
    expect(store.settings.targets.steps).toBe(9000);
  });

  it("isn't offered once something is saved in the new cycle (or Keep was chosen): just Continue", () => {
    store.sessions = [{ date: "2026-11-09", plannedFor: null } as unknown as Session];
    showCelebrations();
    act(() => store.set({ achievements: [cycle1] }));
    wait();
    expect(screen.queryByRole("button", { name: "Keep this plan" })).toBeNull();
    expect(screen.getByRole("button", { name: /^Continue/ })).toBeTruthy();
  });
});

describe("the end-of-cycle note", () => {
  function Note() {
    const choice = useCycleChoice();
    return (
      <>
        <h1 data-train-title="" tabIndex={-1}>
          Push
        </h1>
        <CycleEndNote choice={choice} />
      </>
    );
  }
  const lastWeek = () => {
    // Cycle 1 runs Oct 12 – Nov 15: today (Nov 10) is its last week.
    store.settings = { ...store.settings, program: { ...store.settings.program, cycleStartDate: "2026-10-12" } };
  };

  it("in a cycle's last week: Keep this plan files the choice, the note goes, focus goes to the title; seen on another device, it never shows", () => {
    lastWeek();
    const view = render(
      <MemoryRouter initialEntries={["/train"]}>
        <Note />
      </MemoryRouter>,
    );
    expect(document.querySelector("[data-cycle-end]")!.textContent).toBe("Cycle 1 ends Sun Nov 15.For cycle 2: Keep this plan · Set up a new plan");
    act(() => screen.getByRole("button", { name: "Keep this plan" }).click());
    expect(store.marked).toEqual([["repeat-cycle-1"]]);
    expect(document.querySelector("[data-cycle-end]")).toBeNull();
    expect(store.toasts.at(-1)!.message).toBe("Cycle 2 keeps this plan");
    wait(100);
    expect(document.activeElement).toBe(document.querySelector("[data-train-title]"));
    view.unmount();
    // Another device: the mark arrived with the data.
    render(
      <MemoryRouter>
        <Note />
      </MemoryRouter>,
    );
    expect(document.querySelector("[data-cycle-end]")).toBeNull();
  });

  it("Set up a new plan from the note starts the next cycle, even with nothing saved in this one", () => {
    lastWeek();
    render(
      <MemoryRouter initialEntries={["/train"]}>
        <Note />
        <Routes>
          <Route path="*" element={<Where />} />
        </Routes>
      </MemoryRouter>,
    );
    act(() => screen.getByRole("button", { name: "Set up a new plan" }).click());
    expect(store.saved.at(-1)!.program.cycleStartDate).toBe("2026-11-16");
    expect(store.toasts.at(-1)!.message).toBe("New plan set up from Mon Nov 16");
    expect(screen.getByTestId("where").textContent).toBe("/program#layout");
    // Now the note says what comes next.
    expect(document.querySelector("[data-cycle-end]")!.textContent).toBe("Cycle 1 ends Sun Nov 15.Next: a new plan from Mon Nov 16 · Review");
  });

  it("when no new plan can be set up, the tap says why instead of doing nothing", async () => {
    lastWeek();
    const { useCycleActions } = await import("./program/useCycleChoice");
    function SetUp() {
      const actions = useCycleActions();
      return (
        <button type="button" onClick={() => actions.setUpNewCycle()}>
          Set up
        </button>
      );
    }
    // Before the program starts: the plan itself is edited.
    store.settings = { ...store.settings, program: { ...store.settings.program, cycleStartDate: "2026-11-30" } };
    render(
      <MemoryRouter>
        <SetUp />
      </MemoryRouter>,
    );
    act(() => screen.getByRole("button", { name: "Set up" }).click());
    expect(store.saved).toEqual([]);
    expect(store.toasts.at(-1)).toMatchObject({ message: "The program hasn't started yet: change the plan itself on Program.", tone: "warn" });
  });
});
