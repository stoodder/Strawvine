/**
 * The pace slider commits once per gesture (the pace sets calorie targets: a caller saves on
 * commit, not on every tick), and a finger has to mean it: a touch is read from where the finger
 * is — never from what the browser's own slider makes of it — so one that turns into a vertical
 * scroll, a pinch or a cancelled touch never moves the thumb.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { paceAt, PaceSlider } from "./PaceSlider";

/** The slider's box in these tests: 198 px wide, so the 18 px thumb travels 180 px — 10 px per 0.05 step up to a limit of 1. */
const BOX = { left: 0, width: 198, top: 280, height: 44 };
/** Where the thumb's centre sits for a pace (limit 1). */
const xOf = (pace: number) => 9 + (pace - 0.1) * 200;
const Y = 300;

function setup(opts: { initial?: number; live?: boolean; follow?: boolean; limit?: number } = {}) {
  const onCommit = vi.fn();
  const onChange = vi.fn();
  function Harness() {
    const [pace, setPace] = useState(opts.initial ?? 0.75);
    return (
      <PaceSlider
        value={pace}
        // `follow`: the caller's value follows every tick and there is no commit (onboarding).
        onChange={
          opts.follow
            ? (v) => {
                onChange(v);
                setPace(v);
              }
            : opts.live
              ? onChange
              : undefined
        }
        onCommit={
          opts.follow
            ? undefined
            : (v) => {
                onCommit(v);
                setPace(v);
              }
        }
        limit={opts.limit ?? 1}
        bodyweight={200}
        direction="lose"
      />
    );
  }
  const view = render(<Harness />);
  const slider = screen.getByRole<HTMLInputElement>("slider", { name: /^Pace/ });
  slider.getBoundingClientRect = () =>
    ({ ...BOX, x: BOX.left, y: BOX.top, right: BOX.left + BOX.width, bottom: BOX.top + BOX.height, toJSON: () => BOX }) as DOMRect;
  /** One tick of the native control: the browser sets the value and fires `input`. */
  const tick = (v: number) => fireEvent.change(slider, { target: { value: String(v) } });
  type Point = [x: number, y: number];
  const list = (points: Point[]) => points.map(([clientX, clientY]) => ({ clientX, clientY }));
  /** Fingers on the screen after the event (`on`: those on the slider, by default all of them) and the one that changed. */
  const fingers = (down: Point[], changed: Point[], on: Point[] = down) => ({
    touches: list(down),
    targetTouches: list(on),
    changedTouches: list(changed),
  });
  const finger = {
    down: (x: number, y = Y) => fireEvent.touchStart(slider, fingers([[x, y]], [[x, y]])),
    move: (x: number, y = Y) => fireEvent.touchMove(slider, fingers([[x, y]], [[x, y]])),
    /** Returns false when the slider cancelled the event (it dealt with the touch itself). */
    up: (x: number, y = Y) => fireEvent.touchEnd(slider, fingers([], [[x, y]])),
    cancel: (x: number, y = Y) => fireEvent.touchCancel(slider, fingers([], [[x, y]])),
  };
  const releaseMouse = (type = "pointerup") => act(() => void window.dispatchEvent(new Event(type)));
  return {
    ...view,
    slider,
    onCommit,
    onChange,
    tick,
    finger,
    fingers,
    releaseMouse,
    readout: () => slider.getAttribute("aria-valuetext"),
  };
}

const AT_075 = "0.75% per week, about 1.5 lb";

