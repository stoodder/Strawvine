/**
 * The pace slider commits once per gesture (the pace sets calorie targets: a caller saves on
 * commit, not on every tick), and a finger has to mean it: a touch that turns into a vertical
 * scroll never moves the thumb.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { PaceSlider } from "./PaceSlider";

function setup(opts: { initial?: number; live?: boolean } = {}) {
  const onCommit = vi.fn();
  const onChange = vi.fn();
  function Harness() {
    const [pace, setPace] = useState(opts.initial ?? 0.75);
    return (
      <PaceSlider
        value={pace}
        onChange={opts.live ? onChange : undefined}
        onCommit={(v) => {
          onCommit(v);
          setPace(v);
        }}
        limit={1}
        bodyweight={200}
        direction="lose"
      />
    );
  }
  render(<Harness />);
  const slider = screen.getByRole<HTMLInputElement>("slider", { name: /^Pace/ });
  /** One tick of the native control: the browser sets the value and fires `input`. */
  const tick = (v: number) => fireEvent.change(slider, { target: { value: String(v) } });
  const touch = (x: number, y: number) => ({ touches: [{ clientX: x, clientY: y }] });
  return { slider, onCommit, onChange, tick, touch, readout: () => slider.getAttribute("aria-valuetext") };
}

describe("PaceSlider", () => {
  it("shows the value in hand while dragging and commits once, on release", () => {
    const { slider, onCommit, tick, readout } = setup();
    fireEvent.pointerDown(slider);
    for (const v of [0.7, 0.65, 0.6]) tick(v);
    expect(onCommit).not.toHaveBeenCalled();
    expect(readout()).toBe("0.60% per week, about 1.2 lb");
    expect(screen.getByText(/0\.60%/)).toBeTruthy();
    // The mouse may be let go anywhere on the page.
    act(() => void window.dispatchEvent(new Event("pointerup")));
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(0.6);
    // Nothing left to commit: the click and blur that follow a release say nothing more.
    fireEvent.click(slider);
    fireEvent.blur(slider);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(readout()).toBe("0.60% per week, about 1.2 lb");
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
    const { slider, onCommit, tick, readout } = setup();
    fireEvent.pointerDown(slider);
    tick(0.5);
    tick(0.75);
    act(() => void window.dispatchEvent(new Event("pointerup")));
    expect(onCommit).not.toHaveBeenCalled();
    expect(readout()).toBe("0.75% per week, about 1.5 lb");
  });

  it("commits what is in hand when focus leaves mid-change", () => {
    const { slider, onCommit, tick } = setup();
    tick(0.5);
    fireEvent.blur(slider);
    expect(onCommit.mock.calls).toEqual([[0.5]]);
  });

  it("onChange follows every tick (onboarding's live preview)", () => {
    const { slider, onChange, onCommit, tick } = setup({ live: true });
    fireEvent.pointerDown(slider);
    tick(0.7);
    tick(0.65);
    expect(onChange.mock.calls).toEqual([[0.7], [0.65]]);
    act(() => void window.dispatchEvent(new Event("pointerup")));
    expect(onCommit.mock.calls).toEqual([[0.65]]);
  });

  describe("touch", () => {
    it("leaves vertical panning to the browser", () => {
      expect(setup().slider.className).toContain("touch-pan-y");
    });

    it("a touch that becomes a vertical scroll never moves the thumb or commits", () => {
      const { slider, onCommit, tick, touch, readout } = setup();
      fireEvent.touchStart(slider, touch(100, 300));
      // The browser may jump the thumb to the finger at once: held back until the finger shows intent.
      tick(0.3);
      expect(readout()).toBe("0.75% per week, about 1.5 lb");
      expect(slider.value).toBe("0.75");
      fireEvent.touchMove(slider, touch(102, 330));
      // Sideways drift during the scroll changes nothing either.
      tick(0.35);
      fireEvent.touchMove(slider, touch(140, 420));
      tick(0.5);
      fireEvent.touchEnd(slider, { touches: [] });
      expect(onCommit).not.toHaveBeenCalled();
      expect(readout()).toBe("0.75% per week, about 1.5 lb");
      expect(slider.value).toBe("0.75");
    });

    it("a drag along the track moves the thumb and commits once when the finger lifts", () => {
      const { slider, onCommit, tick, touch, readout } = setup();
      fireEvent.touchStart(slider, touch(200, 300));
      tick(0.7);
      expect(readout()).toBe("0.75% per week, about 1.5 lb");
      // Less than the threshold: still undecided.
      fireEvent.touchMove(slider, touch(196, 301));
      expect(readout()).toBe("0.75% per week, about 1.5 lb");
      // Along the track: the thumb catches up with what was held, then follows.
      fireEvent.touchMove(slider, touch(180, 303));
      expect(readout()).toBe("0.70% per week, about 1.4 lb");
      tick(0.6);
      tick(0.55);
      expect(readout()).toBe("0.55% per week, about 1.1 lb");
      expect(onCommit).not.toHaveBeenCalled();
      // Pointer events end first, then the touch: one commit between them.
      act(() => void window.dispatchEvent(new Event("pointerup")));
      fireEvent.touchEnd(slider, { touches: [] });
      expect(onCommit.mock.calls).toEqual([[0.55]]);
    });

    it("a tap on the track is meant: it sets the pace and commits", () => {
      const { slider, onCommit, tick, touch } = setup();
      fireEvent.touchStart(slider, touch(60, 300));
      tick(0.25);
      fireEvent.touchEnd(slider, { touches: [] });
      expect(onCommit.mock.calls).toEqual([[0.25]]);
    });

    it("after a touch ends, mouse and keyboard act at once again", () => {
      const { slider, onCommit, tick, touch } = setup();
      fireEvent.touchStart(slider, touch(100, 300));
      fireEvent.touchMove(slider, touch(100, 360));
      fireEvent.touchEnd(slider, { touches: [] });
      tick(0.5);
      fireEvent.keyUp(slider, { key: "ArrowLeft" });
      expect(onCommit.mock.calls).toEqual([[0.5]]);
    });
  });
});
