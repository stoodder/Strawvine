/**
 * Celebrations and the cycle achievements a program change can conjure up: "Cycle N complete"
 * moves with the cycle start, a seen mark can't be taken back — so a cycle is only ever marked
 * seen by a celebration that was shown and dismissed, never quietly, and not at all while a
 * program change's Undo is on offer.
 */
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Achievement } from "../../shared/gamify";
import { Celebrations } from "./Celebrations";
import { HOLD_GRACE_MS, holdCycleCelebrations } from "./celebrationHold";

// Thursday: last Sunday (Nov 1) is older than the three-day cutoff (Mon Nov 2).
const TODAY = "2026-11-05";

const store = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const state = {
    snapshot: { achievements: [] as import("../../shared/gamify").Achievement[], seen: [] as string[] },
    marked: [] as string[][],
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
      return { data: { seenAchievements: s.seen }, today: TODAY, achievements: s.achievements };
    },
    useMarkSeen: () => (keys: string[]) => {
      store.marked.push(keys);
      store.set({ seen: [...store.snapshot.seen, ...keys] });
    },
  };
});
vi.mock("../lib/haptics", () => ({ celebrate: vi.fn() }));

const cycle = (n: number, date: string): Achievement => ({
  key: `cycle-${n}`,
  title: `Cycle ${n} complete`,
  detail: "5 weeks banked.",
  date,
  tier: "milestone",
});
const steps = (date: string): Achievement => ({
  key: "steps-1000000",
  title: "1M steps",
  detail: "Lifetime steps logged.",
  date,
  tier: "milestone",
});

const derive = (...achievements: Achievement[]) => act(() => store.set({ achievements }));
/**
 * Time passes, a little at a time (so effects started by one timer run before the next is due).
 * The default is long enough for the overlay to find a calm moment (two checks) and arm its button.
 */
const wait = (ms = 2000) => {
  for (let left = ms; left > 0; left -= 50) act(() => void vi.advanceTimersByTime(Math.min(50, left)));
};
/**
 * The celebration on screen, if any. The app behind is inert exactly while one is up (a dismissed
 * overlay can linger in the document while it animates out, so its presence alone says nothing).
 */
const shown = () =>
  document.getElementById("root")!.hasAttribute("inert") ? [...document.querySelectorAll('[role="dialog"] h2')].at(-1)!.textContent : null;
const dismiss = () =>
  act(() =>
    screen
      .getAllByRole("button", { name: /^Continue/ })
      .at(-1)!
      .click(),
  );

let releases: Array<() => void> = [];
const hold = () => {
  const release = holdCycleCelebrations();
  releases.push(release);
  return () => act(() => release());
};

beforeEach(() => {
  vi.useFakeTimers();
  store.marked = [];
  store.snapshot = { achievements: [], seen: [] };
  releases = [];
  render(<Celebrations />);
});
afterEach(() => {
  for (const r of releases) r();
  vi.advanceTimersByTime(HOLD_GRACE_MS + 10);
  vi.useRealTimers();
});

describe("Celebrations", () => {
  it("celebrates a cycle that just ended; dismissing it is what marks it seen", () => {
    derive(cycle(1, "2026-11-04"));
    expect(store.marked).toEqual([]);
    wait();
    expect(shown()).toBe("Cycle 1 complete");
    expect(store.marked).toEqual([]);
    dismiss();
    expect(store.marked).toEqual([["cycle-1"]]);
  });

  it("quietly files an old achievement — but never a cycle's: its date moves with the program", () => {
    derive(steps("2026-10-20"), cycle(1, "2026-11-01"));
    wait();
    expect(shown()).toBeNull();
    expect(store.marked).toEqual([["steps-1000000"]]);
  });

  it("the reported case: skipping ahead makes last Sunday's cycle appear; Undo takes it away; the real completion still celebrates", () => {
    // Thursday of cycle 1's last week: "Skip ahead a week" dates the cycle's end last Sunday.
    const release = hold();
    derive(cycle(1, "2026-11-01"));
    wait();
    expect(shown()).toBeNull();
    expect(store.marked).toEqual([]);
    // Undo: the achievement is gone again, and nothing was filed for it.
    derive();
    release();
    wait(HOLD_GRACE_MS + 2000);
    expect(store.marked).toEqual([]);
    // Sunday, in effect: the cycle really ends, under the same key.
    derive(cycle(1, "2026-11-04"));
    wait();
    expect(shown()).toBe("Cycle 1 complete");
  });

  it("without the Undo the shifted-in cycle stays unfiled too (another device, a reload, a change of mind later)", () => {
    derive(cycle(1, "2026-11-01"));
    wait(10_000);
    expect(shown()).toBeNull();
    expect(store.marked).toEqual([]);
    // Moved back by hand, then completed for real.
    derive();
    derive(cycle(1, "2026-11-05"));
    wait();
    expect(shown()).toBe("Cycle 1 complete");
  });

  it("holds a recent cycle achievement while a program change's Undo is on offer: not shown, not marked", () => {
    // Tuesday-like case: the shifted cycle ended within the last three days.
    const release = hold();
    derive(cycle(1, "2026-11-03"));
    wait(6000);
    expect(shown()).toBeNull();
    expect(store.marked).toEqual([]);
    // Undone: it never shows.
    derive();
    release();
    wait(HOLD_GRACE_MS + 2000);
    expect(shown()).toBeNull();
    expect(store.marked).toEqual([]);
  });

  it("once the Undo is no longer on offer (and a moment more), a cycle that is still complete is celebrated", () => {
    const release = hold();
    derive(cycle(1, "2026-11-03"));
    wait(6000);
    release();
    wait(HOLD_GRACE_MS - 100);
    expect(shown()).toBeNull();
    wait(2000);
    expect(shown()).toBe("Cycle 1 complete");
    dismiss();
    expect(store.marked).toEqual([["cycle-1"]]);
  });

  it("the hold is for cycles only: other achievements go ahead", () => {
    hold();
    derive(cycle(1, "2026-11-04"), steps("2026-11-05"));
    wait();
    expect(shown()).toBe("1M steps");
    dismiss();
    expect(store.marked).toEqual([["steps-1000000"]]);
    wait();
    expect(shown()).toBeNull();
  });

  it("the hold covers a cycle celebration that was already waiting for a calm moment", () => {
    // A field has focus: nothing shows yet.
    const input = document.getElementById("root")!.appendChild(document.createElement("input"));
    input.focus();
    derive(cycle(1, "2026-11-04"));
    wait();
    expect(shown()).toBeNull();
    // The program is changed (its Undo on offer) before the moment comes.
    const release = hold();
    input.blur();
    wait(6000);
    expect(shown()).toBeNull();
    expect(store.marked).toEqual([]);
    release();
    wait(HOLD_GRACE_MS + 2000);
    expect(shown()).toBe("Cycle 1 complete");
  });
});
