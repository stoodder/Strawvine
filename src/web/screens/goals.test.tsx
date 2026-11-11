/**
 * Goals: a pace change saves once per gesture and can be undone (the pace sets calorie targets),
 * the consistency heatmap explains its shades, and the header is named after the tab.
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addDays, dateRange } from "../../shared/dates";
import { defaultSettings } from "../../shared/defaults";
import { emptyDayLog } from "../../shared/empty";
import type { AppData } from "../../shared/gamify";
import type { Settings } from "../../shared/schemas";
import { UNDO_MS } from "../components/settings/undo";
import type { ToastInput } from "../components/Toast";
import { GoalsScreen } from "./Goals";

const TODAY = "2026-11-03";

/** A tiny live store: saving settings re-renders the screen, as the real one does. */
const store = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const state = {
    data: null as unknown as import("../../shared/gamify").AppData,
    saves: [] as import("../../shared/schemas").Settings[],
    listeners,
    save(s: import("../../shared/schemas").Settings) {
      state.saves.push(s);
      state.data = { ...state.data, settings: s };
      for (const l of listeners) l();
      return Promise.resolve(s);
    },
  };
  return state;
});
const toasts = vi.hoisted(() => ({ shown: [] as Array<{ id: number; toast: import("../components/Toast").ToastInput }>, dismissed: [] as number[] }));

vi.mock("../lib/store", async () => {
  const { useSyncExternalStore } = await import("react");
  const { buildModel } = await import("../../shared/insights");
  const { streaks } = await import("../../shared/gamify");
  const subscribe = (l: () => void) => (store.listeners.add(l), () => void store.listeners.delete(l));
  return {
    useData: () => {
      const data = useSyncExternalStore(subscribe, () => store.data);
      return { data, today: TODAY, model: buildModel(data, TODAY), streak: streaks(data, TODAY), achievements: [] };
    },
    useSaveSettings: () => store.save,
  };
});
// The data layer's current copy: what an Undo reads when it is tapped (components/settings/undo.ts).
vi.mock("../lib/sync", () => ({ currentData: () => store.data }));
vi.mock("../components/Toast", () => ({
  useToast: () => ({
    show: (toast: ToastInput) => {
      const id = toasts.shown.length + 1;
      toasts.shown.push({ id, toast });
      return id;
    },
    dismiss: (id: number) => void toasts.dismissed.push(id),
  }),
}));

const base = { ...defaultSettings({ bench: 1, deadlift: 2, backSquat: 3, frontSquat: 4, strictPress: 5 }, "2026-10-01"), onboarded: true };
const cutting: Settings = { ...base, weightGoal: { targetLb: 190, pacePctPerWeek: 0.75, setOn: addDays(TODAY, -21), startLb: 201.5 } };

beforeEach(() => {
  store.saves.length = 0;
  toasts.shown.length = 0;
  toasts.dismissed.length = 0;
  store.data = {
    settings: cutting,
    // Three weeks of weigh-ins (a trend above the goal: a cut), calories only on some days.
    days: dateRange(addDays(TODAY, -21), TODAY).map((date, i) => ({
      ...emptyDayLog(date),
      weightLb: 200,
      calories: i % 2 ? 2800 : null,
    })),
    exercises: [],
    maxEntries: [],
    sessions: [],
    seenAchievements: [],
  } as AppData;
});

const show = () =>
  render(
    <MemoryRouter>
      <GoalsScreen />
    </MemoryRouter>,
  );
const pace = () => store.data.settings.weightGoal?.pacePctPerWeek;
const slider = () => screen.getByRole<HTMLInputElement>("slider", { name: /^Pace/ });
/** One drag: press, the ticks the browser fires on the way, release. */
function drag(...ticks: number[]) {
  fireEvent.pointerDown(slider());
  for (const v of ticks) fireEvent.change(slider(), { target: { value: String(v) } });
  act(() => void window.dispatchEvent(new Event("pointerup")));
}

describe("Goals header", () => {
  it("is titled after the tab, with the tagline as its eyebrow", () => {
    show();
    const h1 = screen.getByRole("heading", { level: 1 });
    expect(h1.textContent).toBe("Goals");
    expect(h1.previousElementSibling!.textContent).toBe("The why");
    // The shared screen header: the title size that shrinks on a narrow phone, like Today's and Train's.
    expect(h1.closest("header")).not.toBeNull();
    expect(h1.className).toContain("text-[clamp(1.75rem,11vw,2.75rem)]");
  });
});

