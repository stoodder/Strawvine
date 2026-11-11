/**
 * Progress → Strength, on its own: each target's line and bar by how far the lift is — no max yet,
 * part of the way, reached (gold, said in words) — and where the empty state sends you.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { defaultSettings } from "../../../shared/defaults";
import type { AppData } from "../../../shared/gamify";
import type { Exercise, MaxEntry, Settings } from "../../../shared/schemas";
import { StrengthView } from "./StrengthView";

const base: Settings = {
  ...defaultSettings({ bench: 1, deadlift: 2, backSquat: 3, frontSquat: 4, strictPress: 5 }, "2026-10-01"),
  onboarded: true,
};
const lift = (id: number, name: string, patch: Partial<Exercise> = {}): Exercise => ({
  id,
  name,
  category: "primary",
  tracksMax: true,
  measure: "reps",
  weighted: true,
  archived: false,
  ...patch,
});
const max = (id: number, exerciseId: number, date: string, valueLb: number): MaxEntry => ({
  id,
  exerciseId,
  date,
  valueLb,
  source: "manual",
  note: null,
  createdAt: `${date}T08:00:00.000Z`,
});
const target = (id: string, exerciseId: number, targetLb: number) => ({ id, exerciseId, targetLb, setOn: "2026-10-01" });

function show(patch: Partial<AppData>, strengthTargets: Settings["strengthTargets"] = []) {
  const onOpen = vi.fn();
  const data = {
    settings: { ...base, strengthTargets },
    days: [],
    exercises: [],
    maxEntries: [],
    sessions: [],
    seenAchievements: [],
    ...patch,
  } as unknown as AppData;
  render(
    <MemoryRouter>
      <StrengthView data={data} strong={false} onOpen={onOpen} />
    </MemoryRouter>,
  );
  return { onOpen };
}
const row = (name: RegExp) => screen.getByRole("button", { name });
const targetOf = (name: RegExp, id: string) => row(name).querySelector<HTMLElement>(`[data-target="${id}"]`)!;
/** A target's bar: its fill's width and colour class. */
const bar = (el: HTMLElement) => {
  const fill = el.querySelector<HTMLElement>(".rounded-full > .rounded-full")!;
  return { width: fill.style.width, gold: fill.classList.contains("bg-gold"), accent: fill.classList.contains("bg-accent") };
};

describe("StrengthView: a lift's targets", () => {
  const exercises = [lift(1, "Bench press"), lift(2, "Deadlift")];
  const maxEntries = [max(1, 1, "2026-10-01", 215), max(2, 1, "2026-10-20", 225)];

  it("a target for a lift without a max says so, on an empty bar — never '600 lb to go' from nothing", () => {
    show({ exercises, maxEntries }, [target("d", 2, 600)]);
    const t = targetOf(/^Deadlift/, "d");
    expect(t.textContent).toBe("Target 600no max yet");
    expect(bar(t)).toEqual({ width: "0%", gold: false, accent: true });
    expect(t.querySelector("svg")).toBeNull();
  });

  it("part of the way: what is left, on a lime bar filled that far", () => {
    show({ exercises, maxEntries }, [target("b", 1, 300)]);
    const t = targetOf(/^Bench press/, "b");
    expect(t.textContent).toBe("Target 30075 lb to go");
    expect(bar(t)).toEqual({ width: "75%", gold: false, accent: true });
    expect(t.querySelector("svg")).toBeNull();
  });

  it("reached: gold, a full bar and the word — at the target exactly, and past it", () => {
    show({ exercises, maxEntries }, [target("at", 1, 225), target("past", 1, 200)]);
    for (const id of ["at", "past"]) {
      const t = targetOf(/^Bench press/, id);
      expect(t.textContent).toBe(`Target ${id === "at" ? 225 : 200}reached`);
      expect(bar(t)).toEqual({ width: "100%", gold: true, accent: false });
      // The trophy is decoration (the word says it), in gold.
      const trophy = t.querySelector("svg")!;
      expect(trophy.classList.contains("lucide-trophy")).toBe(true);
      expect(trophy.getAttribute("aria-hidden")).toBe("true");
      expect(trophy.parentElement!.className).toContain("text-gold");
    }
  });

  it("lists a lift's targets lowest first, with half pounds when a target has them", () => {
    show({ exercises, maxEntries }, [target("hi", 1, 275), target("lo", 1, 232.5)]);
    expect([...row(/^Bench press/).querySelectorAll("[data-target]")].map((t) => t.textContent)).toEqual([
      "Target 232.57.5 lb to go",
      "Target 27550 lb to go",
    ]);
  });

  it("a row opens that lift's max sheet", () => {
    const { onOpen } = show({ exercises, maxEntries });
    fireEvent.click(row(/^Deadlift/));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen.mock.calls[0]![0]).toMatchObject({ id: 2, name: "Deadlift" });
  });
});

describe("StrengthView: no lift tracks a max", () => {
  it("points to the exercise library, which lives in Program — not in Settings", () => {
    show({ exercises: [lift(1, "Bench press", { tracksMax: false }), lift(2, "Old lift", { archived: true })] });
    const empty = screen.getByText(/No lift tracks a max yet/);
    expect(empty.textContent).toBe("No lift tracks a max yet. Turn on “tracks a max” for an exercise in Program’s exercise library.");
    expect(empty.textContent).not.toMatch(/Settings/);
    const link = screen.getByRole("link", { name: "Program’s exercise library" });
    expect(link.getAttribute("href")).toBe("/program#library");
    // No rows; the way to Goals stays.
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByRole("link", { name: "Set strength targets in Goals" }).getAttribute("href")).toBe("/goals");
  });

  it("says nothing of the sort once a lift does", () => {
    show({ exercises: [lift(1, "Bench press")] });
    expect(screen.queryByText(/No lift tracks a max yet/)).toBeNull();
    expect(row(/^Bench press/).textContent).toBe("Bench pressno max yet—");
  });
});
