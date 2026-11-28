/**
 * One section of the training day (design A.2 / A.4 / A.11): a numbered head, then its body.
 * Pure: it shows what its props say.
 *
 * Head: a mono index ("02", lime with a faint glow on the current section), the name as a light
 * title, a meta line under it that truncates and never wraps (its full text is the section's
 * accessible description), and at the right, on the title's line: an optional control (`action`,
 * "Remove"), then **Skip** (`onSkip`: a quiet button, so that it never reads as the state), then
 * the state — the caller's check (`check`, Metcon and Zone 2), or what the state says: a count
 * ("5/16"), a lit check once done, NOT TODAY or NOT DONE (mono labels: a state, not a control).
 * The check sits in the same right-hand column as every set's check.
 *
 * Under the head, an optional hairline fills with `progress` (and `sweep` runs one pass of light
 * along it when the section completes). A section that is Not today shows one muted line (what it
 * held) and Bring back instead of its body; a folded one shows its head only.
 *
 * The section is a jump target: `#id` scrolls it in with room above, and its heading takes focus
 * (`[data-section-heading]`), as the rail's links expect.
 */
import clsx from "clsx";
import { useReducedMotion } from "motion/react";
import { useId, type CSSProperties, type ReactNode } from "react";
import { Check } from "lucide-react";

export type SectionState = "todo" | "active" | "done" | "skipped" | "missed" | "planned";

export interface DaySectionProps {
  /** The anchor id ("strength"). */
  id: string;
  /** 1-based position in the day: shown as "01". */
  index: number;
  title: string;
  /** The line under the title ("Push · 3,630 lb moved"): one line, truncated. Put numbers in `text-fg-2`. */
  meta?: ReactNode;
  state: SectionState;
  /** The section the day is at: a lime index. */
  current?: boolean;
  /** Logged / planned sets: "5/16" at the right while there is no check (and read out in words). */
  count?: { done: number; total: number; unit?: string };
  /** 0…1: the hairline under the head, filled this far. Omit for no hairline. */
  progress?: number;
  /** The section's own check (an interactive CheckDot), placed in the check column. */
  check?: ReactNode;
  /** A control before the state ("Remove" on an added section). */
  action?: ReactNode;
  /** Shows **Skip**, which makes it Not today (pass it only on today or the day's draft, while nothing in it is logged). */
  onSkip?: () => void;
  /** A Not-today section's Bring back. */
  onBringBack?: () => void;
  /** A Not-today section's one muted line: what it held ("Hanging knee raise · Weighted plank"). */
  skippedLine?: ReactNode;
  /** Head only (a done section, or a past day's): the body is not rendered. */
  folded?: boolean;
  /** Play one pass of light along the hairline (pass true at the moment the section completes). */
  sweep?: boolean;
  className?: string;
  children?: ReactNode;
}

/** The state as the head says it at the right when there's no check ("" for none). */
function stateText(state: SectionState, count: DaySectionProps["count"]): { shown: string; said: string } | null {
  if (state === "skipped") return { shown: "Not today", said: "Not today" };
  if (state === "missed") return { shown: "Not done", said: "Not done" };
  if ((state === "active" || state === "todo") && count)
    return { shown: `${count.done}/${count.total}`, said: `${count.done} of ${count.total} ${count.unit ?? "sets"}` };
  return null;
}

/** The small mono button of a section head ("Bring back"). */
function HeadButton({
  onClick,
  label,
  tone = "mute",
  last = false,
  children,
}: {
  onClick: () => void;
  label?: string;
  tone?: "mute" | "accent";
  /** Nothing follows it: its word ends at the content edge (the padding reaches into the gutter). */
  last?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={clsx(
        "label tap inline-flex min-h-11 shrink-0 items-center px-2 whitespace-nowrap",
        last && "-mr-2",
        tone === "accent" ? "text-accent" : "text-mute",
      )}
    >
      {children}
    </button>
  );
}

