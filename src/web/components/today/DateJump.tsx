import { formatShortDate, isISODate, weekdayName } from "../../../shared/dates";

/**
 * The header date ("SUN · NOV 1"). Tapping it opens the platform's own date picker — an
 * invisible native <input type="date"> laid over the label — to jump to any day up to `max`
 * (default: `today`). With `pending`, a quiet dot after the date says this day still has edits
 * waiting to sync (Today shows a tappable `PendingSyncChip` instead).
 *
 * Never wraps: at the narrowest widths (under ~17.5rem, e.g. 195px or 400% zoom) the weekday
 * is dropped and only "NOV 1" shows (the accessible name keeps the full date).
 */
export function DateJump({
  date,
  today,
  max,
  pending = false,
  onPick,
}: {
  date: string;
  /** The real today: the year is spelled out for dates in another year. */
  today: string;
  /** The latest day that can be picked (e.g. the last previewable day on Train). Default `today`. */
  max?: string;
  /** This day has writes the server hasn't confirmed yet. */
  pending?: boolean;
  onPick: (date: string) => void;
}) {
  const upper = max ?? today;
  const weekday = weekdayName(date, true);
  const visible = `${weekday} · ${formatShortDate(date)}`;
  const otherYear = date.slice(0, 4) !== today.slice(0, 4);
  // The name starts with the visible text (so "tap Mon · Nov 2" works for voice control).
  const name = `${visible}${otherYear ? `, ${date.slice(0, 4)}` : ""} — choose a day`;
  return (
    <label className="focus-ring-within relative inline-flex min-h-11 cursor-pointer items-center gap-1.5 rounded-md px-1">
      <span aria-hidden className="label whitespace-nowrap text-fg-2">
        <span className="max-[17.5rem]:hidden">{weekday} · </span>
        {formatShortDate(date)}
      </span>
      {pending && (
        // Out of flow, so the header doesn't shift as it comes and goes.
        <span
          aria-hidden
          title="Waiting to sync"
          data-pending-dot
          className="absolute top-1/2 -right-1 h-1 w-1 -translate-y-1/2 animate-pulse rounded-full bg-fg-2/70"
        />
      )}
      <input
        type="date"
        aria-label={pending ? `${name}. Changes waiting to sync.` : name}
        value={date}
        max={upper}
        required
        onClick={(e) => {
          // Desktop browsers only open the calendar from its icon; open it from anywhere.
          try {
            e.currentTarget.showPicker?.();
          } catch {
            /* not allowed here: the native control still works */
          }
        }}
        onChange={(e) => {
          const v = e.target.value;
          if (v && isISODate(v) && v <= upper && v !== date) onPick(v);
        }}
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        style={{ colorScheme: "dark" }}
      />
    </label>
  );
}
