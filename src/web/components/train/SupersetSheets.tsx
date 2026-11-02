/**
 * Managing a workout's structure (§6.5): a superset's members (their A1, A2… order, taking one
 * out, adding one from this workout or a new one) and the order of the workout's accessory blocks.
 * Presentational: Train applies the edits (src/shared/sessionStructure) and says what changed in
 * `status`, which a polite live region in the sheet announces (the toast would sit over the sheet).
 *
 * Reordering is by Move up / Move down buttons (no drag: the sheet itself drags down to close, and
 * holding a set chip edits it). A button with nowhere to go (or a limit reached) is aria-disabled,
 * not disabled, so focus stays on it after the move that took its row to the end; it does nothing.
 */
import { ArrowDown, ArrowUp, Link2, Plus } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Sheet } from "../ui";

export interface MemberRow {
  /** Stable across reorders (React key; `data-member`). */
  key: string;
  name: string;
  /** "3 sets · 1 logged", "Skipped today". */
  detail: string;
}

export interface CandidateRow {
  key: string;
  name: string;
  /** Where it is now: "Superset B" when it would leave one; null for a single exercise. */
  from: string | null;
}

const iconBtn =
  "tap grid h-11 w-11 shrink-0 place-items-center rounded-2xl text-fg-2 aria-disabled:cursor-default aria-disabled:opacity-30";
/** A member: name | arrows | Remove on one line; below 24rem, Remove under the name (arrows span both rows). */
const memberRow =
  "grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-1 rounded-2xl bg-white/[0.04] py-1 pr-1 pl-4 max-[24rem]:grid-cols-[minmax(0,1fr)_auto]";
/** A visible "Remove" (a phone shows no tooltip), lined up under the name when narrow. */
const removeBtn =
  "tap inline-flex min-h-11 shrink-0 items-center rounded-2xl px-3 text-sm text-fg-2 aria-disabled:cursor-default aria-disabled:opacity-40 max-[24rem]:col-start-1 max-[24rem]:row-start-2 max-[24rem]:-mt-2 max-[24rem]:ml-6 max-[24rem]:justify-self-start";
const rowBox = "flex flex-wrap items-center gap-x-2 gap-y-1 rounded-2xl bg-white/[0.04] py-1 pr-1 pl-4";
const actionRow =
  "tap flex min-h-12 w-full items-center gap-3 rounded-2xl bg-white/[0.04] px-4 py-3 text-left aria-disabled:cursor-default aria-disabled:opacity-60";

function MoveButtons({
  name,
  where,
  index,
  count,
  onMove,
}: {
  name: string;
  /** "in Superset A", "in workout". */
  where: string;
  index: number;
  count: number;
  onMove: (delta: -1 | 1) => void;
}) {
  const first = index === 0;
  const last = index === count - 1;
  return (
    <span className="ml-auto flex shrink-0">
      <button
        type="button"
        aria-label={`Move ${name} up ${where}`}
        aria-disabled={first || undefined}
        data-move="up"
        className={iconBtn}
        onClick={first ? undefined : () => onMove(-1)}
      >
        <ArrowUp size={16} aria-hidden />
      </button>
      <button
        type="button"
        aria-label={`Move ${name} down ${where}`}
        aria-disabled={last || undefined}
        data-move="down"
        className={iconBtn}
        onClick={last ? undefined : () => onMove(1)}
      >
        <ArrowDown size={16} aria-hidden />
      </button>
    </span>
  );
}

/**
 * The sheet's polite live region. A screen reader announces what changes in one, not what it
 * holds as it mounts: a sheet that opens with news (it came back after "Add another exercise")
 * puts it in a moment after the region is there.
 */
