/**
 * A done block of the Train page, folded: one row that says what it came to and opens it again.
 * (`Foldable` shows a block as that row or as itself — one face at a time, changed in one step.)
 *
 *   Lateral raise ⌄                                   ( ✓ )
 *   3 × 12 · 20 lb
 *
 * It reads as a logged row, one level up: the name where the exercise's header has it, the result
 * under it in the logged rows' tone, and the same filled check in the checks' column — gold when
 * the main lift's AMRAP beat its target, as on that set's own row. The chevron beside the name
 * (the pencil's size and tone) marks the row as the toggle; the open block's header carries it too
 * (`FoldToggle`), so the control stays where it was. A superset is one row: its members, each
 * with its result, under the superset's name.
 *
 * The whole row is one button (`aria-expanded`), named by what it shows: "Lateral raise (all sets
 * logged) 3 × 12 · 20 lb". A main lift whose rest was skipped says that instead, in the row and in
 * its name: "Bench press (2 sets skipped) 170 × 6 · 160 × 8".
 */
import clsx from "clsx";
import type { ReactNode } from "react";
import { ChevronDown, ChevronUp, Link2 } from "lucide-react";
import type { ExerciseSummary } from "./exerciseSummary";
import { CheckMark, noCallout, tagTone } from "./SetControls";

/**
 * Said (to a screen reader) after the name of a block whose sets are all logged — in brackets, with
 * its spaces as real text, so the name reads "Lateral raise (all sets logged) 3 × 12 · 20 lb"
 * however the words around it are joined.
 */
export const ALL_LOGGED = "all sets logged";

/**
 * A block of the Train page that shows either as itself or — done, and folded — as its summary
 * row. Stateless: which face shows is the screen's view state (`useFolds`), and a change of face
 * is one step. `data-fold` and `data-done` mark the block for `foldInPlace` (and for tests).
 */
export function Foldable({
  id,
  done,
  folded,
  summary,
  children,
}: {
  id: string;
  /** Every set of the block is logged: it can fold (and isn't what the page is held in place around when others do). */
  done: boolean;
  folded: boolean;
  summary: ReactNode;
  children: ReactNode;
}) {
  return (
    // flow-root: the block holds its own margins, so its box is the room it takes.
    <div data-fold={id} data-done={done ? "" : undefined} data-folded={folded ? "" : undefined} className="flow-root">
      {folded ? summary : children}
    </div>
  );
}

export interface FoldedItem {
  key: string;
  name: string;
  /** "A1": the exercise's place in its superset. */
  tag?: string;
  /** What its logged sets came to (`exerciseSummary`). */
  summary: ExerciseSummary;
  /** Skipped today: it has no result. */
  skipped?: boolean;
}

/** A summary's parts in a line that only breaks between them. */
function ResultLine({ summary, className }: { summary: ExerciseSummary; className?: string }) {
  return (
    <span className={clsx("num block text-sm", className)}>
      {summary.parts.map((p, i) => (
        <span key={i}>
          {i > 0 && " · "}
          <span className="whitespace-nowrap">{p.text}</span>
          {p.tag && (
            <>
              {" "}
              <span className={clsx("label whitespace-nowrap", tagTone(p.tag))}>{p.tag.text}</span>
            </>
          )}
        </span>
      ))}
    </span>
  );
}