describe("Goals pace", () => {
  it("saves once per gesture, not per tick, and says what it set", () => {
    show();
    expect(slider().value).toBe("0.75");
    fireEvent.pointerDown(slider());
    for (const v of [0.7, 0.65, 0.6]) fireEvent.change(slider(), { target: { value: String(v) } });
    // Mid-drag: shown, not saved, no toast.
    expect(slider().getAttribute("aria-valuetext")).toMatch(/^0\.60% per week/);
    expect(store.saves).toHaveLength(0);
    expect(toasts.shown).toHaveLength(0);
    act(() => void window.dispatchEvent(new Event("pointerup")));
    expect(store.saves).toHaveLength(1);
    expect(pace()).toBe(0.6);
    // The rest of the goal is untouched.
    expect(store.saves[0]!.weightGoal).toEqual({ ...cutting.weightGoal, pacePctPerWeek: 0.6 });
    expect(toasts.shown).toHaveLength(1);
    expect(toasts.shown[0]!.toast.message).toBe("Pace set to −0.60%/wk");
    expect(toasts.shown[0]!.toast.action?.label).toBe("Undo");
    expect(slider().value).toBe("0.6");
  });

  it("Undo restores the previous pace", () => {
    show();
    drag(0.7, 0.5);
    expect(pace()).toBe(0.5);
    act(() => toasts.shown[0]!.toast.action!.onAction());
    expect(pace()).toBe(0.75);
    expect(store.saves).toHaveLength(2);
    expect(slider().value).toBe("0.75");
    expect(slider().getAttribute("aria-valuetext")).toMatch(/^0\.75% per week/);
    // Only the pace went back: other settings as they are now.
    expect(store.data.settings).toEqual(cutting);
  });

  it("a drag that ends where it began saves nothing and shows no toast", () => {
    show();
    drag(0.5, 0.75);
    expect(store.saves).toHaveLength(0);
    expect(toasts.shown).toHaveLength(0);
  });

  it("nudging again while the toast is up replaces it; its Undo goes back to where the nudging began", () => {
    show();
    drag(0.7);
    drag(0.65);
    expect(toasts.shown.map((t) => t.toast.message)).toEqual(["Pace set to −0.70%/wk", "Pace set to −0.65%/wk"]);
    expect(toasts.dismissed).toEqual([1]);
    act(() => toasts.shown[1]!.toast.action!.onAction());
    expect(pace()).toBe(0.75);
    // Nudged back to the start: nothing left to undo, the toast goes.
    drag(0.6);
    drag(0.75);
    expect(pace()).toBe(0.75);
    expect(toasts.shown).toHaveLength(3);
    expect(toasts.dismissed).toEqual([1, 3]);
  });

  it("Undo leaves a goal alone that was cleared meanwhile", () => {
    show();
    drag(0.5);
    act(() => void store.save({ ...store.data.settings, weightGoal: null }));
    const saves = store.saves.length;
    act(() => toasts.shown[0]!.toast.action!.onAction());
    expect(store.saves).toHaveLength(saves);
    expect(store.data.settings.weightGoal).toBeNull();
  });

  describe("Undo, later", () => {
    let clock = 0;
    beforeEach(() => {
      clock = Date.parse("2026-11-03T10:00:00Z");
      vi.spyOn(Date, "now").mockImplementation(() => clock);
    });
    afterEach(() => vi.restoreAllMocks());

    it("after leaving Goals, puts back only the pace: what changed since stays", () => {
      const view = show();
      drag(0.5);
      view.unmount();
      // On another screen (or another device) the steps target changes.
      const edited = { ...store.data.settings, targets: { ...store.data.settings.targets, steps: 12_000 } };
      act(() => void store.save(edited));
      act(() => toasts.shown[0]!.toast.action!.onAction());
      expect(store.data.settings).toEqual({ ...edited, weightGoal: cutting.weightGoal });
      expect(store.data.settings.targets.steps).toBe(12_000);
    });

    it("Goal cleared and target removed undo the same way after leaving", () => {
      const target = { id: "t1", exerciseId: 1, targetLb: 300, setOn: TODAY };
      store.data = {
        ...store.data,
        settings: { ...cutting, strengthTargets: [target] },
        exercises: [{ id: 1, name: "Bench press", category: "primary", tracksMax: true, measure: "reps", weighted: true, archived: false }],
      } as AppData;
      const view = show();
      fireEvent.click(screen.getByRole("button", { name: "Remove Bench press target" }));
      fireEvent.click(screen.getByRole("button", { name: "Clear goal" }));
      expect(toasts.shown.map((t) => t.toast.message)).toEqual(["Bench press target removed", "Goal cleared"]);
      expect(store.data.settings).toMatchObject({ weightGoal: null, strengthTargets: [] });
      view.unmount();
      const edited = { ...store.data.settings, targets: { ...store.data.settings.targets, steps: 12_000 } };
      act(() => void store.save(edited));
      act(() => toasts.shown[1]!.toast.action!.onAction());
      act(() => toasts.shown[0]!.toast.action!.onAction());
      expect(store.data.settings).toEqual({ ...edited, weightGoal: cutting.weightGoal, strengthTargets: [target] });
    });

    it("Undo of Goal cleared leaves a goal alone that was set since", () => {
      show();
      fireEvent.click(screen.getByRole("button", { name: "Clear goal" }));
      const newer = { ...cutting.weightGoal!, targetLb: 185 };
      act(() => void store.save({ ...store.data.settings, weightGoal: newer }));
      const saves = store.saves.length;
      act(() => toasts.shown[0]!.toast.action!.onAction());
      expect(store.saves).toHaveLength(saves);
      expect(store.data.settings.weightGoal).toEqual(newer);
      expect(toasts.shown.at(-1)!.toast).toMatchObject({ tone: "warn" });
      expect(toasts.shown.at(-1)!.toast.action).toBeUndefined();
    });

    it("a goal cleared meanwhile: the pace Undo says it can't, and saves nothing", () => {
      show();
      drag(0.5);
      act(() => void store.save({ ...store.data.settings, weightGoal: null }));
      act(() => toasts.shown[0]!.toast.action!.onAction());
      expect(toasts.shown.at(-1)!.toast).toMatchObject({ message: "Can't undo: the goal was cleared since.", tone: "warn" });
    });

    it("nudges fold only while the first Undo is on offer: after that, Undo goes back to the pace before the later nudge", () => {
      show();
      drag(0.7);
      // Just inside the window: folded (the first toast is replaced, Undo would go back to 0.75).
      clock += UNDO_MS - 1;
      drag(0.65);
      expect(toasts.dismissed).toEqual([1]);
      // A full window later: a nudge of its own.
      clock += UNDO_MS;
      drag(0.6);
      expect(toasts.dismissed).toEqual([1]);
      expect(toasts.shown).toHaveLength(3);
      act(() => toasts.shown[2]!.toast.action!.onAction());
      expect(pace()).toBe(0.65);
    });

    it("the toast stays as long as the folding lasts", () => {
      show();
      drag(0.7);
      expect(toasts.shown[0]!.toast.duration).toBe(UNDO_MS);
    });

    it("returns focus to the pace slider after Undo", async () => {
      show();
      drag(0.5);
      expect(document.activeElement).not.toBe(slider());
      act(() => toasts.shown[0]!.toast.action!.onAction());
      await waitFor(() => expect(document.activeElement).toBe(slider()));
    });
  });

  it("a build names its pace with a plus", () => {
    store.data = { ...store.data, settings: { ...cutting, weightGoal: { ...cutting.weightGoal!, targetLb: 210, startLb: 198 } } };
    show();
    drag(0.25);
    expect(toasts.shown[0]!.toast.message).toBe("Pace set to +0.25%/wk");
  });
});

