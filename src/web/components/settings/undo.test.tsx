/**
 * The shared settings Undo (components/settings/undo.ts), with the real toasts: Undo works on the
 * settings as they are when it is tapped — after the screen that raised it has gone, after other
 * changes — touching only its own fields; consecutive changes fold into one toast for as long as
 * the first is on offer; an Undo that no longer applies says so; focus returns to the control;
 * and "Cycle N complete" is held while a program change's Undo is on offer.
 */
import { act, render, screen } from "@testing-library/react";
import { MotionGlobalConfig } from "motion/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSettings } from "../../../shared/defaults";
import type { Settings } from "../../../shared/schemas";
import { cycleCelebrationsHeld, HOLD_GRACE_MS } from "../celebrationHold";
import { DockProvider } from "../Dock";
import { ToastProvider } from "../Toast";
import { CANT_UNDO, liveSettings, UNDO_MS, useSettingsUndo, type SettingsUndo } from "./undo";

/** The data layer's current copy: what `currentData()` returns. */
const live = vi.hoisted(() => ({ data: undefined as { settings: import("../../../shared/schemas").Settings } | undefined }));
vi.mock("../../lib/sync", () => ({ currentData: () => live.data }));

const base: Settings = {
  ...defaultSettings({ bench: 1, deadlift: 2, backSquat: 3, frontSquat: 4, strictPress: 5 }, "2026-11-02"),
  onboarded: true,
};
// No exit animations: a toast that has gone is out of the document at once.
MotionGlobalConfig.skipAnimations = true;
const saves: Settings[] = [];
const save = (next: Settings) => {
  saves.push(next);
  live.data = { settings: next };
};
/** Changes the steps target (as a screen would: save, then raise the Undo). */
const setSteps = (raise: Raise, to: number, extra: Partial<SettingsUndo<number>> = {}) => {
  const before = live.data!.settings.targets.steps;
  save({ ...live.data!.settings, targets: { ...live.data!.settings.targets, steps: to } });
  raise<number>({
    fold: { key: "steps", before, after: to },
    message: (from) => `Steps ${from} → ${to}`,
    undo: (now, from) => ({ ...now, targets: { ...now.targets, steps: from } }),
    ...extra,
  });
};

