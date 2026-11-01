import clsx from "clsx";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { minutesToHM } from "../../lib/format";
import { formatSleep, parseSleep } from "./sleep";

/**
 * Controlled text state for an input that commits on blur / Enter.
 * Mirrors `value` while not being edited, and commits pending text if it unmounts mid-edit
 * (e.g. a back-swipe) or the app is backgrounded, through the `onCommit` it was last rendered with — so a field that
 * belongs to one day can never write into another.
 */
function useCommitField(value: string, commit: (text: string) => void) {
  const [text, setText] = useState(value);
  const focused = useRef(false);
  const latest = useRef({ text, value, commit });
  useLayoutEffect(() => {
    latest.current = { text, value, commit };
  });
  useEffect(() => {
    if (!focused.current) setText(value);
  }, [value]);
  useEffect(() => {
    const flush = () => {
      const l = latest.current;
      if (focused.current && l.text !== l.value) l.commit(l.text);
    };
    const onVisibility = () => document.visibilityState === "hidden" && flush();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, []);
  return {
    text,
    setText,
    bind: {
      value: text,
      onChange: (e: React.ChangeEvent<HTMLInputElement>) => setText(e.target.value),
      onFocus: () => (focused.current = true),
      onBlur: () => {
        focused.current = false;
        commit(text);
      },
      onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "Enter") e.currentTarget.blur();
      },
    },
  };
}

const BOX = "field w-full rounded-xl bg-white/[0.05] px-3 py-2 text-base";

/** A boxed single-line text field (benchmark name, score…). Empty commits `null`. */
export function TextField({
  value,
  onCommit,
  ariaLabel,
  placeholder,
  className,
  maxLength = 120,
  list,
  describedBy,
}: {
  value: string | null;
  onCommit: (v: string | null) => void;
  ariaLabel: string;
  placeholder?: string;
  className?: string;
  maxLength?: number;
  /** Id of a <datalist> of suggestions. */
  list?: string;
  /** Id of an element that describes the field (e.g. a "best so far" line). */
  describedBy?: string;
}) {
  const f = useCommitField(value ?? "", (t) => {
    const v = t.trim() || null;
    if (v !== value) onCommit(v);
    f.setText(v ?? "");
  });
  return (
    <input
      aria-label={ariaLabel}
      placeholder={placeholder}
      maxLength={maxLength}
      enterKeyHint="done"
      autoComplete="off"
      list={list}
      aria-describedby={describedBy}
      {...f.bind}
      className={clsx(BOX, className)}
    />
  );
}

/**
 * Sleep duration as one field that works with the phone's number pad: "7:30", "7.30" and "730"
 * all mean 7h 30m. While typing, a quiet readout shows how the entry will be read.
 */
export function SleepField({ value, onCommit }: { value: number | null; onCommit: (minutes: number | null) => void }) {
  const [editing, setEditing] = useState(false);
  const f = useCommitField(formatSleep(value), (t) => {
    const m = parseSleep(t);
    if (m === undefined) {
      // Unreadable: keep what was saved rather than erasing it.
      f.setText(formatSleep(value));
      return;
    }
    if (m !== value) onCommit(m);
    f.setText(formatSleep(m));
  });
  const parsed = parseSleep(f.text);
  const hintId = useId();
  const hint = !editing || !f.text.trim() ? null : parsed === undefined ? "h:mm" : parsed !== null ? `= ${minutesToHM(parsed)}` : null;
  return (
    <div className="relative">
      <input
        aria-label="Sleep duration, hours and minutes"
        aria-describedby={hint ? hintId : undefined}
        inputMode="decimal"
        enterKeyHint="done"
        autoComplete="off"
        placeholder="7:30"
        {...f.bind}
        onFocus={(e) => {
          f.bind.onFocus();
          setEditing(true);
          e.currentTarget.select();
        }}
        onBlur={() => {
          setEditing(false);
          f.bind.onBlur();
        }}
        className={clsx(BOX, "num")}
      />
      {hint && (
        <div
          id={hintId}
          aria-live="polite"
          className={clsx(
            "num absolute top-full left-0 mt-1 text-[11px] whitespace-nowrap",
            parsed === undefined ? "text-warn" : "text-mute",
          )}
        >
          {hint}
        </div>
      )}
    </div>
  );
}