export const STATUS_DELAY_MS = 250;
function Status({ children }: { children: string }) {
  const atMount = useRef(children);
  const [settled, setSettled] = useState(!children);
  useEffect(() => {
    if (settled) return;
    const t = window.setTimeout(() => setSettled(true), STATUS_DELAY_MS);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const text = settled || children !== atMount.current ? children : "";
  return (
    <div role="status" aria-live="polite" className="sr-only">
      {text && <span key={text}>{text}</span>}
    </div>
  );
}

/**
 * A superset's members in order, with move up / down and Remove each, then what can join it. For
 * a single exercise (`letter` null) it's how a superset starts: its one member and what to pair it
 * with. A full superset says so in place of what could join.
 */
export function SupersetSheet({
  open,
  onClose,
  letter,
  members,
  candidates,
  full,
  blocksFull,
  status,
  undo,
  onMove,
  onRemove,
  onAddExisting,
  onAddNew,
  limitNote,
}: {
  open: boolean;
  onClose: () => void;
  /** "A" for Superset A; null while the block holds one exercise. */
  letter: string | null;
  members: MemberRow[];
  candidates: CandidateRow[];
  /** The superset holds the most exercises it can: nothing more can join. */
  full: boolean;
  /** The session holds the most blocks it can: nothing can be taken out into a block of its own. */
  blocksFull: boolean;
  status: string;
  /** The last Remove, still undoable here: what it did ("Rows is on its own now…") and its name. */
  undo?: { label: string; name: string; onUndo: () => void } | null;
  onMove: (index: number, delta: -1 | 1) => void;
  onRemove: (index: number) => void;
  onAddExisting: (key: string) => void;
  onAddNew: () => void;
  /** "A superset holds up to 6 exercises", "A session holds up to 30 blocks". */
  limitNote: { superset: string; blocks: string };
}) {
  const id = useId();
  const superset = letter !== null && members.length > 1;
  const title = superset ? `Superset ${letter}` : "New superset";
  const where = superset ? `in Superset ${letter}` : "";
  return (
    <Sheet open={open} onClose={onClose} title={title}>
      <Status>{status}</Status>
      <div className="pb-2">
        {!superset && (
          <p className="mb-5 text-sm text-fg-2">
            Pair {members[0]?.name ?? "it"} with an exercise from this workout (it moves here with its sets) or another one.
          </p>
        )}
        <h4 className="label mb-2" tabIndex={-1} data-superset-members>
          {superset ? "Order · one round" : "Exercise"}
        </h4>
        <ol className="space-y-2">
          {members.map((m, i) => (
            // Name and controls on one line; below 24rem Remove goes under the name, so the
            // arrows never wrap onto a line of their own (a 320 px phone).
            <li key={m.key} data-member={m.key} className={memberRow}>
              <span className="flex min-h-11 min-w-0 items-center gap-3 py-1.5">
                {superset && (
                  <span className="label w-6 shrink-0 text-glow">
                    {`${letter}${i + 1}`}
                    <span className="sr-only">: </span>
                  </span>
                )}
                <span className="min-w-0 text-[0.9375rem] wrap-anywhere">
                  {m.name}
                  {m.detail && <span className="block text-xs text-fg-2">{m.detail}</span>}
                </span>
              </span>
              {superset && (
                <>
                  <span className="flex max-[24rem]:row-span-2">
                    <MoveButtons name={m.name} where={where} index={i} count={members.length} onMove={(d) => onMove(i, d)} />
                  </span>
                  <button
                    type="button"
                    aria-label={`Remove ${m.name} from Superset ${letter}`}
                    aria-describedby={blocksFull ? `${id}-blocks` : undefined}
                    aria-disabled={blocksFull || undefined}
                    data-remove=""
                    className={removeBtn}
                    onClick={blocksFull ? undefined : () => onRemove(i)}
                  >
                    Remove
                  </button>
                </>
              )}
            </li>
          ))}
        </ol>
        {superset && (
          <p className="mt-2 text-xs text-fg-2" id={`${id}-blocks`}>
            {blocksFull ? limitNote.blocks : "Remove keeps it in the workout, in a block of its own right after the superset."}
          </p>
        )}
        {undo && (
          <div className="mt-3 flex items-center gap-3 rounded-2xl bg-white/[0.04] py-1 pr-1 pl-4">
            <p className="min-w-0 flex-1 py-2 text-sm text-fg-2 wrap-anywhere">{undo.label}</p>
            <button
              type="button"
              aria-label={`Undo removing ${undo.name}`}
              data-undo=""
              className="tap min-h-11 shrink-0 rounded-full px-4 text-sm font-medium text-accent"
              onClick={undo.onUndo}
            >
              Undo
            </button>
          </div>
        )}

        <h4 className="label mt-6 mb-2">Add from this workout</h4>
        {full ? (
          <p id={`${id}-full`} className="text-sm text-fg-2">
            {limitNote.superset}
          </p>
        ) : candidates.length ? (
          <ul className="space-y-2">
            {candidates.map((c) => (
              <li key={c.key}>
                <button
                  type="button"
                  aria-label={superset ? `Add ${c.name} to Superset ${letter}` : `Superset ${members[0]?.name ?? ""} with ${c.name}`}
                  data-candidate={c.key}
                  className={actionRow}
                  onClick={() => onAddExisting(c.key)}
                >
                  <Link2 size={16} aria-hidden className="shrink-0 text-glow" />
                  <span className="min-w-0 flex-1 text-[0.9375rem] wrap-anywhere">
                    {c.name}
                    {c.from && <span className="block text-xs text-fg-2">Leaves {c.from}</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-fg-2">No other accessories in this workout yet.</p>
        )}
        <div className="mt-2">
          <button
            type="button"
            aria-haspopup="dialog"
            aria-describedby={full ? `${id}-full` : undefined}
            aria-disabled={full || undefined}
            data-add-new=""
            className={actionRow}
            onClick={full ? undefined : onAddNew}
          >
            <Plus size={16} aria-hidden className="shrink-0 text-glow" />
            <span className="min-w-0 flex-1">Add another exercise</span>
          </button>
        </div>
        <p className="mt-6 text-xs text-fg-2">The structure carries into next week's plan. The main lift stays on its own.</p>
      </div>
    </Sheet>
  );
}

export interface BlockRow {
  /** The block id. */
  key: string;
  /** "Superset A" for a superset, else the exercise's name. */
  title: string;
  /** A superset's members in order; empty for a single exercise. */
  members: string[];
}

/** The workout's accessory blocks in order, each with move up / down; the main lift stays first. */
export function WorkoutOrderSheet({
  open,
  onClose,
  mainLift,
  blocks,
  status,
  onMove,
}: {
  open: boolean;
  onClose: () => void;
  mainLift: string | null;
  blocks: BlockRow[];
  status: string;
  onMove: (index: number, delta: -1 | 1) => void;
}) {
  return (
    <Sheet open={open} onClose={onClose} title="Workout order">
      <Status>{status}</Status>
      <ol className="space-y-2 pb-2">
        {mainLift && (
          <li className="flex min-h-11 flex-wrap items-center gap-x-3 px-4 py-1.5">
            <span className="min-w-0 flex-1 text-[0.9375rem] wrap-anywhere text-fg-2">
              <span className="label block">Main lift</span>
              {mainLift}
            </span>
            <span className="text-xs text-fg-2">Stays first</span>
          </li>
        )}
        {blocks.map((b, i) => (
          <li key={b.key} data-order-block={b.key} className={rowBox}>
            <span className="flex min-h-11 min-w-[8rem] flex-1 items-center py-1.5">
              <span className="min-w-0 text-[0.9375rem] wrap-anywhere">
                {b.members.length ? (
                  <>
                    <span className="label flex items-center gap-1.5 text-glow">
                      <Link2 size={12} aria-hidden />
                      {b.title}
                    </span>
                    <span className="sr-only">: </span>
                    {joinNames(b.members)}
                  </>
                ) : (
                  b.title
                )}
              </span>
            </span>
            <MoveButtons name={b.title} where="in workout" index={i} count={blocks.length} onMove={(d) => onMove(i, d)} />
          </li>
        ))}
      </ol>
    </Sheet>
  );
}

function joinNames(names: string[]): ReactNode {
  return names.map((n, i) => (
    <span key={i}>
      {i > 0 && <span aria-hidden> · </span>}
      {i > 0 && <span className="sr-only">, </span>}
      {n}
    </span>
  ));
}
