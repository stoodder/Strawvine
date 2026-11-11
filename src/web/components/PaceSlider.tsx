import clsx from "clsx";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Direction } from "../../shared/nutrition";
import { fmt } from "../lib/format";

/** The slowest pace on offer and the slider's step, % of bodyweight per week. */
const MIN = 0.1;
const STEP = 0.05;
/** The thumb's width (`range` in styles.css): its centre travels the track's width less this. */
const THUMB_PX = 18;
/** How far (px) a finger travels on the slider before it reads as a drag along it or a scroll past it. */
const INTENT_PX = 8;
/** A finger landing this close (px) to the thumb's centre has hold of the thumb: a tap there moves nothing. */
const GRAB_PX = 14;
/** After a touch, how long (ms) a change that comes without a key or a mouse is taken for the browser's echo of it. */
const ECHO_MS = 700;

/** A finger on the slider: where it landed, what it turned out to be doing, and the pace it would go back to. */
interface Touch {
  x: number;
  y: number;
  intent: "undecided" | "along" | "scroll";
  /** The finger's offset from the thumb's centre when it landed on the thumb (kept while dragging); null on the track. */
  grab: number | null;
  /** The caller's value when the finger landed. */
  from: number;
}

/** How far along its travel (0…1) the thumb sits for `value`. */
const fractionOf = (value: number, limit: number) => (limit > MIN ? Math.min(1, Math.max(0, (value - MIN) / (limit - MIN))) : 0);

/**
 * The pace under a point of the slider: the thumb's centre put at `clientX`, snapped to the step
 * (the last step at or under the limit is the top, as the native control has it). Null when the
 * slider has no room to travel.
 */
export function paceAt(clientX: number, box: { left: number; width: number }, limit: number): number | null {
  const travel = box.width - THUMB_PX;
  if (travel <= 0 || limit <= MIN) return null;
  const fraction = Math.min(1, Math.max(0, (clientX - box.left - THUMB_PX / 2) / travel));
  const steps = Math.round((fraction * (limit - MIN)) / STEP);
  const top = Math.floor((limit - MIN) / STEP + 1e-9);
  return +(MIN + Math.min(steps, top) * STEP).toFixed(2);
}

/**
 * The weekly pace, as a slider up to the athlete's limit.
 *
 * `onChange` follows every tick (onboarding's live preview). `onCommit` is called once per gesture
 * — when the finger or mouse lets go, or the key comes up — with the value it ended on, and only
 * when that differs from `value`: the pace sets calorie targets, so a caller that saves should save
 * on commit (and offer Undo), not on every tick. Meanwhile the slider shows the value in hand. A
 * change that comes with no gesture at all (a screen reader's increment) is its own gesture.
 *
 * A finger has to mean it, and is read here rather than left to the browser's own slider — those
 * differ (Chromium jumps the thumb to the finger the moment it lands; iOS Safari moves it only when
 * the 18 px thumb itself is grabbed, and never for a tap on the track), and none waits to see what
 * the finger is doing. So during a touch the native control's changes are ignored (React puts the
 * thumb back) and the pace comes from where the finger is: nothing until it has travelled
 * `INTENT_PX`; then, along the track, the thumb follows it (keeping its offset when the finger
 * landed on the thumb) and the pace commits when it lifts; down or up the page, it is a scroll
 * (`touch-action: pan-y`) and nothing changes. A tap on the track sets the pace there; a tap on
 * the thumb doesn't. A second finger, a cancelled touch, or the page scrolling under the finger
 * after all puts the pace back where it was. Mouse and keyboard act at once, through the native
 * control.
 */