describe("Goals consistency heatmap", () => {
  it("has a legend naming each shade, with a sample of it", () => {
    const { container } = show();
    const legend = screen.getByRole("list", { name: "Legend" });
    const items = within(legend).getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual(["Nothing logged", "Partly done", "Closed", "Today"]);
    // Words beside swatches (decoration: hidden from assistive tech), not colour alone.
    for (const li of items) expect(li.querySelector("[aria-hidden]")).not.toBeNull();
    // It sits under the grid it explains.
    const grid = container.querySelector('[role="group"][aria-label^="Closed days"]')!;
    expect(grid.compareDocumentPosition(legend) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The samples are the cells' own fills.
    const fills = (el: Element) => [...el.querySelectorAll<HTMLElement>("[style]")].map((s) => s.style.background || s.style.backgroundColor);
    const cellFills = new Set(fills(grid));
    expect(fills(items[0]!)[0]).toBe("rgba(255, 255, 255, 0.06)");
    expect(cellFills.has(fills(items[0]!)[0]!)).toBe(true);
    expect(fills(items[2]!)[0]).toBe("var(--color-accent)");
  });
});

describe("Goals: the pace while today's target is held at the minimum calorie target", () => {
  /** Three weeks at 200 lb eating `kcal` every day: a TDEE of `kcal`. */
  const eating = (kcal: number, settings: Settings) => {
    store.data = { ...store.data, settings, days: store.data.days.map((d) => ({ ...d, calories: kcal })) };
  };
  const fast: Settings = { ...cutting, weightGoal: { ...cutting.weightGoal!, pacePctPerWeek: 1 } };
  const note = () => document.querySelector<HTMLElement>("[data-floor-note]");

  it("says under the slider what the target is built for instead: the slider still shows the pace that was chosen", () => {
    eating(1900, fast);
    show();
    expect(screen.getByRole("slider").getAttribute("aria-valuetext")).toContain("1.00% per week, about 2.0 lb");
    expect(note()!.textContent).toBe("Your calorie target is held at your 1,500 kcal minimum, so it is built for −0.8 lb/wk for now.");
    expect(note()!.className).toContain("text-mute");
    expect(note()!.className).not.toMatch(/text-(warn|caution|gold|accent|faint)/);
    // Right under the slider, in its block.
    expect(note()!.parentElement!.querySelector('input[type="range"]')).not.toBeNull();
  });

  it("says the cut is on hold when the minimum leaves no deficit", () => {
    eating(1400, fast);
    show();
    expect(note()!.textContent).toBe("Your calorie target is held at your 1,500 kcal minimum, so the cut is on hold for now.");
  });

  it("on hold from a minimum a few kcal under the TDEE too, where the rate would print as 0.0", () => {
    eating(1510, fast);
    show();
    expect(note()!.textContent).toBe("Your calorie target is held at your 1,500 kcal minimum, so the cut is on hold for now.");
    eating(1530, fast);
    show();
    expect([...document.querySelectorAll("[data-floor-note]")].at(-1)!.textContent).toBe(
      "Your calorie target is held at your 1,500 kcal minimum, so it is built for −0.1 lb/wk for now.",
    );
    expect(document.body.textContent).not.toMatch(/[−-]0\.0/);
  });

  it("projects no date at pace while the target is held: only the observed trend's, when there is one", () => {
    const projected = () => screen.queryByText("Projected")?.parentElement?.textContent ?? null;
    // A flat trend has no observed date. Standing on its own, the pace gives one…
    eating(2800, fast);
    let view = show();
    expect(projected()).toMatch(/^Projected[A-Z][a-z]{2} \d/);
    view.unmount();
    // …held, there is none to give: not at the pace, not years out at what the minimum leaves of it.
    for (const kcal of [1900, 1530, 1510, 1400]) {
      eating(kcal, fast);
      view = show();
      expect(projected(), `${kcal}`).toBeNull();
      view.unmount();
    }
    // With a trend that is moving, its date stays, alone.
    store.data = {
      ...store.data,
      settings: fast,
      days: store.data.days.map((d, i) => ({ ...d, weightLb: 203 - i / 7, calories: 1400 })),
    };
    show();
    expect(note()).not.toBeNull();
    expect(projected()).toMatch(/^Projected[A-Z][a-z]{2} \d{1,2}(, \d{4})?actual −1\.0 lb\/wk$/);
  });

  it("follows the pace: slowed until the target stands on its own, the line goes", () => {
    eating(1900, fast);
    show();
    expect(note()).not.toBeNull();
    // 0.2%/week at 200 lb is 0.4 lb/week, 200 kcal/day: a 1,700 kcal target.
    act(() => void store.save({ ...fast, weightGoal: { ...fast.weightGoal!, pacePctPerWeek: 0.2 } }));
    expect(note()).toBeNull();
  });

  it("says nothing while the target stands on its own", () => {
    eating(2800, fast);
    show();
    expect(note()).toBeNull();
  });
});