export function DaySection({
  id,
  index,
  title,
  meta,
  state,
  current = false,
  count,
  progress,
  check,
  action,
  onSkip,
  onBringBack,
  skippedLine,
  folded = false,
  sweep = false,
  className,
  children,
}: DaySectionProps) {
  const reduce = useReducedMotion() ?? false;
  const uid = useId();
  const headingId = `${uid}-h`;
  const metaId = `${uid}-m`;
  const said = stateText(state, count);
  const p = progress === undefined ? undefined : Math.max(0, Math.min(1, progress || 0));
  const skipped = state === "skipped";
  const showBody = !folded && !skipped && children != null;

  return (
    <section
      id={id}
      aria-labelledby={headingId}
      aria-describedby={meta ? metaId : undefined}
      data-state={state}
      className={clsx("mt-(--section-gap) scroll-mt-[calc(env(safe-area-inset-top)+1.25rem)]", className)}
    >
      {/* The meta runs under the state column too, so on a narrow phone it keeps the whole width.
          The state column's 44px controls are centred on the 32px title line without making it taller. */}
      <div className="grid grid-cols-[1.5rem_minmax(0,1fr)_auto] gap-x-3">
        <span
          aria-hidden
          data-index=""
          className={clsx(
            "col-start-1 row-span-2 row-start-1 pt-1 font-mono text-xs tracking-[0.08em]",
            current ? "glow-text text-accent" : "text-mute",
          )}
        >
          {String(index).padStart(2, "0")}
        </span>
        <h2
          id={headingId}
          tabIndex={-1}
          data-section-heading=""
          className="col-start-2 row-start-1 min-w-0 text-2xl leading-8 font-light tracking-[-0.015em]"
        >
          {title}
        </h2>
        {meta && (
          <p id={metaId} className="col-span-2 col-start-2 row-start-2 mt-0.5 truncate text-[0.8125rem] leading-[1.125rem] text-mute">
            {meta}
          </p>
        )}
        {(action || onSkip || check || said || state === "done") && (
          <div className="col-start-3 row-start-1 -my-1.5 flex items-center">
            {action}
            {onSkip && (
              // A quiet button, in words — unlike NOT TODAY, the state it leads to, in the head's mono labels.
              // Visibly a pill, 44px to the touch (`chip`'s hit area).
              <button
                type="button"
                onClick={onSkip}
                aria-label={`Skip ${title}`}
                className={clsx("chip shrink-0 bg-white/[0.04] text-fg-2", check && "mr-1")}
              >
                Skip
              </button>
            )}
            {check ? (
              <CheckCell>{check}</CheckCell>
            ) : state === "done" ? (
              <CheckCell>
                <span className="grid h-[26px] w-[26px] place-items-center rounded-full bg-accent text-accent-ink shadow-(--glow-accent)">
                  <Check size={14} strokeWidth={3} aria-hidden />
                </span>
                <span className="sr-only">Done</span>
              </CheckCell>
            ) : said && !onSkip ? (
              <span className="label inline-flex min-h-11 items-center whitespace-nowrap">
                {said.shown === said.said ? (
                  said.shown
                ) : (
                  <>
                    <span aria-hidden>{said.shown}</span>
                    <span className="sr-only">{said.said}</span>
                  </>
                )}
              </span>
            ) : null}
          </div>
        )}
      </div>

      {p !== undefined && (
        <div aria-hidden data-hairline="" className="relative mt-3.5 ml-9 h-px bg-(--hairline)">
          <span
            className="glow-line progress-fill absolute inset-x-0 -top-px h-0.5 rounded-full"
            style={{ "--progress": p } as CSSProperties}
          />
          {sweep && !reduce && <span data-sweep="" className="sweep absolute inset-x-0 -top-0.5 h-1 overflow-hidden" />}
        </div>
      )}

      {skipped && (skippedLine || onBringBack) && (
        <div className="mt-4 flex min-h-11 items-center justify-between gap-3">
          <span data-skipped-line="" className="min-w-0 truncate text-[0.9375rem] text-mute">
            {skippedLine}
          </span>
          {onBringBack && (
            <HeadButton onClick={onBringBack} tone="accent" label={`Bring back ${title}`} last>
              Bring back
            </HeadButton>
          )}
        </div>
      )}

      {showBody && <div className="mt-6">{children}</div>}
    </section>
  );
}

/** The right-hand check column: 64px wide, reaching into the gutter like a set row's check. */
function CheckCell({ children }: { children: ReactNode }) {
  return <span className="-mr-3 flex h-11 w-16 shrink-0 items-center justify-end pr-3">{children}</span>;
}