type Raise = ReturnType<typeof useSettingsUndo>;
let raise: Raise;
function Screen() {
  // A screen's stale copy: what it rendered with, never refreshed here.
  raise = useSettingsUndo(save, () => base);
  return <button type="button">the control</button>;
}
function mount() {
  function App({ screen: shown }: { screen: boolean }) {
    return (
      <DockProvider>
        <ToastProvider>{shown && <Screen />}</ToastProvider>
      </DockProvider>
    );
  }
  const view = render(<App screen />);
  return { leaveScreen: () => view.rerender(<App screen={false} />) };
}
const undoButtons = () => screen.queryAllByRole("button", { name: "Undo" });
/** How many Undo toasts are up, once a toast that was just replaced has left the document (a frame later). */
const undosOnOffer = async () => {
  await pass(50);
  return undoButtons().length;
};
const tapUndo = () => act(() => undoButtons().at(-1)!.click());
const status = () => screen.getByRole("status").textContent;
/** Lets deferred work run: the toast's onClose (a microtask) and timers up to `ms`. */
const pass = async (ms: number) => {
  await act(async () => {
    await Promise.resolve();
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  saves.length = 0;
  live.data = { settings: base };
});
afterEach(async () => {
  // Let every toast close and every hold lapse before the next test.
  await pass(120_000);
  vi.useRealTimers();
});

describe("liveSettings", () => {
  it("is the data layer's current copy, and the fallback only without one", () => {
    const other = { ...base, targets: { ...base.targets, steps: 1 } };
    expect(liveSettings(other)).toBe(base);
    live.data = undefined;
    expect(liveSettings(other)).toBe(other);
  });
});

describe("useSettingsUndo", () => {
  it("Undo changes only its own fields, on the settings as they are when it is tapped — even after the screen has gone", () => {
    const { leaveScreen } = mount();
    act(() => setSteps(raise, 12_000));
    expect(status()).toBe(`Steps ${base.targets.steps} → 12000`);
    // The person moves on, and something else in the document changes (here, or on another device).
    leaveScreen();
    const renamed = { ...live.data!.settings, program: { ...base.program, name: "Renamed since" } };
    live.data = { settings: renamed };
    tapUndo();
    expect(saves.at(-1)).toEqual({ ...renamed, targets: base.targets });
    expect(live.data.settings.program.name).toBe("Renamed since");
  });

  it("folds consecutive changes into one toast whose Undo goes back to before the first", async () => {
    mount();
    act(() => setSteps(raise, 12_000));
    act(() => vi.advanceTimersByTime(3000));
    act(() => setSteps(raise, 9000));
    expect(await undosOnOffer()).toBe(1);
    expect(status()).toBe(`Steps ${base.targets.steps} → 9000`);
    tapUndo();
    expect(live.data!.settings.targets.steps).toBe(base.targets.steps);
  });

  it("a change that ends up back where the folding began leaves nothing to undo", async () => {
    mount();
    act(() => setSteps(raise, 12_000));
    act(() => setSteps(raise, base.targets.steps));
    expect(await undosOnOffer()).toBe(0);
    // And the next change starts afresh.
    act(() => setSteps(raise, 8000));
    tapUndo();
    expect(live.data!.settings.targets.steps).toBe(base.targets.steps);
  });

  it("stops folding once the first Undo is no longer on offer: the next change gets its own, back to just before it", async () => {
    mount();
    act(() => setSteps(raise, 12_000));
    await pass(UNDO_MS + 100);
    expect(undoButtons()).toHaveLength(0);
    act(() => setSteps(raise, 9000));
    expect(status()).toBe("Steps 12000 → 9000");
    tapUndo();
    expect(live.data!.settings.targets.steps).toBe(12_000);
  });

  it("folds right up to the limit, and not at it", () => {
    mount();
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_000_000);
    act(() => setSteps(raise, 12_000));
    now.mockReturnValue(1_000_000 + UNDO_MS - 1);
    act(() => setSteps(raise, 11_000));
    expect(status()).toBe(`Steps ${base.targets.steps} → 11000`);
    now.mockReturnValue(1_000_000 + UNDO_MS - 1 + UNDO_MS);
    act(() => setSteps(raise, 10_000));
    expect(status()).toBe("Steps 11000 → 10000");
    now.mockRestore();
  });

  it("after Undo the folding starts over", async () => {
    mount();
    act(() => setSteps(raise, 12_000));
    tapUndo();
    act(() => setSteps(raise, 9000));
    expect(status()).toBe(`Steps ${base.targets.steps} → 9000`);
    expect(await undosOnOffer()).toBe(1);
  });

  it("changes with different keys, or none, don't fold", async () => {
    mount();
    act(() => setSteps(raise, 12_000));
    act(() => raise({ message: "Week 2 removed", undo: (now) => now }));
    expect(await undosOnOffer()).toBe(2);
  });

  it("an Undo that no longer applies saves nothing and says so", async () => {
    mount();
    act(() => setSteps(raise, 12_000, { undo: () => null }));
    const before = saves.length;
    tapUndo();
    expect(saves).toHaveLength(before);
    expect(status()).toBe(CANT_UNDO);
    expect(await undosOnOffer()).toBe(0);

    act(() => setSteps(raise, 9000, { fold: undefined, undo: () => null, cantUndo: "Can't undo: changed elsewhere." }));
    tapUndo();
    expect(status()).toBe("Can't undo: changed elsewhere.");
  });

  it("returns focus to the control that was undone", async () => {
    mount();
    const control = screen.getByRole("button", { name: "the control" });
    act(() => setSteps(raise, 12_000, { focus: () => control }));
    act(() => undoButtons()[0]!.focus());
    tapUndo();
    await pass(100);
    expect(document.activeElement).toBe(control);
  });

  it("leaves focus alone when the screen (and its control) has gone", async () => {
    const { leaveScreen } = mount();
    const control = screen.getByRole("button", { name: "the control" });
    act(() => setSteps(raise, 12_000, { focus: () => control }));
    leaveScreen();
    tapUndo();
    await pass(500);
    expect(document.activeElement).toBe(document.body);
    expect(live.data!.settings.targets.steps).toBe(base.targets.steps);
  });

  it("holds cycle celebrations while a program change's Undo is on offer, and a moment longer", async () => {
    mount();
    act(() => setSteps(raise, 12_000));
    expect(cycleCelebrationsHeld()).toBe(false);
    act(() => raise({ message: "Program delayed a week", undo: (now) => now, holdsCycleCelebrations: true }));
    expect(cycleCelebrationsHeld()).toBe(true);
    await pass(UNDO_MS - 100);
    expect(cycleCelebrationsHeld()).toBe(true);
    // The toast goes; the hold outlasts it by the grace period.
    await pass(200);
    expect(undoButtons()).toHaveLength(0);
    expect(cycleCelebrationsHeld()).toBe(true);
    await pass(HOLD_GRACE_MS);
    expect(cycleCelebrationsHeld()).toBe(false);
  });

  it("the hold outlasts a tapped Undo too, and folding keeps it without a gap", async () => {
    mount();
    const move = (to: number) =>
      act(() =>
        raise<number>({ fold: { key: "start", before: 0, after: to }, message: "moved", undo: (now) => now, holdsCycleCelebrations: true }),
      );
    move(1);
    await pass(3000);
    move(2);
    // The first toast was replaced: its release is pending, the second's hold is already in place.
    await pass(HOLD_GRACE_MS + 100);
    expect(cycleCelebrationsHeld()).toBe(true);
    tapUndo();
    await pass(HOLD_GRACE_MS - 100);
    expect(cycleCelebrationsHeld()).toBe(true);
    await pass(200);
    expect(cycleCelebrationsHeld()).toBe(false);
  });
});
