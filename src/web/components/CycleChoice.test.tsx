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
  it("Repeat cycle 1 files the celebration and the choice together", () => {
    showCelebrations();
    act(() => store.set({ achievements: [cycle1] }));
    wait();
    expect(screen.queryByRole("button", { name: /^Continue/ })).toBeNull();
    act(() => screen.getByRole("button", { name: "Repeat cycle 1" }).click());
    expect(store.marked).toEqual([["cycle-1", "repeat-cycle-1"]]);
    expect(store.saved).toEqual([]);
  });

  it("Set up a new cycle starts the copy on this cycle's Monday and goes to Program; Undo removes it", () => {
    showCelebrations();
    act(() => store.set({ achievements: [cycle1] }));
    wait();
    act(() => screen.getByRole("button", { name: "Set up a new cycle" }).click());
    expect(store.marked).toEqual([["cycle-1"]]);
    const s = store.saved.at(-1)!;
    expect(s.program.cycleStartDate).toBe("2026-11-09");
    expect(s.program.earlierPlans!.map((p) => [p.id, p.start])).toEqual([["first", "2026-10-05"]]);
    expect(screen.getByTestId("where").textContent).toBe("/program#layout");
    expect(store.toasts.at(-1)!.message).toBe("New cycle set up from Mon Nov 9");
    act(() => store.toasts.at(-1)!.action!.onAction());
    expect(store.saved.at(-1)!.program).not.toHaveProperty("earlierPlans");
    expect(store.saved.at(-1)!.program.cycleStartDate).toBe("2026-10-05");
  });

  it("isn't offered once something is saved in the new cycle (or Repeat was chosen): just Continue", () => {
    store.sessions = [{ date: "2026-11-09", plannedFor: null } as unknown as Session];
    showCelebrations();
    act(() => store.set({ achievements: [cycle1] }));
    wait();
    expect(screen.queryByRole("button", { name: "Repeat cycle 1" })).toBeNull();
    expect(screen.getByRole("button", { name: /^Continue/ })).toBeTruthy();
  });
});

describe("the end-of-cycle note", () => {
  function Note() {
    const choice = useCycleChoice();
    return <CycleEndNote choice={choice} />;
  }

  it("in a cycle's last week: Repeat files the choice and the note goes; seen on another device, it never shows", () => {
    store.settings = { ...store.settings, program: { ...store.settings.program, cycleStartDate: "2026-10-12" } };
    // Cycle 1 runs Oct 12 – Nov 15: today (Nov 10) is its last week.
    const view = render(
      <MemoryRouter>
        <Note />
      </MemoryRouter>,
    );
    expect(document.querySelector("[data-cycle-end]")!.textContent).toContain("Cycle 1 ends Sun Nov 15.");
    act(() => screen.getByRole("button", { name: "Repeat cycle 1" }).click());
    expect(store.marked).toEqual([["repeat-cycle-1"]]);
    expect(document.querySelector("[data-cycle-end]")).toBeNull();
    view.unmount();
    // Another device: the mark arrived with the data.
    render(
      <MemoryRouter>
        <Note />
      </MemoryRouter>,
    );
    expect(document.querySelector("[data-cycle-end]")).toBeNull();
  });
});