export function PaceSlider({
  value,
  onChange,
  onCommit,
  limit,
  bodyweight,
  direction,
}: {
  value: number;
  onChange?: (v: number) => void;
  onCommit?: (v: number) => void;
  limit: number;
  bodyweight: number | null;
  direction: Direction;
}) {
  // The value in hand during a gesture: shown, not yet the caller's.
  const [draft, setDraft] = useState<number | null>(null);
  // The same value until the gesture ends and it is handed over (then null: nothing left to commit).
  const pending = useRef<number | null>(null);
  const touch = useRef<Touch | null>(null);
  // Until when a gesture-less change is the browser's echo of a touch (compatibility mouse events, a native `change`).
  const echoUntil = useRef(0);
  const keyHeld = useRef(false);
  const latest = useRef({ value, onChange, onCommit });
  useLayoutEffect(() => {
    latest.current = { value, onChange, onCommit };
  });
  // Once the caller's value moves (the commit landed, an Undo, another device), it is the truth again.
  useEffect(() => {
    if (pending.current === null) setDraft(null);
  }, [value]);

  const apply = (next: number) => {
    pending.current = next;
    setDraft(next);
    latest.current.onChange?.(next);
  };
  /** The gesture is over (called from every way one can end; only the first call after a change acts). */
  const end = useCallback(() => {
    const next = pending.current;
    pending.current = null;
    if (next === null) return;
    const { value: current, onCommit: commit } = latest.current;
    // Back where it started, or nobody to tell: nothing changed. Otherwise the draft stays up until `value` follows.
    if (next === current || !commit) setDraft(null);
    else commit(next);
  }, []);
  /** The gesture turned out not to be meant: back to `from`, nothing committed. */
  const abandon = (from: number) => {
    if (pending.current === null) return;
    pending.current = null;
    setDraft(null);
    // A caller that follows every tick (no draft of its own to fall back to) is told where it went back to.
    if (latest.current.value !== from) latest.current.onChange?.(from);
  };

  // A mouse can let go anywhere on the page.
  const released = useRef<(() => void) | null>(null);
  const untilRelease = () => {
    if (released.current) return;
    const done = () => {
      window.removeEventListener("pointerup", done);
      window.removeEventListener("pointercancel", done);
      released.current = null;
      end();
    };
    released.current = done;
    window.addEventListener("pointerup", done);
    window.addEventListener("pointercancel", done);
  };

  // While a finger is on the slider, the page scrolling means the finger is scrolling — whatever its first
  // few pixels looked like, and whichever way the browser made up its mind.
  const scrolled = useRef<(() => void) | null>(null);
  const stopWatchingScroll = () => {
    if (scrolled.current) window.removeEventListener("scroll", scrolled.current, true);
    scrolled.current = null;
  };
  /** The touch is not (or no longer) a slide: a scroll, a pinch. It is followed to its end, changing nothing. */
  const voidTouch = (t: Touch) => {
    t.intent = "scroll";
    abandon(t.from);
  };
  const watchScroll = () => {
    stopWatchingScroll();
    const onScroll = () => {
      const t = touch.current;
      if (t && t.intent !== "scroll") voidTouch(t);
    };
    scrolled.current = onScroll;
    window.addEventListener("scroll", onScroll, { capture: true, passive: true });
  };

  /**
   * A mouse press or a key means no finger is on the slider: should a touch's end ever have gone missing (it is
   * what lets the native control be followed again), the touch is over now.
   */
  const forgetTouch = () => {
    if (!touch.current) return;
    touch.current = null;
    stopWatchingScroll();
  };

  // Unmounted mid-gesture (the screen changed under the hand): what is in hand is handed over.
  useEffect(
    () => () => {
      stopWatchingScroll();
      touch.current = null;
      if (released.current) released.current();
      else end();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const v = Math.min(draft ?? value, limit);
  const lb = bodyweight ? (v / 100) * bodyweight : null;
  const fraction = fractionOf(v, limit);
  const atLimit = v >= limit;
  const verb = direction === "gain" ? "gain" : direction === "lose" ? "loss" : "change";
  const valueText = `${v.toFixed(2)}% per week${lb !== null ? `, about ${fmt(lb, 1)} lb` : ""}${atLimit ? ", at your limit" : ""}`;
  // The lime part of the track ends under the thumb's centre, wherever the thumb is.
  const filled = `calc(${THUMB_PX / 2}px + ${fraction} * (100% - ${THUMB_PX}px))`;
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <div className="label">Pace</div>
        <div className="num text-sm">
          {direction === "gain" ? "+" : direction === "lose" ? "−" : ""}
          {v.toFixed(2)}%<span className="text-mute">/wk</span>
          {lb !== null && <span className="ml-2 text-mute">≈ {fmt(lb, 1)} lb/wk</span>}
        </div>
      </div>
      {/* The visible track is 4px; the input on top of it is a 44px tap target. */}
      <div className="relative mt-1 h-11">
        <div
          aria-hidden
          className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full"
          style={{ background: `linear-gradient(90deg, var(--color-accent) ${filled}, rgba(255,255,255,0.12) ${filled})` }}
        />
        <input
          type="range"
          aria-label={`Pace, percent of bodyweight ${verb} per week`}
          aria-valuetext={valueText}
          min={MIN}
          max={limit}
          step={STEP}
          value={v}
          onChange={(e) => {
            // A finger is read from where it is (the touch handlers), not from what the browser's slider makes
            // of it — nor from the browser's echo of the touch afterwards. React puts the thumb back.
            if (touch.current) return;
            const gesture = released.current !== null || keyHeld.current;
            if (!gesture && performance.now() < echoUntil.current) return;
            apply(Number(e.target.value));
            // No mouse down, no key held: nothing will come to end this change (a screen reader's increment).
            if (!gesture) end();
          }}
          onTouchStart={(e) => {
            const p = e.touches.length === 1 ? e.touches[0] : undefined;
            if (!p) {
              // More than one finger down: a pinch, not a slide — followed to its end, changing nothing.
              if (touch.current) voidTouch(touch.current);
              else touch.current = { x: 0, y: 0, intent: "scroll", grab: null, from: latest.current.value };
              return;
            }
            const box = e.currentTarget.getBoundingClientRect();
            const offset = p.clientX - (box.left + THUMB_PX / 2 + fraction * (box.width - THUMB_PX));
            touch.current = {
              x: p.clientX,
              y: p.clientY,
              intent: "undecided",
              grab: Math.abs(offset) <= GRAB_PX ? offset : null,
              from: latest.current.value,
            };
            watchScroll();
          }}
          onTouchMove={(e) => {
            const t = touch.current;
            if (!t || t.intent === "scroll") return;
            const p = e.touches[0];
            if (e.touches.length !== 1 || !p) return voidTouch(t);
            if (t.intent === "undecided") {
              const dx = Math.abs(p.clientX - t.x);
              const dy = Math.abs(p.clientY - t.y);
              if (Math.max(dx, dy) < INTENT_PX) return;
              t.intent = dx > dy ? "along" : "scroll";
              if (t.intent === "scroll") return;
            }
            const next = paceAt(p.clientX - (t.grab ?? 0), e.currentTarget.getBoundingClientRect(), limit);
            if (next !== null && next !== (pending.current ?? latest.current.value)) apply(next);
          }}
          onTouchEnd={(e) => {
            const t = touch.current;
            // Over when the last finger on the slider has lifted.
            if (!t || e.targetTouches.length > 0) return;
            touch.current = null;
            stopWatchingScroll();
            // Fingers still down elsewhere: it was part of a pinch.
            if (e.touches.length > 0) abandon(t.from);
            else if (t.intent !== "scroll") {
              // A tap on the track (no travel) is meant; one on the thumb moves nothing.
              if (t.intent === "undecided" && t.grab === null) {
                const next = paceAt(e.changedTouches[0]?.clientX ?? t.x, e.currentTarget.getBoundingClientRect(), limit);
                if (next !== null && next !== latest.current.value) apply(next);
              }
              // The touch has been dealt with: no compatibility mouse events (they would move a native slider
              // again), and should the browser send them or a `change` all the same, they are an echo.
              echoUntil.current = performance.now() + ECHO_MS;
              if (e.cancelable) e.preventDefault();
            }
            end();
          }}
          onTouchCancel={() => {
            const t = touch.current;
            touch.current = null;
            stopWatchingScroll();
            // Taken over by the browser or the system (a scroll, a gesture, a call): not meant.
            if (t) abandon(t.from);
            end();
          }}
          // A finger is followed by the touch handlers alone (they end its gesture); the pointer path is the mouse's and the pen's.
          onPointerDown={(e) => {
            if (e.pointerType === "touch") return;
            forgetTouch();
            untilRelease();
          }}
          onKeyDown={() => {
            forgetTouch();
            keyHeld.current = true;
          }}
          onKeyUp={() => {
            keyHeld.current = false;
            end();
          }}
          onClick={end}
          onBlur={() => {
            keyHeld.current = false;
            end();
          }}
          // On a touch screen the thumb itself takes no touches: they land on the slider, where they are read
          // above — so a scroll that starts on the thumb is a scroll in iOS Safari too, whose own thumb would hold it.
          className="range absolute inset-0 h-11 w-full touch-pan-y pointer-coarse:[&::-webkit-slider-thumb]:pointer-events-none"
        />
      </div>
      {/* Readable ends (the limit is a number that matters); they wrap rather than collide when zoomed in. */}
      <div className="flex flex-wrap justify-between gap-x-3 text-xs text-mute">
        <span>Gentle</span>
        <span className={clsx(atLimit && "text-fg-2")}>{atLimit ? `At your limit · ${limit}%` : `Limit ${limit}%`}</span>
      </div>
    </div>
  );
}