export function FoldedBlock({
  blockId,
  items,
  superset,
  size = "compact",
  tone = "accent",
  status,
  record = false,
  onOpen,
}: {
  blockId: string;
  /** The block's exercises: one, or a superset's members in order. */
  items: ReadonlyArray<FoldedItem>;
  /** "A": the block is Superset A. */
  superset?: string;
  /** The main lift keeps its larger name and check. */
  size?: "main" | "compact";
  /** The check's colour: gold for a beaten AMRAP. */
  tone?: "accent" | "gold";
  /**
   * What stands in for "all sets logged" when that isn't the whole truth — "2 sets skipped" for a
   * main lift whose rest was skipped: shown under the result, and said in the row's name.
   */
  status?: string;
  /** The page is a record (a finished session, or a day that isn't today): the rows are its content and read a step brighter. */
  record?: boolean;
  onOpen: () => void;
}) {
  const nameTone = record ? "text-fg" : "text-fg-2";
  const resultTone = record ? "text-fg-2" : "text-mute";
  const chevron = <ChevronDown aria-hidden size={size === "main" ? 16 : 14} className="shrink-0 text-mute" />;
  const lines = items.map((it) => (
    <span key={it.key} className="block">
      <span
        className={clsx(
          "flex items-center gap-1.5",
          size === "main" ? "text-2xl font-light" : "text-[0.9375rem]",
          it.skipped ? "text-mute" : nameTone,
        )}
      >
        <span className="min-w-0 wrap-anywhere">
          {it.tag && <span className="label mr-2 text-glow">{it.tag}</span>}
          {it.name}
        </span>
        {!superset && chevron}
      </span>
      {!superset && <span className="sr-only"> ({status ?? ALL_LOGGED}) </span>}
      {it.skipped ? (
        <span className="label block">Skipped today</span>
      ) : (
        <ResultLine summary={it.summary} className={clsx(size === "main" && "mt-1", resultTone)} />
      )}
      {/* Said in the row's name already (above): shown here for the eye. */}
      {!superset && status && (
        <span aria-hidden className="label mt-1 block text-fg-2">
          {status}
        </span>
      )}
    </span>
  ));
  return (
    <button
      type="button"
      aria-expanded={false}
      data-fold-toggle={blockId}
      onClick={onOpen}
      // The row's press tint and its reach into the gutter are the set rows'.
      className={clsx(
        "tap -mx-2 flex w-[calc(100%+1rem)] items-center gap-3 rounded-xl px-2 text-left select-none active:bg-white/[0.04]",
        size === "main" ? "min-h-[3.75rem] py-2" : "min-h-[3.25rem] py-1.5",
      )}
      style={noCallout}
    >
      <span className="block min-w-0 flex-1">
        {superset ? (
          <>
            <span className="flex min-h-7 items-center gap-2 text-glow">
              <Link2 size={12} aria-hidden />
              <span className="label text-glow">Superset {superset}</span>
              {chevron}
            </span>
            <span className="sr-only"> ({status ?? ALL_LOGGED}) </span>
            {/* The members keep the rail they have when the superset is open. */}
            <span className="mt-0.5 block space-y-1.5 border-l border-glow/25 pl-4">{lines}</span>
          </>
        ) : (
          lines
        )}
      </span>
      <CheckMark done tone={tone} size={size === "main" ? 26 : 22} />
    </button>
  );
}

/**
 * The same toggle on an open, finished block: its name in the header folds it again ("Lateral
 * raise (all sets logged)", expanded). `children` is the name as the header shows it. For a
 * superset — whose name opens its own sheet — pass `label` instead: the toggle is the chevron
 * alone, at the end of the superset's header.
 */
export function FoldToggle({
  blockId,
  onFold,
  size = "compact",
  label,
  status = ALL_LOGGED,
  className,
  children,
}: {
  blockId: string;
  onFold: () => void;
  size?: "main" | "compact";
  /** Said after the name in place of "all sets logged" (see `FoldedBlock`). */
  status?: string;
  /** Names a toggle that shows no text (a superset's): "Superset A". */
  label?: string;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-expanded
      aria-label={label ? `${label} (${status})` : undefined}
      data-fold-toggle={blockId}
      onClick={onFold}
      className={clsx(
        "tap min-h-11 rounded-xl select-none active:bg-white/[0.04]",
        label ? "-mr-3 grid w-11 shrink-0 place-items-center" : "-ml-2 flex min-w-0 items-center gap-1.5 px-2 text-left",
        className,
      )}
      style={noCallout}
    >
      {children}
      {!label && <span className="sr-only"> ({status}) </span>}
      <ChevronUp aria-hidden size={size === "main" || label ? 16 : 14} className="shrink-0 text-mute" />
    </button>
  );
}
