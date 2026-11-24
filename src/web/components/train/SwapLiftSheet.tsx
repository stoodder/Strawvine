import clsx from "clsx";
import { useId } from "react";
import { Undo2 } from "lucide-react";
import { Sheet } from "../ui";

/** A lift the sheet offers: its name, the program days it is the main lift of ("Wed"), whether it can be picked. */
export interface SwapLiftOption {
  id: number;
  name: string;
  /** "Wed", "Mon, Thu"; empty for a lift on no program day. */
  days: string;
  /** No max yet: listed, but it can't be calculated (picking does nothing; the row says why). */
  noMax: boolean;
}

/**
 * "Swap the main lift" for one session (SPEC §6.5): the planned lift to go back to (once swapped),
 * the program's other main lifts with their days, then the other lifts a day could have as its main
 * lift. Picking one swaps at once (the screen offers the Undo). While the main lift can't be swapped
 * (a set of it is logged), the sheet says why in place of the list.
 */
export function SwapLiftSheet({
  open,
  onClose,
  current,
  dayLabel,
  back,
  options,
  blocked,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  /** The lift the session holds now. */
  current: string;
  /** The day's name ("Pull"): it keeps its accessories. */
  dayLabel: string;
  /** The planned lift, when the session's lift was swapped. */
  back: { id: number; name: string } | null;
  options: ReadonlyArray<SwapLiftOption>;
  /** Why the lift can't be swapped now, in a sentence; null when it can. */
  blocked: string | null;
  onPick: (id: number) => void;
}) {
  const id = useId();
  const program = options.filter((o) => o.days);
  const others = options.filter((o) => !o.days);
  const row = (o: SwapLiftOption) => {
    // "Back squat · Wed"; without a max "Strict press · Thu · no max yet" (its day still says where it belongs).
    const tag = [o.days, o.noMax ? "no max yet" : ""].filter(Boolean).join(" · ");
    const name = tag ? `${o.name} · ${tag}` : o.name;
    return (
      <li key={o.id}>
        <button
          type="button"
          aria-label={name}
          // Can't be calculated without a max: aria-disabled (still read, with why) and does nothing.
          aria-disabled={o.noMax || undefined}
          data-swap-to={o.id}
          className="tap flex min-h-12 w-full items-center justify-between gap-x-3 py-3 text-left aria-disabled:cursor-default"
          onClick={o.noMax ? undefined : () => onPick(o.id)}
        >
          <span className={clsx("min-w-0 text-[0.9375rem] wrap-anywhere", o.noMax && "text-mute")}>{o.name}</span>
          <span className={clsx("label shrink-0 text-right", !o.noMax && o.days && "text-fg-2")}>{tag}</span>
        </button>
      </li>
    );
  };
  return (
    <Sheet open={open} onClose={onClose} title="Swap the main lift">
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
          {program.length > 0 && (
            <>
              <h4 className="label mb-1">This program's main lifts</h4>
              <ul className="mb-5 divide-y divide-white/[0.04]">{program.map(row)}</ul>
            </>
          )}
          {others.length > 0 && (
            <>
              <h4 className="label mb-1">Other lifts</h4>
              <ul className="divide-y divide-white/[0.04]">{others.map(row)}</ul>
            </>
          )}
          {!back && !options.length && <p className="text-sm text-mute">No other lift tracks a max yet.</p>}
        </div>
      )}
    </Sheet>
  );
}
