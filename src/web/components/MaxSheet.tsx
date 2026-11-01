import { useState } from "react";
import { Trash2 } from "lucide-react";
import { formatShortDate } from "../../shared/dates";
import { currentMax } from "../../shared/program";
import type { Exercise } from "../../shared/schemas";
import { fmt } from "../lib/format";
import { useAddMax, useData, useDeleteMax } from "../lib/store";
import { Sparkline } from "./charts";
import { BoxNumber, Sheet } from "./ui";

const SOURCE: Record<string, string> = { initial: "Starting max", manual: "Manual", amrap: "AMRAP" };

/** View a lift's max history and set a new max by hand. */
export function MaxSheet({ exercise, open, onClose }: { exercise: Exercise | null; open: boolean; onClose: () => void }) {
  const { data, today } = useData();
  const addMax = useAddMax();
  const deleteMax = useDeleteMax();
  const [value, setValue] = useState<number | null>(null);
  const [note, setNote] = useState("");
  if (!exercise) return null;
  const entries = data.maxEntries
    .filter((e) => e.exerciseId === exercise.id)
    .sort((a, b) => (a.date === b.date ? (a.createdAt < b.createdAt ? 1 : -1) : a.date < b.date ? 1 : -1));
  const current = currentMax(data.maxEntries, exercise.id);

  const submit = async () => {
    if (!value) return;
    await addMax({
      exerciseId: exercise.id,
      valueLb: value,
      date: today,
      source: current ? "manual" : "initial",
      note: note.trim() || null,
    });
    setValue(null);
    setNote("");
  };

  return (
    <Sheet open={open} onClose={onClose} title={exercise.name}>
      <div className="flex items-end justify-between">
        <div>
          <div className="label mb-1.5">Current max</div>
          <div className="num text-5xl font-light tracking-tight">
            {current ? fmt(current.valueLb, current.valueLb % 1 ? 1 : 0) : "—"}
            <span className="ml-1 text-base text-mute">lb</span>
          </div>
        </div>
        <Sparkline points={[...entries].reverse().map((e) => e.valueLb)} width={110} height={36} />
      </div>

      <div className="mt-8 flex items-center gap-3">
        <BoxNumber
          ariaLabel="New max"
          value={value}
          onCommit={setValue}
          unit="lb"
          decimals={1}
          placeholder={current ? String(current.valueLb) : "0"}
        />
        <input
          aria-label="Note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Note (optional)"
          className="field min-w-0 flex-1 rounded-xl bg-white/[0.05] px-3 py-2 text-sm"
        />
      </div>
      <button type="button" disabled={!value} className="btn-primary mt-3 w-full disabled:opacity-30" onClick={() => void submit()}>
        Set new max
      </button>

      <div className="label mt-10 mb-2">History</div>
      <ul className="divide-y divide-white/[0.04]">
        {entries.map((e) => (
          <li key={e.id} className="flex items-center gap-3 py-3">
            <div className="num w-16 text-lg font-light">{fmt(e.valueLb, e.valueLb % 1 ? 1 : 0)}</div>
            <div className="min-w-0 flex-1">
              <div className="text-xs text-fg-2">
                {formatShortDate(e.date, true)} · {SOURCE[e.source]}
              </div>
              {e.note && <div className="truncate text-xs text-mute">{e.note}</div>}
            </div>
            <button type="button" aria-label="Delete entry" className="tap p-2 text-faint" onClick={() => void deleteMax(e.id)}>
              <Trash2 size={14} />
            </button>
          </li>
        ))}
        {!entries.length && <li className="py-3 text-sm text-mute">No max recorded yet.</li>}
      </ul>
    </Sheet>
  );
}
