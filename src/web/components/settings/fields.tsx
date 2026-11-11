/**
 * The rows Settings and Program are made of: a number that validates on commit, a rest time
 * typed as m:ss, and a row of weekdays.
 */
import clsx from "clsx";
import { useEffect, useState, type ReactNode } from "react";
import { WEEKDAY_SHORT } from "../../../shared/dates";
import { fmt } from "../../lib/format";
import { BoxNumber, Field, useFieldIds } from "../ui";
import { formatRest, parseRest } from "./restTime";

/** Weekday order shown Monday-first; values are JS weekday indices. */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

/** Inline range check for a number setting; returns a message or null. */
function rangeError(
  v: number | null,
  min: number,
  max: number,
  opts: { unit?: string; optional?: boolean; integer?: boolean } = {},
): string | null {
  if (v === null) return opts.optional ? null : "Enter a number.";
  const u = opts.unit ?? "";
  if (v < min || v > max) return `Between ${fmt(min, min % 1 ? 1 : 0)}${u} and ${fmt(max, max % 1 ? 1 : 0)}${u}.`;
  if (opts.integer && !Number.isInteger(v)) return "Whole numbers only.";
  return null;
}

/**
 * A Field with a BoxNumber that validates on commit: an out-of-range value stays visible with an
 * inline message (and isn't saved) until it's fixed.
 */
export function NumSetting({
  label,
  hint,
  value,
  onSave,
  min,
  max,
  unit,
  decimals = 0,
  optional,
  integer,
  placeholder,
  grouping,
  unitInMessage,
}: {
  label: ReactNode;
  hint?: ReactNode;
  value: number | null;
  onSave: (v: number | null) => void;
  min: number;
  max: number;
  unit?: string;
  decimals?: number;
  optional?: boolean;
  integer?: boolean;
  placeholder?: string;
  grouping?: boolean;
  unitInMessage?: string;
}) {
  const [error, setError] = useState<string | null>(null);
  return (
    <Field label={label} hint={hint} error={error}>
      <BoxNumber
        ariaLabel={typeof label === "string" ? label : "Value"}
        value={value}
        unit={unit}
        decimals={decimals}
        placeholder={placeholder}
        grouping={grouping}
        onCommit={(v) => {
          const e = rangeError(v, min, max, { unit: unitInMessage, optional, integer });
          setError(e);
          if (!e) onSave(v);
        }}
      />
    </Field>
  );
}

/** A rest time, shown and typed as m:ss ("3:00"); "330", "3.30", minutes ("3") and seconds ("180") work too (see restTime.ts). */
export function RestSetting({
  label,
  hint,
  value,
  onSave,
  min,
  max,
}: {
  label: string;
  hint?: ReactNode;
  value: number;
  onSave: (seconds: number) => void;
  min: number;
  max: number;
}) {
  const [error, setError] = useState<string | null>(null);
  return (
    <Field label={label} hint={hint} error={error}>
      <RestInput
        label={label}
        value={value}
        onCommit={(text) => {
          const v = parseRest(text);
          const e =
            v === null
              ? "Enter a time like 3:00 (or 330), or seconds."
              : v < min || v > max
                ? `Between ${formatRest(min)} and ${formatRest(max)}.`
                : null;
          setError(e);
          if (e || v === null) return false;
          if (v !== value) onSave(v);
          return true;
        }}
      />
    </Field>
  );
}

function RestInput({ label, value, onCommit }: { label: string; value: number; onCommit: (text: string) => boolean }) {
  const field = useFieldIds();
  const [text, setText] = useState(formatRest(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(formatRest(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the saved value changes
  }, [value]);
  // While typing, how the entry reads ("330" → 3:30), so a keypad without ":" is no guesswork.
  const parsed = focused ? parseRest(text) : null;
  const reading = parsed !== null && formatRest(parsed) !== text.trim() ? formatRest(parsed) : null;
  return (
    // A <label>, so a tap on the padding focuses the input.
    <label className="box-field inline-flex cursor-text items-baseline gap-1.5 rounded-xl bg-white/[0.05] px-3 py-2">
      {reading && (
        <span aria-hidden className="num text-xs text-mute">
          {reading}?
        </span>
      )}
      <input
        aria-label={label}
        aria-labelledby={field?.labelId}
        aria-describedby={field?.describedBy}
        aria-invalid={field?.invalid || undefined}
        value={text}
        placeholder="3:00"
        // The decimal pad: digits and "." ("3.30"); ":" still works from a full keyboard.
        inputMode="decimal"
        autoComplete="off"
        enterKeyHint="done"
        onFocus={(e) => {
          setFocused(true);
          e.currentTarget.select();
        }}
        onBlur={() => {
          setFocused(false);
          // Valid: show it tidied ("330" → "3:30"); invalid: keep what was typed next to the message.
          if (onCommit(text)) setText(formatRest(parseRest(text)!));
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        onChange={(e) => setText(e.target.value)}
        className="field num w-[5.5ch] min-w-0 text-right text-base"
      />
    </label>
  );
}

export function DayPicker({ label, value, onChange }: { label: string; value: boolean[]; onChange: (v: boolean[]) => void }) {
  return (
    <div role="group" aria-label={`${label} days`}>
      <div className="mb-1 text-sm text-fg-2">{label}</div>
      {/* Seven equal cells: each is a full 44px-tall target around a small round day. */}
      <div className="grid max-w-sm grid-cols-7">
        {WEEK_ORDER.map((d) => (
          <button
            key={d}
            type="button"
            aria-pressed={value[d]}
            aria-label={WEEKDAY_SHORT[d]}
            onClick={() => onChange(value.map((x, i) => (i === d ? !x : x)))}
            className="tap grid h-11 place-items-center"
          >
            <span
              className={clsx(
                // 32px round; shrinks (never overlaps its neighbour) when seven don't fit.
                "grid aspect-square w-full max-w-8 place-items-center rounded-full text-[0.6875rem] font-medium",
                value[d] ? "bg-accent text-accent-ink" : "bg-white/[0.04] text-mute",
              )}
            >
              {WEEKDAY_SHORT[d]![0]}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
