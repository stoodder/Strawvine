import clsx from "clsx";
import { useRef, useState } from "react";
import { ChevronRight, Plus } from "lucide-react";
import type { Exercise } from "../../../shared/schemas";
import { useCreateExercise, useData } from "../../lib/store";
import { EditExerciseSheet } from "../train/EditExerciseSheet";
import { exerciseTag } from "../train/ExerciseFields";
import { Section } from "../ui";
import { useFocusAfter } from "../useFocusAfter";

/** The library row's tag: the exercise's tag (`exerciseTag`), then "max" when it tracks one (and "archived", shown apart). */
const libraryTag = (e: Exercise) => [exerciseTag(e), e.tracksMax ? "max" : null].filter(Boolean).join(" · ");

/** Program → Exercise library: every exercise, one tap from its Edit exercise sheet; add a tracked lift. */
export function LiftsEditor({ id }: { id?: string }) {
  const { data } = useData();
  const createExercise = useCreateExercise();
  const focusAfter = useFocusAfter();
  const showArchivedRef = useRef<HTMLButtonElement>(null);
  const [name, setName] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const editing = editingId === null ? null : (data.exercises.find((e) => e.id === editingId) ?? null);
  const list = data.exercises.filter((e) => showArchived || !e.archived);
  /**
   * After the sheet closes. An exercise archived while archived ones are hidden leaves the list
   * with the row that opened the sheet: focus goes to the next row (else the one before, else
   * "show archived") instead of falling to the page.
   */
  const closeEditor = (saved?: { archived?: boolean }) => {
    const id = editingId;
    setEditingId(null);
    if (!saved?.archived || showArchived || id === null) return;
    const at = list.findIndex((e) => e.id === id);
    const next = list[at + 1] ?? list[at - 1];
    focusAfter(() => (next ? document.querySelector<HTMLElement>(`[data-exercise="${next.id}"]`) : showArchivedRef.current));
  };
  return (
    <Section
      label="Exercise library"
      id={id}
      right={
        <button
          ref={showArchivedRef}
          type="button"
          aria-pressed={showArchived}
          className="label hit -my-2 py-2 text-mute"
          onClick={() => setShowArchived(!showArchived)}
        >
          {showArchived ? "hide archived" : "show archived"}
        </button>
      }
    >
      <ul className="divide-y divide-white/[0.04]">
        {list.map((e) => (
          <li key={e.id}>
            {/* One tap opens the Edit exercise sheet (name, category, measure, load, max, archive). */}
            <button
              type="button"
              aria-describedby={`lib-tag-${e.id}`}
              aria-haspopup="dialog"
              data-exercise={e.id}
              className="tap flex min-h-12 w-full items-center gap-2 py-2.5 text-left"
              onClick={() => setEditingId(e.id)}
            >
              {/* The tag drops under the name (right-aligned) when both don't fit on one line. */}
              <span className="flex min-w-0 flex-1 flex-wrap items-center justify-between gap-x-3 gap-y-0.5">
                {/* Named "Edit <name>"; the tag is its description rather than part of its name. An
                    archived one's name is dimmed; "archived" itself stays readable. */}
                <span className={clsx("min-w-0 text-sm [overflow-wrap:anywhere]", e.archived && "text-mute")}>
                  <span className="sr-only">Edit</span> {e.name}
                </span>
                <span id={`lib-tag-${e.id}`} aria-hidden className="label ml-auto text-right">
                  {libraryTag(e)}
                  {e.archived && (
                    <>
                      {" · "}
                      <span className="text-fg-2">archived</span>
                    </>
                  )}
                </span>
              </span>
              <ChevronRight size={14} className="shrink-0 text-mute" aria-hidden />
            </button>
          </li>
        ))}
      </ul>
      {/* Closing returns focus to the row that opened it (the sheet does that). */}
      <EditExerciseSheet exercise={editing} open={!!editing} onClose={closeEditor} />
      <div className="mt-4 flex gap-3">
        <input
          aria-label="New lift name"
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
          placeholder="New lift…"
          className="field min-w-0 flex-1 rounded-xl bg-white/[0.05] px-3 py-2 text-base"
        />
        <button
          type="button"
          disabled={!name.trim()}
          className="btn-ghost shrink-0"
          onClick={async () => {
            await createExercise({ name: name.trim(), category: "primary", measure: "reps", tracksMax: true });
            setName("");
          }}
        >
          <Plus size={16} /> Tracked lift
        </button>
      </div>
    </Section>
  );
}
