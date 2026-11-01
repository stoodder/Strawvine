import { useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import { formatShortDate } from "../../shared/dates";
import { currentMax } from "../../shared/program";
import type { Exercise, MaxEntry } from "../../shared/schemas";
import { fmt, parseNum } from "../lib/format";
import { useAddMax, useData, useDeleteMax, useMarkSeen } from "../lib/store";
import { Sparkline } from "./charts";
import { useToast } from "./Toast";
import { Sheet } from "./ui";

const fmtLb = (v: number) => fmt(v, v % 1 ? 1 : 0);
const SOURCE: Record<string, string> = { initial: "Starting max", manual: "Manual", amrap: "AMRAP" };

/** A typed max: 1 decimal, within the schema's range. */
function parseMax(text: string): number | null {
  const n = parseNum(text);
  return n !== null && n > 0 && n <= 2000 ? Math.round(n * 10) / 10 : null;
}

/** View a lift's max history and set a new max by hand. */
export function MaxSheet({ exercise, open, onClose }: { exercise: Exercise | null; open: boolean; onClose: () => void }) {
  const { data, today } = useData();
  const addMax = useAddMax();
  const deleteMax = useDeleteMax();
  const markSeen = useMarkSeen();
  const toast = useToast();
  // Raw text, so "Set new max" enables as soon as a number is typed (not on blur).
  const [text, setText] = useState("");
  const [note, setNote] = useState("");
  // The last deleted entry, offered back inline: a toast can't be reached while this sheet is open.
  const [removed, setRemoved] = useState<MaxEntry | null>(null);
  const restoredIds = useRef(new Set<number>());
  if (!exercise) return null;
  const entries = data.maxEntries
    .filter((e) => e.exerciseId === exercise.id)
    .sort((a, b) => (a.date === b.date ? (a.createdAt < b.createdAt ? 1 : -1) : a.date < b.date ? 1 : -1));
  const current = currentMax(data.maxEntries, exercise.id);
  const value = parseMax(text);

  const submit = async () => {
    if (!value) return;
    await addMax({
      exerciseId: exercise.id,
      valueLb: value,
      date: today,
      source: current ? "manual" : "initial",
      note: note.trim() || null,
    });
    setText("");
    setNote("");
  };

  const restore = (e: MaxEntry) => {
    if (restoredIds.current.has(e.id)) return;
    restoredIds.current.add(e.id);
    setRemoved((r) => (r?.id === e.id ? null : r));
    // Re-created (new id); it was already celebrated once, so don't celebrate it again.
    void addMax({ exerciseId: e.exerciseId, valueLb: e.valueLb, date: e.date, source: e.source, note: e.note })
      .then((saved) => markSeen([`max-${saved.id}`]))
      .catch(() => toast.show({ message: "Couldn't restore that entry", tone: "warn" }));
  };

  const remove = (e: MaxEntry) => {
    void deleteMax(e.id);
    setRemoved(e);
  };

  /** Closing with a removal still undoable hands the offer to a toast. */
  const close = () => {
    if (removed && !restoredIds.current.has(removed.id)) {
      const e = removed;
      toast.show({
        message: `Removed ${fmtLb(e.valueLb)} lb from ${formatShortDate(e.date)}`,
        action: { label: "Undo", onAction: () => restore(e) },
      });
    }
    setRemoved(null);
    onClose();
  };

  const inputBox = "h-11 rounded-xl bg-white/[0.05] px-3 text-base";

  return (
    <Sheet open={open} onClose={close} title={exercise.name}>
      <div className="flex items-end justify-between">
        <div>
          <div className="label mb-1.5">Current max</div>
          <div className="num text-5xl font-light tracking-tight">
            {current ? fmtLb(current.valueLb) : "—"}
            <span className="ml-1 text-base text-mute">lb</span>
          </div>
        </div>
        <Sparkline points={[...entries].reverse().map((e) => e.valueLb)} width={110} height={36} />
      </div>

      <form
        className="mt-8"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="flex items-center gap-3">
          <label className={`${inputBox} box-field flex shrink-0 items-center gap-1`}>
            <input
              aria-label="New max"
              inputMode="decimal"
              enterKeyHint="done"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onFocus={(e) => e.currentTarget.select()}
              placeholder={current ? String(current.valueLb) : "0"}
              className="field num w-16 text-right"
            />
            <span className="text-xs text-mute">lb</span>
          </label>
          <input
            aria-label="Note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Note (optional)"
            className={`field ${inputBox} min-w-0 flex-1`}
          />
        </div>
        <button type="submit" disabled={!value} className="btn-primary mt-3 w-full">
          Set new max
        </button>
      </form>

      <div className="label mt-10 mb-2">History</div>
      {removed && (
        <div className="flex items-center justify-between gap-3 rounded-2xl bg-white/[0.04] py-1 pr-1 pl-4 text-sm text-fg-2" role="status">
          <span>
            Removed <span className="num">{fmtLb(removed.valueLb)}</span> lb · {formatShortDate(removed.date)}
          </span>
          <button type="button" className="tap min-h-11 rounded-full px-4 font-medium text-accent" onClick={() => restore(removed)}>
            Undo
          </button>
        </div>
      )}
      <ul className="divide-y divide-white/[0.04]">
        {entries.map((e) => (
          <li key={e.id} className="flex items-center gap-3 py-1.5">
            <div className="num w-16 text-lg font-light">{fmtLb(e.valueLb)}</div>
            <div className="min-w-0 flex-1">
              <div className="text-xs text-fg-2">
                {formatShortDate(e.date, true)} · {SOURCE[e.source]}
              </div>
              {e.note && <div className="truncate text-xs text-mute">{e.note}</div>}
            </div>
            <button
              type="button"
              aria-label={`Delete ${fmtLb(e.valueLb)} lb entry from ${formatShortDate(e.date, true)}`}
              className="tap -mr-2 grid h-11 w-11 shrink-0 place-items-center text-faint hover:text-warn"
              onClick={() => remove(e)}
            >
              <Trash2 size={14} />
            </button>
          </li>
        ))}
        {!entries.length && <li className="py-3 text-sm text-mute">No max recorded yet.</li>}
      </ul>
    </Sheet>
  );
}
