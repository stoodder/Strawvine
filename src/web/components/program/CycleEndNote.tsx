/**
 * The quiet note of a cycle's last week (SPEC §7), on Train's header area and Program › Now:
 * "Cycle 2 ends Sun Nov 29. Next: Repeat cycle 2 · Set up a new cycle" — or, once a new cycle is set
 * up, what comes next with a link to review it. The choice itself is `useCycleChoice`'s.
 */
import { Link } from "react-router";
import { formatShortDate, weekdayName } from "../../../shared/dates";
import type { CycleEndCard } from "../../../shared/plans";

export interface CycleChoice {
  /** The note for today (null: nothing to say). */
  card: CycleEndCard | null;
  /** "Repeat cycle N": the plan continues; the note goes for that cycle, on every device. */
  repeat: (cycle: number) => void;
  /** "Set up a new cycle": a copy of the plan from the next cycle on, then Program to change it (with Undo). */
  setUpNewCycle: () => void;
}

const day = (date: string) => `${weekdayName(date, true)} ${formatShortDate(date)}`;

export function CycleEndNote({ choice, reviewFrom }: { choice: CycleChoice; /** Program's back target for "Review". */ reviewFrom?: string }) {
  const card = choice.card;
  if (!card) return null;
  return (
    <div data-cycle-end="" className="@container rounded-2xl bg-white/[0.03] px-4 py-3">
      <p className="text-sm text-fg-2">
        Cycle {card.cycle} ends {day(card.end)}.
      </p>
      {card.next ? (
        <p className="text-sm text-mute">
          Next: a new cycle from {day(card.next.start)} ·{" "}
          <Link to="/program#layout" state={reviewFrom ? { from: reviewFrom } : undefined} className="-mx-1 -my-3 inline-block px-1 py-3 text-accent">
            Review
          </Link>
        </p>
      ) : (
        // Where the line has no room for both choices (a 320 px phone, larger text) they stack, each
        // starting at the text's edge, and the dot between them goes.
        <p className="-mx-1 flex flex-wrap items-center text-sm text-mute">
          {/* The spaces between the items are for reading it out (the padding lays them out). */}
          <span className="px-1">Next:</span>{" "}
          <button type="button" className="tap -my-1 min-h-11 px-1 text-accent" onClick={() => choice.repeat(card.cycle)}>
            Repeat cycle {card.cycle}
          </button>{" "}
          <span aria-hidden className="px-0.5 @max-[17rem]:hidden">
            ·
          </span>{" "}
          <button type="button" className="tap -my-1 min-h-11 px-1 text-accent" onClick={() => choice.setUpNewCycle()}>
            Set up a new cycle
          </button>
        </p>
      )}
    </div>
  );
}
