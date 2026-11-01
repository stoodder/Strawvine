import { formatShortDate, isISODate, weekdayName } from "../../../shared/dates";

/**
 * The header date ("SUN · NOV 1"). Tapping it opens the platform's own date picker — an
 * invisible native <input type="date"> laid over the label — to jump to any past day.
 * A quiet dot after the date says this day still has edits waiting to sync.
 */
export function DateJump({
  date,
  today,
  pending,
  onPick,
}: {
  date: string;
  today: string;
  /** This day has writes the server hasn't confirmed yet. */
  pending: boolean;
  onPick: (date: string) => void;
}) {
  const name = `Choose a day. Showing ${weekdayName(date)}, ${formatShortDate(date, date.slice(0, 4) !== today.slice(0, 4))}`;
  return (
    <label className="relative inline-flex cursor-pointer items-center gap-1.5 rounded-md px-1 py-2.5 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent/75">
      <span aria-hidden className="label text-fg-2">
        {weekdayName(date, true)} · {formatShortDate(date)}
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
        max={today}
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
          if (v && isISODate(v) && v <= today && v !== date) onPick(v);
        }}
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        style={{ colorScheme: "dark" }}
      />
    </label>
  );
}
