import clsx from "clsx";
import { useMemo, useState } from "react";
import { Plus, Search } from "lucide-react";
import type { Exercise, ExerciseCategory, Measure } from "../../../shared/schemas";
import { Sheet } from "../ui";

const CATEGORIES: Array<[ExerciseCategory, string]> = [
  ["accessory", "Accessory"],
  ["core", "Core"],
  ["carry", "Carry"],
  ["primary", "Compound"],
  ["conditioning", "Conditioning"],
];
const MEASURES: Array<[Measure, string]> = [
  ["reps", "Reps"],
  ["seconds", "Time"],
  ["meters", "Distance"],
];

export function AddExerciseSheet({
  open,
  onClose,
  title,
  exercises,
  recentIds,
  onPick,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  exercises: ReadonlyArray<Exercise>;
  recentIds: number[];
  onPick: (ex: Exercise) => void;
  onCreate: (input: { name: string; category: ExerciseCategory; measure: Measure }) => Promise<void>;
}) {
  const [q, setQ] = useState("");
  const [category, setCategory] = useState<ExerciseCategory>("accessory");
  const [measure, setMeasure] = useState<Measure>("reps");
  const [busy, setBusy] = useState(false);

  const list = useMemo(() => {
    const active = exercises.filter((e) => !e.archived);
    const needle = q.trim().toLowerCase();
    const matched = needle ? active.filter((e) => e.name.toLowerCase().includes(needle)) : active;
    const rank = (e: Exercise) => {
      const r = recentIds.indexOf(e.id);
      return r === -1 ? 1000 + e.id : r;
    };
    return [...matched].sort((a, b) => rank(a) - rank(b));
  }, [exercises, q, recentIds]);

  const exact = list.some((e) => e.name.toLowerCase() === q.trim().toLowerCase());

  const close = () => {
    setQ("");
    onClose();
  };

  return (
    <Sheet open={open} onClose={close} title={title}>
      <div className="flex items-center gap-3 rounded-2xl bg-white/[0.05] px-4 py-3">
        <Search size={16} className="text-mute" />
        <input
          aria-label="Search or create exercise"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search or create…"
          className="field flex-1"
          autoFocus
        />
      </div>

      {q.trim() && !exact && (
        <div className="mt-5 rounded-2xl bg-accent/[0.06] p-4 ring-1 ring-accent/20">
          <div className="text-sm">
            Create <span className="text-accent">“{q.trim()}”</span>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {CATEGORIES.map(([k, l]) => (
              <button
                key={k}
                type="button"
                onClick={() => setCategory(k)}
                className={clsx("chip", category === k ? "bg-accent text-accent-ink" : "bg-white/[0.05] text-fg-2")}
              >
                {l}
              </button>
            ))}
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            {MEASURES.map(([k, l]) => (
              <button
                key={k}
                type="button"
                onClick={() => setMeasure(k)}
                className={clsx("chip", measure === k ? "bg-fg text-ink-950" : "bg-white/[0.05] text-fg-2")}
              >
                {l}
              </button>
            ))}
          </div>
          <button
            type="button"
            disabled={busy}
            className="btn-primary mt-4 w-full"
            onClick={async () => {
              setBusy(true);
              try {
                await onCreate({ name: q.trim(), category, measure });
                setQ("");
              } finally {
                setBusy(false);
              }
            }}
          >
            <Plus size={16} /> Create & add
          </button>
        </div>
      )}

      <ul className="mt-4 divide-y divide-white/[0.04]">
        {list.map((e) => (
          <li key={e.id}>
            <button
              type="button"
              className="tap flex w-full items-center justify-between py-3.5 text-left"
              onClick={() => {
                onPick(e);
                setQ("");
              }}
            >
              <span className="text-[15px]">{e.name}</span>
              <span className="label">{e.measure === "reps" ? e.category : e.measure === "seconds" ? "time" : "distance"}</span>
            </button>
          </li>
        ))}
      </ul>
    </Sheet>
  );
}
