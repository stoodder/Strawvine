/**
 * Goals: a pace change saves once per gesture and can be undone (the pace sets calorie targets),
 * the consistency heatmap explains its shades, and the header is named after the tab.
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addDays, dateRange } from "../../shared/dates";
import { defaultSettings } from "../../shared/defaults";
import { emptyDayLog } from "../../shared/empty";
import type { AppData } from "../../shared/gamify";
import type { Settings } from "../../shared/schemas";
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
