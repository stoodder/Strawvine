/**
 * The quiet note of a cycle's last week (SPEC §7), on Train's header area and Program › Now:
 * "Cycle 2 ends Sun Nov 29. For cycle 3: Keep this plan · Set up a new plan" — or, once a new plan
 * is set up, what comes next with a link to review it. The choice itself is `useCycleChoice`'s.
 */
import type { ReactNode } from "react";
import { Link } from "react-router";
import { formatShortDate, weekdayName } from "../../../shared/dates";
import type { CycleEndCard, NewCycleOptions } from "../../../shared/plans";

export interface CycleChoice {
  /** The note for today (null: nothing to say). */
  card: CycleEndCard | null;
  /** "Keep this plan" at the end of cycle `cycle`: the plan runs on; the note goes for that cycle, on every device. */
  repeat: (cycle: number) => void;
  /** "Set up a new plan": a copy of the plan, then Program on it (with Undo). */
  setUpNewCycle: (opts?: NewCycleOptions) => void;
}

const day = (date: string) => `${weekdayName(date, true)} ${formatShortDate(date)}`;

/**
 * "Next: a new plan from Mon Nov 30 · Review". The dot stays with the link: where the line has no
 * room for both, "· Review" goes to the next line whole.
 */
export function NextPlanLine({ start, review }: { start: string; review: ReactNode }) {
  return (
    <>
      Next: a new plan from {day(start)}{" "}
      <span className="whitespace-nowrap">
        <span aria-hidden>·</span> {review}
      </span>
    </>
  );
}

export function CycleEndNote({
  choice,
  reviewFrom,
}: {
  choice: CycleChoice;
  /** Program's back target for "Review". */ reviewFrom?: string;
}) {
  const card = choice.card;
  if (!card) return null;
  return (
    <div data-cycle-end="" className="@container rounded-2xl bg-white/[0.03] px-4 py-3">
      <p className="text-sm text-fg-2">
        Cycle {card.cycle} ends {day(card.end)}.
      </p>
      {card.next ? (
        <p className="text-sm text-mute">
          <NextPlanLine
            start={card.next.start}
            review={
              <Link
                to="/program#layout"
                state={{ ...(reviewFrom ? { from: reviewFrom } : {}), plan: "next" }}
                className="-mx-1 -my-3 inline-block px-1 py-3 text-accent"
              >
                Review
              </Link>
            }
          />
        </p>
      ) : (
        // Where the line has no room for both choices (a 320 px phone, larger text) they stack, each
        // starting at the text's edge, and the dot between them goes.
        <p className="-mx-1 flex flex-wrap items-center text-sm text-mute">
          {/* The spaces between the items are for reading it out (the padding lays them out). */}
          <span className="px-1">For cycle {card.cycle + 1}:</span>{" "}
          <button type="button" className="tap -my-1 min-h-11 px-1 text-accent" onClick={() => choice.repeat(card.cycle)}>
            Keep this plan
          </button>{" "}
          <span aria-hidden className="px-0.5 @max-[17rem]:hidden">
            ·
          </span>{" "}
          <button
            type="button"
            data-set-up-plan=""
            className="tap -my-1 min-h-11 px-1 text-accent"
            onClick={() => choice.setUpNewCycle({ atCycleEnd: true })}
          >
            Set up a new plan
          </button>
        </p>
      )}
    </div>
  );
}
