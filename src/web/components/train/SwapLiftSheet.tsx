import clsx from "clsx";
import { useId } from "react";
import { Plus, Undo2 } from "lucide-react";
import { Sheet } from "../ui";

/** A lift the sheet offers: its name, the program days it is the main lift of ("Wed"), whether it has a max. */
export interface SwapLiftOption {
  id: number;
  name: string;
  /** "Wed", "Mon, Thu"; empty for a lift on no program day. */
  days: string;
  /** No max yet: picking it opens its max first (`onSetMax`), and the swap follows once one is saved. */
  noMax: boolean;
  /** Its day came earlier this week and it wasn't done: listed first, under "Still to do this week". */
  missed?: boolean;
}

/**
 * "Swap the main lift" for one session (SPEC §6.5): the planned lift to go back to (once swapped),
 * the program's main lifts still to do this week (their day passed without them), the program's
 * other main lifts with their days, then the other lifts a day could have as its main lift.
 * Picking one swaps at once (the screen offers the Undo); one without a max opens its max first.
 * At the foot, "Another exercise" for a lift that tracks no max: the main lift is skipped and an
 * exercise added. While the main lift can't be swapped (a set of it is logged), the sheet says why
 * in place of all that. On a day whose plan has no main lift (`mode` "add"), the same list adds one.
 */
export function SwapLiftSheet({
  open,
  onClose,
  mode = "swap",
  current,
  dayLabel,
  back,
  options,
  blocked,
  onPick,
  onSetMax,
  onAnother,
}: {
  open: boolean;
  onClose: () => void;
  /** "add": the session has no main lift (the day's plan has none) and the pick adds one. */
  mode?: "swap" | "add";
  /** The lift the session holds now ("" when adding). */
  current: string;
  /** The day's name ("Pull"): it keeps its accessories. */
  dayLabel: string;
  /** The planned lift, when the session's lift was swapped. */
  back: { id: number; name: string } | null;
  options: ReadonlyArray<SwapLiftOption>;
  /** Why the lift can't be swapped now, in a sentence; null when it can. */
  blocked: string | null;
  onPick: (id: number) => void;
  /** A lift without a max was picked: set its max first. */
  onSetMax: (id: number) => void;
  /** "Another exercise": skip the main lift (when there is one) and add an exercise instead. */
  onAnother: () => void;
}) {
  const id = useId();
  const missed = options.filter((o) => o.missed);
  const program = options.filter((o) => !o.missed && o.days);
  const others = options.filter((o) => !o.missed && !o.days);
  const row = (o: SwapLiftOption) => {
    // "Back squat · Wed"; without a max "Strict press · Thu · no max yet, set it first" (its day still says where it belongs).
    const tag = o.days;
    const name = [o.name, o.days, o.noMax ? "no max yet: set it first" : ""].filter(Boolean).join(" · ");
    return (
      <li key={o.id}>
        <button
          type="button"
          aria-label={name}
          aria-haspopup={o.noMax ? "dialog" : undefined}
          data-swap-to={o.id}
          data-no-max={o.noMax || undefined}
          className="tap flex min-h-12 w-full items-center justify-between gap-x-3 py-3 text-left"
          onClick={() => (o.noMax ? onSetMax(o.id) : onPick(o.id))}
        >
          <span className="min-w-0 text-[0.9375rem] wrap-anywhere">{o.name}</span>
          <span className="label shrink-0 text-right">
            {tag && <span className={clsx(!o.noMax && "text-fg-2")}>{tag}</span>}
            {tag && o.noMax && " · "}
            {o.noMax && <span className="text-accent">set max</span>}
          </span>
        </button>
      </li>
    );
  };
  const what = mode === "add" ? "Add a main lift" : "Swap the main lift";
  return (
    <Sheet open={open} onClose={onClose} title={what}>
      <p id={`${id}-about`} className="text-sm text-mute">
        For this session only: <span className="text-fg-2">{dayLabel}</span> keeps its accessories, and the plan doesn't change.
      </p>
      {blocked ? (
        <p role="status" data-swap-blocked className="mt-5 rounded-2xl bg-white/[0.04] px-4 py-3.5 text-sm text-fg-2">
          {blocked}
        </p>
      ) : (
        <div className="mt-5 pb-2">
          {back && (
            <button
              type="button"
              data-swap-back
              className="tap mb-5 flex min-h-12 w-full items-center gap-3 rounded-2xl bg-accent/[0.07] px-4 py-3 text-left"
              onClick={() => onPick(back.id)}
            >
              <Undo2 size={16} aria-hidden className="shrink-0 text-accent" />
              <span className="min-w-0">
                Back to the planned lift
                <span className="block text-xs text-fg-2">
                  {back.name} in place of {current}
                </span>
              </span>
            </button>
          )}
          {missed.length > 0 && (
            <>
              <h4 className="label mb-1">Still to do this week</h4>
              <ul className="mb-5 divide-y divide-white/[0.04]">{missed.map(row)}</ul>
            </>
          )}
          {program.length > 0 && (
            <>
              <h4 className="label mb-1">{missed.length ? "The program's other main lifts" : "This program's main lifts"}</h4>
              <ul className="mb-5 divide-y divide-white/[0.04]">{program.map(row)}</ul>
            </>
          )}
          {others.length > 0 && (
            <>
              <h4 className="label mb-1">Other lifts</h4>
              <ul className="mb-5 divide-y divide-white/[0.04]">{others.map(row)}</ul>
            </>
          )}
          {/* A lift that tracks no max (a dumbbell or machine press): done as an exercise of its own, loads by hand. */}
          <button
            type="button"
            data-swap-another
            className="tap flex min-h-12 w-full items-center gap-3 rounded-2xl bg-white/[0.04] px-4 py-3 text-left"
            onClick={onAnother}
          >
            <Plus size={16} aria-hidden className="shrink-0 text-mute" />
            <span className="min-w-0">
              Another exercise
              <span className="block text-xs text-fg-2">
                {mode === "add" ? "Add one with your own loads" : `Skip ${current} and add one, with your own loads`}
              </span>
            </span>
          </button>
        </div>
      )}
    </Sheet>
  );
}