describe("PaceSlider", () => {
  it("shows the value in hand while dragging and commits once, on release", () => {
    const { slider, onCommit, tick, readout, releaseMouse } = setup();
    fireEvent.pointerDown(slider);
    for (const v of [0.7, 0.65, 0.6]) tick(v);
    expect(onCommit).not.toHaveBeenCalled();
    expect(readout()).toBe("0.60% per week, about 1.2 lb");
    expect(screen.getByText(/0\.60%/)).toBeTruthy();
    // The mouse may be let go anywhere on the page.
    releaseMouse();
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(0.6);
    // Nothing left to commit: the click and blur that follow a release say nothing more.
    fireEvent.click(slider);
    fireEvent.blur(slider);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(readout()).toBe("0.60% per week, about 1.2 lb");
  });

  it("a cancelled mouse drag (pointercancel) hands over what is in hand, like a release", () => {
    const { slider, onCommit, tick, releaseMouse } = setup();
    fireEvent.pointerDown(slider);
    tick(0.6);
    releaseMouse("pointercancel");
    expect(onCommit.mock.calls).toEqual([[0.6]]);
    // The listeners are gone: a later release elsewhere on the page says nothing.
    releaseMouse();
    releaseMouse("pointercancel");
    expect(onCommit).toHaveBeenCalledTimes(1);
    // …and the next press is its own gesture.
    fireEvent.pointerDown(slider);
    tick(0.5);
    expect(onCommit).toHaveBeenCalledTimes(1);
    releaseMouse();
    expect(onCommit.mock.calls).toEqual([[0.6], [0.5]]);
  });

  it("keyboard: a held arrow key commits when the key comes up", () => {
    const { slider, onCommit, tick } = setup();
    for (const v of [0.8, 0.85, 0.9]) {
      fireEvent.keyDown(slider, { key: "ArrowRight" });
      tick(v);
    }
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.keyUp(slider, { key: "ArrowRight" });
    expect(onCommit.mock.calls).toEqual([[0.9]]);
    // The next press is its own gesture.
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    tick(0.95);
    fireEvent.keyUp(slider, { key: "ArrowRight" });
    expect(onCommit.mock.calls).toEqual([[0.9], [0.95]]);
  });

  it("commits nothing when the thumb ends where it started", () => {
    const { slider, onCommit, tick, readout, releaseMouse } = setup();
    fireEvent.pointerDown(slider);
    tick(0.5);
    tick(0.75);
    releaseMouse();
    expect(onCommit).not.toHaveBeenCalled();
    expect(readout()).toBe(AT_075);
  });

  it("commits what is in hand when focus leaves with a key still down", () => {
    const { slider, onCommit, tick } = setup();
    fireEvent.keyDown(slider, { key: "ArrowLeft" });
    tick(0.5);
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.blur(slider);
    expect(onCommit.mock.calls).toEqual([[0.5]]);
    // The key is no longer held as far as the slider knows: a later change is not waiting for it.
    tick(0.45);
    expect(onCommit.mock.calls).toEqual([[0.5], [0.45]]);
  });

  it("a change that comes with no gesture (a screen reader's increment) is committed at once, each on its own", () => {
    const { onCommit, tick, readout } = setup();
    tick(0.8);
    expect(onCommit.mock.calls).toEqual([[0.8]]);
    tick(0.85);
    expect(onCommit.mock.calls).toEqual([[0.8], [0.85]]);
    expect(readout()).toBe("0.85% per week, about 1.7 lb");
  });

  it("onChange follows every tick (onboarding's live preview)", () => {
    const { slider, onChange, onCommit, tick, releaseMouse } = setup({ live: true });
    fireEvent.pointerDown(slider);
    tick(0.7);
    tick(0.65);
    expect(onChange.mock.calls).toEqual([[0.7], [0.65]]);
    releaseMouse();
    expect(onCommit.mock.calls).toEqual([[0.65]]);
  });

  it("unmounted mid-drag, it hands over what is in hand and lets go of the page", () => {
    const removed = vi.spyOn(window, "removeEventListener");
    const { slider, onCommit, tick, unmount, releaseMouse } = setup();
    fireEvent.pointerDown(slider);
    tick(0.6);
    expect(onCommit).not.toHaveBeenCalled();
    const gone = () => removed.mock.calls.map(([type]) => type).filter((type) => type === "pointerup" || type === "pointercancel");
    expect(gone()).toEqual([]);
    unmount();
    expect(onCommit.mock.calls).toEqual([[0.6]]);
    // Its listeners for a release anywhere on the page are gone with it.
    expect(gone().sort()).toEqual(["pointercancel", "pointerup"]);
    releaseMouse();
    releaseMouse("pointercancel");
    expect(onCommit).toHaveBeenCalledTimes(1);
    removed.mockRestore();
  });

  it("stops listening to the page once the mouse is released: one pair of listeners per drag, taken off again", () => {
    const added = vi.spyOn(window, "addEventListener");
    const removed = vi.spyOn(window, "removeEventListener");
    const count = (spy: typeof added | typeof removed, type: string) => spy.mock.calls.filter(([t]) => t === type).length;
    const { slider, tick, releaseMouse } = setup();
    for (let drag = 1; drag <= 2; drag++) {
      fireEvent.pointerDown(slider);
      // A second pointerdown in the same drag (another button) adds nothing.
      fireEvent.pointerDown(slider);
      tick(0.7 - drag * 0.05);
      expect([count(added, "pointerup"), count(added, "pointercancel")]).toEqual([drag, drag]);
      expect([count(removed, "pointerup"), count(removed, "pointercancel")]).toEqual([drag - 1, drag - 1]);
      releaseMouse();
      expect([count(removed, "pointerup"), count(removed, "pointercancel")]).toEqual([drag, drag]);
    }
    added.mockRestore();
    removed.mockRestore();
  });

  it("the lime part of the track ends under the thumb's centre, at either end too", () => {
    const track = (s: { slider: HTMLInputElement }) => (s.slider.previousElementSibling as HTMLElement).getAttribute("style");
    const low = setup({ initial: 0.1 });
    expect(track(low)).toContain("calc(9px + 0 * (100% - 18px))");
    low.unmount();
    expect(track(setup({ initial: 1 }))).toContain("calc(9px + 1 * (100% - 18px))");
  });

  describe("paceAt: the pace under a point of the slider", () => {
    it("puts the thumb's centre at the point, snapped to the step", () => {
      expect(paceAt(xOf(0.75), BOX, 1)).toBe(0.75);
      expect(paceAt(xOf(0.75) + 4, BOX, 1)).toBe(0.75);
      expect(paceAt(xOf(0.75) + 6, BOX, 1)).toBe(0.8);
      expect(paceAt(xOf(0.3) - 4, BOX, 1)).toBe(0.3);
      // Offset boxes count from their left edge.
      expect(paceAt(120 + xOf(0.5), { left: 120, width: 198 }, 1)).toBe(0.5);
    });

    it("stops at the ends: the slowest pace, and the last step at or under the limit", () => {
      expect(paceAt(-50, BOX, 1)).toBe(0.1);
      expect(paceAt(4, BOX, 1)).toBe(0.1);
      expect(paceAt(198, BOX, 1)).toBe(1);
      expect(paceAt(900, BOX, 1)).toBe(1);
      // A limit between steps: the thumb's travel still spans up to it, the value stops a step short.
      expect(paceAt(900, BOX, 0.72)).toBe(0.7);
      // …also when the limit is nearer the next step than the last one (0.74 is not rounded up to 0.75).
      expect(paceAt(900, BOX, 0.74)).toBe(0.7);
      expect(paceAt(900, BOX, 0.5)).toBe(0.5);
    });

    it("is nothing for a slider with no room to travel, or no range", () => {
      expect(paceAt(50, { left: 0, width: 18 }, 1)).toBeNull();
      expect(paceAt(50, { left: 0, width: 0 }, 1)).toBeNull();
      expect(paceAt(50, BOX, 0.1)).toBeNull();
    });
  });

  describe("touch", () => {
    it("leaves vertical panning to the browser", () => {
      expect(setup().slider.className).toContain("touch-pan-y");
    });

    it("a touch that becomes a vertical scroll never moves the thumb or commits", () => {
      const { slider, onCommit, tick, finger, readout } = setup();
      finger.down(xOf(0.3));
      // The browser may jump its thumb to the finger at once (Chromium does): not ours to follow.
      tick(0.3);
      expect(readout()).toBe(AT_075);
      expect(slider.value).toBe("0.75");
      finger.move(xOf(0.3) + 2, Y + 30);
      // Sideways drift during the scroll changes nothing either.
      tick(0.35);
      finger.move(xOf(0.3) + 40, Y + 120);
      tick(0.5);
      // The scroll is the browser's: its touchend is left alone.
      expect(finger.up(xOf(0.3) + 40, Y + 120)).toBe(true);
      expect(onCommit).not.toHaveBeenCalled();
      expect(readout()).toBe(AT_075);
      expect(slider.value).toBe("0.75");
    });

    it("a drag from the thumb moves it with the finger — whatever the native control says — and commits once when the finger lifts", () => {
      const { slider, onCommit, tick, finger, readout, releaseMouse } = setup();
      // The finger lands on the thumb, 6 px right of its centre.
      const x = xOf(0.75) + 6;
      finger.down(x);
      tick(0.8);
      expect(readout()).toBe(AT_075);
      // Less than the threshold: still undecided.
      finger.move(x - 4, Y + 1);
      expect(readout()).toBe(AT_075);
      // Along the track: the thumb keeps its place under the finger — 10 px left is one step down. (Had the thumb
      // jumped its centre to the finger, it would sit 4 px from where it started: no step at all.)
      finger.move(x - 10, Y + 3);
      expect(readout()).toBe("0.70% per week, about 1.4 lb");
      finger.move(x - 50, Y + 3);
      expect(readout()).toBe("0.50% per week, about 1.0 lb");
      // What the native slider reports meanwhile is not followed: iOS Safari's and Chromium's differ.
      tick(0.9);
      expect(readout()).toBe("0.50% per week, about 1.0 lb");
      expect(slider.value).toBe("0.5");
      expect(onCommit).not.toHaveBeenCalled();
      // A release elsewhere on the page is the mouse's signal, not the finger's.
      releaseMouse();
      expect(onCommit).not.toHaveBeenCalled();
      // The touch is dealt with here: its touchend is cancelled, so no compatibility mouse events follow.
      expect(finger.up(x - 50, Y + 3)).toBe(false);
      expect(onCommit.mock.calls).toEqual([[0.5]]);
      fireEvent.click(slider);
      fireEvent.blur(slider);
      expect(onCommit).toHaveBeenCalledTimes(1);
    });

    it("a drag that starts on the track brings the thumb to the finger, then follows it", () => {
      const { onCommit, finger, readout } = setup();
      finger.down(xOf(0.3));
      finger.move(xOf(0.3) + 5);
      expect(readout()).toBe(AT_075);
      finger.move(xOf(0.3) + 30);
      expect(readout()).toBe("0.45% per week, about 0.9 lb");
      finger.move(xOf(0.2));
      expect(readout()).toBe("0.20% per week, about 0.4 lb");
      // Past the end of the track: the slowest pace.
      finger.move(-40);
      expect(readout()).toBe("0.10% per week, about 0.2 lb");
      finger.up(-40);
      expect(onCommit.mock.calls).toEqual([[0.1]]);
    });

    it("a drag back to where it started commits nothing", () => {
      const { onCommit, finger, readout } = setup();
      finger.down(xOf(0.75));
      finger.move(xOf(0.5));
      expect(readout()).toBe("0.50% per week, about 1.0 lb");
      finger.move(xOf(0.75));
      finger.up(xOf(0.75));
      expect(onCommit).not.toHaveBeenCalled();
      expect(readout()).toBe(AT_075);
    });

    it("a tap on the track is meant: it sets the pace there and commits once — the browser's echo of the tap adds nothing", () => {
      const { slider, onCommit, tick, finger, readout } = setup();
      finger.down(xOf(0.25) + 2);
      expect(onCommit).not.toHaveBeenCalled();
      expect(finger.up(xOf(0.25) + 2)).toBe(false);
      expect(onCommit.mock.calls).toEqual([[0.25]]);
      expect(readout()).toBe("0.25% per week, about 0.5 lb");
      // Compatibility mouse events (or a native `change`) right after: the native slider moving again is no new gesture.
      tick(0.3);
      fireEvent.click(slider);
      expect(onCommit).toHaveBeenCalledTimes(1);
      expect(readout()).toBe("0.25% per week, about 0.5 lb");
      // A key right after is real, though.
      fireEvent.keyDown(slider, { key: "ArrowRight" });
      tick(0.3);
      fireEvent.keyUp(slider, { key: "ArrowRight" });
      expect(onCommit.mock.calls).toEqual([[0.25], [0.3]]);
    });

    it("a tap on the thumb moves nothing", () => {
      const { onCommit, finger, readout } = setup();
      // 9 px off the thumb's centre: on the thumb, though nearer the next step.
      finger.down(xOf(0.75) + 9);
      expect(finger.up(xOf(0.75) + 9)).toBe(false);
      expect(onCommit).not.toHaveBeenCalled();
      expect(readout()).toBe(AT_075);
    });

    it("a cancelled touch (the system took it over) puts the pace back and commits nothing", () => {
      const { onCommit, finger, readout, tick, slider } = setup();
      finger.down(xOf(0.75));
      finger.move(xOf(0.5));
      expect(readout()).toBe("0.50% per week, about 1.0 lb");
      finger.cancel(xOf(0.5));
      expect(readout()).toBe(AT_075);
      expect(onCommit).not.toHaveBeenCalled();
      // The touch is over: the next gesture works as usual.
      fireEvent.keyDown(slider, { key: "ArrowLeft" });
      tick(0.7);
      fireEvent.keyUp(slider, { key: "ArrowLeft" });
      expect(onCommit.mock.calls).toEqual([[0.7]]);
    });

    it("a caller that follows every tick is told when a cancelled touch goes back", () => {
      const { onChange, finger, readout } = setup({ follow: true });
      finger.down(xOf(0.75));
      finger.move(xOf(0.6));
      finger.move(xOf(0.5));
      expect(onChange.mock.calls).toEqual([[0.6], [0.5]]);
      expect(readout()).toBe("0.50% per week, about 1.0 lb");
      finger.cancel(xOf(0.5));
      expect(onChange.mock.calls).toEqual([[0.6], [0.5], [0.75]]);
      expect(readout()).toBe(AT_075);
    });

    it("a second finger makes it a pinch: the pace goes back, and nothing more happens until every finger is up", () => {
      const { slider, onCommit, tick, finger, fingers, readout, releaseMouse } = setup();
      finger.down(xOf(0.75));
      finger.move(xOf(0.5));
      expect(readout()).toBe("0.50% per week, about 1.0 lb");
      const [a, b]: [[number, number], [number, number]] = [
        [xOf(0.5), Y],
        [xOf(0.9), Y],
      ];
      fireEvent.touchStart(slider, fingers([a, b], [b]));
      expect(readout()).toBe(AT_075);
      // Still two fingers, moving: not followed.
      fireEvent.touchMove(slider, fingers([[xOf(0.2), Y], b], [[xOf(0.2), Y]]));
      tick(0.2);
      expect(readout()).toBe(AT_075);
      // One lifts: the other is still on the slider.
      fireEvent.touchEnd(slider, fingers([b], [a]));
      fireEvent.touchMove(slider, fingers([[xOf(0.3), Y]], [[xOf(0.3), Y]]));
      expect(readout()).toBe(AT_075);
      fireEvent.touchEnd(slider, fingers([], [[xOf(0.3), Y]]));
      expect(onCommit).not.toHaveBeenCalled();
      expect(readout()).toBe(AT_075);
      // Every finger is up: the mouse is followed again.
      fireEvent.pointerDown(slider);
      tick(0.6);
      releaseMouse();
      expect(onCommit.mock.calls).toEqual([[0.6]]);
    });

    it("two fingers landing together are never a slide", () => {
      const { slider, onCommit, tick, fingers, readout } = setup();
      const pinch: [number, number][] = [
        [xOf(0.3), Y],
        [xOf(0.9), Y],
      ];
      fireEvent.touchStart(slider, fingers(pinch, pinch));
      tick(0.3);
      fireEvent.touchMove(slider, fingers(pinch, pinch));
      fireEvent.touchEnd(slider, fingers([], pinch));
      expect(onCommit).not.toHaveBeenCalled();
      expect(readout()).toBe(AT_075);
    });

    it("a second finger landing elsewhere on the screen mid-drag: seen in the next move, the pace goes back", () => {
      const { slider, onCommit, finger, fingers, readout } = setup();
      finger.down(xOf(0.75));
      finger.move(xOf(0.5));
      expect(readout()).toBe("0.50% per week, about 1.0 lb");
      // No touchstart reaches the slider for a finger that lands off it; the next touchmove lists both.
      const other: [number, number] = [100, 600];
      fireEvent.touchMove(slider, fingers([[xOf(0.45), Y], other], [[xOf(0.45), Y]], [[xOf(0.45), Y]]));
      expect(readout()).toBe(AT_075);
      fireEvent.touchMove(slider, fingers([[xOf(0.3), Y], other], [[xOf(0.3), Y]], [[xOf(0.3), Y]]));
      expect(readout()).toBe(AT_075);
      fireEvent.touchEnd(slider, fingers([other], [[xOf(0.3), Y]], []));
      expect(onCommit).not.toHaveBeenCalled();
      expect(readout()).toBe(AT_075);
    });

    it("a finger elsewhere on the screen as this one lifts: part of a pinch, nothing committed", () => {
      const { slider, onCommit, finger, fingers, readout } = setup();
      finger.down(xOf(0.75));
      finger.move(xOf(0.5));
      // The other finger never touched the slider: it shows only in `touches`.
      fireEvent.touchEnd(slider, fingers([[100, 600]], [[xOf(0.5), Y]], []));
      expect(onCommit).not.toHaveBeenCalled();
      expect(readout()).toBe(AT_075);
    });

    it("the page scrolling under the finger means it was a scroll after all: the pace goes back", () => {
      const { onCommit, finger, readout } = setup();
      finger.down(xOf(0.75));
      // Sideways first, by a hair…
      finger.move(xOf(0.75) - 12, Y + 10);
      expect(readout()).toBe("0.70% per week, about 1.4 lb");
      // …but the browser scrolls the page.
      act(() => void window.dispatchEvent(new Event("scroll")));
      expect(readout()).toBe(AT_075);
      finger.move(xOf(0.5), Y + 80);
      expect(readout()).toBe(AT_075);
      expect(finger.up(xOf(0.5), Y + 80)).toBe(true);
      expect(onCommit).not.toHaveBeenCalled();
      // Scrolling with no finger on the slider is nobody's business here.
      act(() => void window.dispatchEvent(new Event("scroll")));
      expect(readout()).toBe(AT_075);
    });

    it("a touch's own pointer events don't arm the mouse path", () => {
      const { slider, onCommit, finger, releaseMouse } = setup();
      fireEvent.pointerDown(slider, { pointerType: "touch" });
      finger.down(xOf(0.75));
      finger.move(xOf(0.5));
      // The browser sends pointerup before touchend: the finger's gesture isn't over yet.
      releaseMouse();
      expect(onCommit).not.toHaveBeenCalled();
      finger.up(xOf(0.5));
      expect(onCommit.mock.calls).toEqual([[0.5]]);
    });

    it("unmounted with a finger mid-drag, it hands over what is in hand and stops watching the page", () => {
      const removed = vi.spyOn(window, "removeEventListener");
      const { onCommit, finger, unmount } = setup();
      finger.down(xOf(0.75));
      finger.move(xOf(0.5));
      expect(onCommit).not.toHaveBeenCalled();
      unmount();
      expect(onCommit.mock.calls).toEqual([[0.5]]);
      expect(removed.mock.calls.some(([type]) => type === "scroll")).toBe(true);
      act(() => void window.dispatchEvent(new Event("scroll")));
      expect(onCommit).toHaveBeenCalledTimes(1);
      removed.mockRestore();
    });

    it("a touch whose end never arrived doesn't leave the slider deaf: a mouse press or a key is followed", () => {
      const removed = vi.spyOn(window, "removeEventListener");
      const { slider, onCommit, tick, finger, releaseMouse, readout } = setup();
      // A finger lands and drags… and no touchend or touchcancel ever comes.
      finger.down(xOf(0.75));
      finger.move(xOf(0.6));
      expect(readout()).toBe("0.60% per week, about 1.2 lb");
      // While the touch is (thought to be) on, the native control's changes are not followed.
      tick(0.3);
      expect(readout()).toBe("0.60% per week, about 1.2 lb");
      // A mouse press means no finger is on the slider: the touch is over (it stops watching the page) and the drag is followed.
      fireEvent.pointerDown(slider, { pointerType: "mouse" });
      expect(removed.mock.calls.some(([type]) => type === "scroll")).toBe(true);
      tick(0.4);
      expect(readout()).toBe("0.40% per week, about 0.8 lb");
      releaseMouse();
      expect(onCommit.mock.calls).toEqual([[0.4]]);
      // The same for a key.
      finger.down(xOf(0.4));
      fireEvent.keyDown(slider, { key: "ArrowRight" });
      tick(0.45);
      fireEvent.keyUp(slider, { key: "ArrowRight" });
      expect(onCommit.mock.calls).toEqual([[0.4], [0.45]]);
      removed.mockRestore();
    });

    it("after a touch that was a scroll, mouse and keyboard act at once again", () => {
      const { slider, onCommit, tick, finger } = setup();
      finger.down(xOf(0.3));
      finger.move(xOf(0.3), Y + 60);
      finger.up(xOf(0.3), Y + 60);
      fireEvent.keyDown(slider, { key: "ArrowLeft" });
      tick(0.5);
      fireEvent.keyUp(slider, { key: "ArrowLeft" });
      expect(onCommit.mock.calls).toEqual([[0.5]]);
    });
  });
});
