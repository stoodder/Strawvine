import clsx from "clsx";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Direction } from "../../shared/nutrition";
import { fmt } from "../lib/format";

/** How far (px) a finger travels on the slider before it reads as a drag along it or a scroll past it. */
const INTENT_PX = 8;

/** A finger on the slider: where it landed, what it turned out to be doing, and the value held back meanwhile. */
interface Touch {
  x: number;
  y: number;
  intent: "undecided" | "along" | "scroll";
  held: number | null;
}

/**
 * The weekly pace, as a slider up to the athlete's limit.
 *
 * `onChange` follows every tick (onboarding's live preview). `onCommit` is called once per gesture
 * — when the finger or mouse lets go, or the key comes up — with the value it ended on, and only
 * when that differs from `value`: the pace sets calorie targets, so a caller that saves should save
 * on commit (and offer Undo), not on every tick. Meanwhile the slider shows the value in hand.
 *
 * A finger has to mean it: a touch moves the thumb only once it travels along the track (or taps
 * it); a touch that turns out to be a vertical scroll never changes the value, and the page scrolls
 * (`touch-action: pan-y`). Mouse and keyboard act at once.
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
  useEffect(
    () => () => {
      released.current?.();
    },
    [],
  );

  const v = Math.min(draft ?? value, limit);
  const lb = bodyweight ? (v / 100) * bodyweight : null;
  const pct = limit > 0 ? (v / limit) * 100 : 0;
  const atLimit = v >= limit;
  const verb = direction === "gain" ? "gain" : direction === "lose" ? "loss" : "change";
  const valueText = `${v.toFixed(2)}% per week${lb !== null ? `, about ${fmt(lb, 1)} lb` : ""}${atLimit ? ", at your limit" : ""}`;
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
          style={{ background: `linear-gradient(90deg, var(--color-accent) ${pct}%, rgba(255,255,255,0.12) ${pct}%)` }}
        />
        <input
          type="range"
          aria-label={`Pace, percent of bodyweight ${verb} per week`}
          aria-valuetext={valueText}
          min={0.1}
          max={limit}
          step={0.05}
          value={v}
          onChange={(e) => {
            const next = Number(e.target.value);
            const t = touch.current;
            // A finger that hasn't shown it means the slider: hold the value back (React puts the thumb back).
            if (t && t.intent !== "along") t.held = next;
            else apply(next);
          }}
          onTouchStart={(e) => {
            const p = e.touches.length === 1 ? e.touches[0] : undefined;
            touch.current = p ? { x: p.clientX, y: p.clientY, intent: "undecided", held: null } : null;
          }}
          onTouchMove={(e) => {
            const t = touch.current;
            const p = e.touches[0];
            if (!t || !p || t.intent !== "undecided") return;
            const dx = Math.abs(p.clientX - t.x);
            const dy = Math.abs(p.clientY - t.y);
            if (Math.max(dx, dy) < INTENT_PX) return;
            t.intent = dx > dy ? "along" : "scroll";
            // Along the track: the thumb catches up with the finger at once, and follows it from here.
            if (t.intent === "along" && t.held !== null) apply(t.held);
          }}
          onTouchEnd={() => {
            const t = touch.current;
            touch.current = null;
            // A tap on the track (no travel) is meant.
            if (t?.intent === "undecided" && t.held !== null) apply(t.held);
            end();
          }}
          onTouchCancel={() => {
            touch.current = null;
            end();
          }}
          onPointerDown={untilRelease}
          onKeyUp={end}
          onClick={end}
          onBlur={end}
          className="range absolute inset-0 h-11 w-full touch-pan-y"
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
