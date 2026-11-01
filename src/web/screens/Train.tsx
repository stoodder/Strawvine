import clsx from "clsx";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ChevronLeft, ChevronRight, Link2, MoreHorizontal, Plus, RefreshCw, Timer } from "lucide-react";
import { addDays, formatShortDate, isISODate, weekdayName } from "../../shared/dates";
import { currentMax, cyclePosition, mainLiftSets, programDayFor, progressionGain } from "../../shared/program";
import type { Block, Exercise, Measure, Session, SetEntry } from "../../shared/schemas";
import { blankSet, buildSession, isSessionStarted, newId, sessionVolume } from "../../shared/session";
import { CheckDot, Empty, Section, Sheet } from "../components/ui";
import { AddExerciseSheet } from "../components/train/AddExerciseSheet";
import { AmrapSheet, measureUnit, Plates, SetEditSheet } from "../components/train/SetSheets";
import { MaxSheet } from "../components/MaxSheet";
import { JournalText } from "../components/TextArea";
import { fmt } from "../lib/format";
import { success, tick } from "../lib/haptics";
import { cachedSession, useAddMax, useCreateExercise, useData, useDeleteSession, useMarkSeen, useSaveSession } from "../lib/store";

type SetRef = { blockId: string; exIdx: number; setId: string };

export function TrainScreen() {
  const params = useParams();
  const navigate = useNavigate();
  const { data, today } = useData();
  const date = params.date && isISODate(params.date) ? params.date : today;
  const saveSession = useSaveSession();
  const deleteSession = useDeleteSession();
  const addMax = useAddMax();
  const createExercise = useCreateExercise();
  const markSeen = useMarkSeen();

  const saved = data.sessions.find((s) => s.date === date) ?? null;
  const program = data.settings.program;
  const programDay = programDayFor(program, date);
  const pos = cyclePosition(program, date);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const draft = useMemo(
    () => (saved ? null : buildSession(date, data)),
    [saved, date, data.settings, data.maxEntries, data.exercises, data.sessions],
  );
  const session = saved ?? draft!;
  const isPlannedDay = !!programDay || !!saved;

  const [editing, setEditing] = useState<SetRef | null>(null);
  const [amrap, setAmrap] = useState<SetRef | null>(null);
  const [adding, setAdding] = useState<{ mode: "new" } | { mode: "pair"; blockId: string } | null>(null);
  const [actions, setActions] = useState<{ blockId: string; exIdx: number } | null>(null);
  const [maxFor, setMaxFor] = useState<Exercise | null>(null);
  const [restFrom, setRestFrom] = useState<number | null>(null);

  const exById = (id: number) => data.exercises.find((e) => e.id === id);
  const update = (s: Session) => saveSession(s);
  const mapBlock = (s: Session, blockId: string, fn: (b: Block) => Block | null): Session => ({
    ...s,
    blocks: s.blocks.map((b) => (b.id === blockId ? fn(b) : b)).filter((b): b is Block => b !== null),
  });
  const mapSet = (s: Session, ref: SetRef, fn: (x: SetEntry) => SetEntry | null): Session =>
    mapBlock(s, ref.blockId, (b) => ({
      ...b,
      exercises: b.exercises.map((e, i) =>
        i === ref.exIdx ? { ...e, sets: e.sets.map((x) => (x.id === ref.setId ? fn(x) : x)).filter((x): x is SetEntry => x !== null) } : e,
      ),
    }));
  const findSet = (ref: SetRef | null) => {
    if (!ref) return null;
    const b = session.blocks.find((x) => x.id === ref.blockId);
    const e = b?.exercises[ref.exIdx];
    const s = e?.sets.find((x) => x.id === ref.setId);
    return b && e && s ? { block: b, ex: e, set: s } : null;
  };

  const toggleDone = (ref: SetRef) => {
    const found = findSet(ref);
    if (!found) return;
    if (found.set.amrap && !found.set.done) return setAmrap(ref);
    const next = mapSet(session, ref, (x) =>
      x.done ? { ...x, done: false } : { ...x, done: true, reps: x.reps ?? x.targetReps, weight: x.weight ?? x.targetWeight },
    );
    update(next);
    if (!found.set.done) setRestFrom(Date.now());
  };

  const primaryBlock = session.blocks.find((b) => b.kind === "primary");
  const primaryExId = primaryBlock?.exercises[0]?.exerciseId;
  const primaryMax = primaryExId != null ? currentMax(data.maxEntries, primaryExId) : null;
  const primaryStarted = primaryBlock?.exercises[0]?.sets.some((s) => s.done) ?? false;
  const outOfSync = !!saved && primaryBlock && primaryMax && session.primaryMaxLb !== primaryMax.valueLb && !primaryStarted;

  const resyncPrimary = () => {
    if (!primaryBlock || !primaryMax || !pos) return;
    const planned = mainLiftSets(program, primaryMax.valueLb, pos.week, { progressionDay: !!programDay?.progression });
    update({
      ...mapBlock(session, primaryBlock.id, (b) => ({
        ...b,
        exercises: [
          { ...b.exercises[0]!, sets: planned.map((p) => blankSet({ targetReps: p.reps, targetWeight: p.weightLb, amrap: p.amrap })) },
        ],
      })),
      primaryMaxLb: primaryMax.valueLb,
    });
  };

  const recentIds = useMemo(() => {
    const ids: number[] = [];
    for (const s of [...data.sessions].sort((a, b) => (a.date < b.date ? 1 : -1)))
      for (const b of s.blocks) for (const e of b.exercises) if (!ids.includes(e.exerciseId)) ids.push(e.exerciseId);
    return ids;
  }, [data.sessions]);

  /** Prefill new exercise from the last time it was performed. */
  const lastSets = (exerciseId: number): SetEntry[] | null => {
    for (const s of [...data.sessions].filter((x) => x.date < date).sort((a, b) => (a.date < b.date ? 1 : -1)))
      for (const b of s.blocks) for (const e of b.exercises) if (e.exerciseId === exerciseId && e.sets.length) return e.sets;
    return null;
  };

  const addExercise = (ex: Exercise) => {
    const prev = lastSets(ex.id);
    const defaultReps = ex.measure === "reps" ? 10 : ex.measure === "seconds" ? 30 : 40;
    const sets = prev
      ? prev.map((p) => blankSet({ targetReps: p.reps ?? p.targetReps, targetWeight: p.weight ?? p.targetWeight }))
      : Array.from({ length: 3 }, () => blankSet({ targetReps: defaultReps }));
    const item = { exerciseId: ex.id, measure: ex.measure, sets };
    if (adding?.mode === "pair") update(mapBlock(session, adding.blockId, (b) => ({ ...b, exercises: [...b.exercises, item] })));
    else update({ ...session, blocks: [...session.blocks, { id: newId(), kind: "accessory", exercises: [item] }] });
    tick();
    setAdding(null);
  };

  const editingFound = findSet(editing);
  const amrapFound = findSet(amrap);
  const volume = sessionVolume(session);
  const totalSets = session.blocks.reduce((n, b) => n + b.exercises.reduce((m, e) => m + e.sets.length, 0), 0);
  const doneSets = session.blocks.reduce((n, b) => n + b.exercises.reduce((m, e) => m + e.sets.filter((s) => s.done).length, 0), 0);

  const go = (d: string) => navigate(d === today ? "/train" : `/train/${d}`);

  let accessoryLetter = 0;

  return (
    <div>
      <header className="flex items-center justify-between pt-2">
        <div className="flex items-center gap-1">
          <button type="button" aria-label="Previous day" onClick={() => go(addDays(date, -1))} className="tap -ml-2 p-2 text-mute">
            <ChevronLeft size={18} />
          </button>
          <div className="label text-fg-2">
            {weekdayName(date, true)} · {formatShortDate(date)}
          </div>
          <button type="button" aria-label="Next day" onClick={() => go(addDays(date, 1))} className="tap p-2 text-mute">
            <ChevronRight size={18} />
          </button>
        </div>
        {pos && (
          <div className="label">
            Cycle {pos.cycle} ·{" "}
            {pos.week.deload ? <span className="text-glow">Deload</span> : `Week ${pos.weekIndex + 1}/${program.weeks.length}`}
          </div>
        )}
      </header>

      <div className="mt-6">
        <h1 className="text-[44px] leading-none font-light tracking-tight">{session.label}</h1>
        <p className="mt-3 text-sm text-mute">
          {totalSets ? (
            <>
              <span className="num text-fg-2">{doneSets}</span>/{totalSets} sets
              {volume > 0 && (
                <>
                  {" "}
                  · <span className="num text-fg-2">{fmt(volume)}</span> lb moved
                </>
              )}
            </>
          ) : isPlannedDay ? (
            "Build today's work below."
          ) : (
            "No lifting scheduled."
          )}
        </p>
      </div>

      {!isPlannedDay && !saved ? (
        <div className="mt-10">
          <Empty>Rest from the barbell today. Metcon, zone 2 and steps still count toward closing the day.</Empty>
          <div className="flex gap-3">
            <button type="button" className="btn-ghost" onClick={() => update({ ...session, label: "Extra session" })}>
              <Plus size={16} /> Start a session anyway
            </button>
            <Link to="/" className="btn-ghost">
              Back to today
            </Link>
          </div>
        </div>
      ) : (
        <>
          {/* Main lift */}
          {primaryBlock && primaryExId != null && (
            <Section
              label="Main lift"
              right={
                <button type="button" className="label text-mute" onClick={() => setMaxFor(exById(primaryExId) ?? null)}>
                  max <span className="num text-fg-2">{fmt(primaryMax?.valueLb ?? session.primaryMaxLb, 0)}</span>
                </button>
              }
            >
              <div className="mb-4 flex items-baseline justify-between">
                <div className="text-2xl font-light">{exById(primaryExId)?.name}</div>
                {session.deload && <span className="label text-glow">deload · 4×10</span>}
              </div>
              {outOfSync && (
                <button type="button" onClick={resyncPrimary} className="chip mb-4 bg-accent/10 text-accent">
                  <RefreshCw size={12} className="mr-1.5" /> Recalculate from new max ({fmt(primaryMax!.valueLb)})
                </button>
              )}
              <div>
                {primaryBlock.exercises[0]!.sets.map((s, i) => {
                  const ref = { blockId: primaryBlock.id, exIdx: 0, setId: s.id };
                  const beat = s.amrap && s.done && s.reps !== null && s.targetReps !== null && s.reps > s.targetReps;
                  return (
                    <div key={s.id} className="group flex items-center gap-4 py-3">
                      <span className="label w-5">{i + 1}</span>
                      <button
                        type="button"
                        className="tap flex min-w-0 flex-1 items-baseline gap-2 text-left"
                        onClick={() => (s.amrap ? setAmrap(ref) : setEditing(ref))}
                      >
                        <span className={clsx("num text-3xl font-light tracking-tight", s.done ? "text-fg" : "text-fg-2")}>
                          {s.done ? s.weight : s.targetWeight}
                        </span>
                        <span className="text-sm text-mute">
                          × {s.done ? s.reps : s.targetReps}
                          {s.amrap && !s.done && "+"}
                        </span>
                        {s.amrap && (
                          <span className={clsx("label ml-1", beat ? "text-gold" : "text-accent")}>
                            {beat ? `+${s.reps! - s.targetReps!} reps` : "AMRAP"}
                          </span>
                        )}
                        {s.appliedProgressionLb ? <span className="label text-gold">+{s.appliedProgressionLb} lb</span> : null}
                      </button>
                      <CheckDot done={s.done} tone={beat ? "gold" : "accent"} onClick={() => toggleDone(ref)} label={`Set ${i + 1}`} />
                    </div>
                  );
                })}
              </div>
              <div className="mt-2 min-h-6">
                <Plates weight={primaryBlock.exercises[0]!.sets.find((s) => !s.done)?.targetWeight ?? null} />
              </div>
            </Section>
          )}

          {!primaryBlock && programDay?.primaryExerciseId != null && !primaryMax && (
            <Section label="Main lift">
              <Empty>
                Set a max for {exById(programDay.primaryExerciseId)?.name ?? "this lift"} and the working sets calculate themselves.{" "}
                <button type="button" className="text-accent" onClick={() => setMaxFor(exById(programDay.primaryExerciseId!) ?? null)}>
                  Set max →
                </button>
              </Empty>
            </Section>
          )}

          {/* Accessories */}
          <Section label="Accessories">
            {session.blocks
              .filter((b) => b.kind === "accessory")
              .map((b) => {
                const superset = b.exercises.length > 1;
                const letter = String.fromCharCode(65 + accessoryLetter++);
                return (
                  <div key={b.id} className="mb-8">
                    {superset && (
                      <div className="mb-2 flex items-center gap-2 text-glow">
                        <Link2 size={12} />
                        <span className="label text-glow">Superset {letter}</span>
                      </div>
                    )}
                    <div className={clsx(superset && "border-l border-glow/25 pl-4")}>
                      {b.exercises.map((e, exIdx) => {
                        const ex = exById(e.exerciseId);
                        return (
                          <div key={exIdx} className={clsx(exIdx > 0 && "mt-5")}>
                            <div className="flex items-center justify-between">
                              <div className="text-[15px]">
                                {superset && <span className="label mr-2 text-glow">{`${letter}${exIdx + 1}`}</span>}
                                {ex?.name ?? "Exercise"}
                              </div>
                              <button
                                type="button"
                                aria-label="Exercise options"
                                className="tap -mr-2 p-2 text-mute"
                                onClick={() => setActions({ blockId: b.id, exIdx })}
                              >
                                <MoreHorizontal size={16} />
                              </button>
                            </div>
                            <div className="mt-1 flex flex-wrap gap-2">
                              {e.sets.map((s, si) => {
                                const ref = { blockId: b.id, exIdx, setId: s.id };
                                return (
                                  <SetChip
                                    key={s.id}
                                    index={si}
                                    set={s}
                                    measure={e.measure}
                                    onTap={() => toggleDone(ref)}
                                    onLongPress={() => setEditing(ref)}
                                  />
                                );
                              })}
                              <button
                                type="button"
                                aria-label="Add set"
                                className="tap grid h-[52px] w-11 place-items-center rounded-2xl text-faint ring-1 ring-white/[0.06] ring-inset"
                                onClick={() => {
                                  const last = e.sets[e.sets.length - 1];
                                  update(
                                    mapBlock(session, b.id, (bb) => ({
                                      ...bb,
                                      exercises: bb.exercises.map((x, i) =>
                                        i === exIdx
                                          ? {
                                              ...x,
                                              sets: [
                                                ...x.sets,
                                                blankSet({
                                                  targetReps: last?.reps ?? last?.targetReps ?? null,
                                                  targetWeight: last?.weight ?? last?.targetWeight ?? null,
                                                }),
                                              ],
                                            }
                                          : x,
                                      ),
                                    })),
                                  );
                                }}
                              >
                                <Plus size={14} />
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            {!session.blocks.some((b) => b.kind === "accessory") && (
              <p className="mb-6 text-sm text-mute">
                Add the accessories and core work for today — next {weekdayName(date)} they'll be here waiting.
              </p>
            )}
            <div className="flex gap-3">
              <button type="button" className="btn-ghost" onClick={() => setAdding({ mode: "new" })}>
                <Plus size={16} /> Exercise
              </button>
            </div>
            <p className="mt-4 text-xs text-faint">Tap a set to log it · hold to edit</p>
          </Section>

          <Section label="Notes">
            <JournalText
              key={date}
              ariaLabel="Session notes"
              value={session.notes || null}
              onSave={(v) => update({ ...(cachedSession(date) ?? session), notes: v ?? "" })}
              placeholder="Cues, feel, what to change next time…"
              minRows={2}
            />
          </Section>

          <div className="mt-10 flex flex-col items-center gap-4">
            {session.completedAt ? (
              <>
                <div className="label text-accent">Session complete</div>
                <button type="button" className="btn-ghost" onClick={() => update({ ...session, completedAt: null })}>
                  Reopen
                </button>
              </>
            ) : (
              <button
                type="button"
                className="btn-primary w-full py-3.5 text-base"
                onClick={() => {
                  success();
                  update({ ...session, completedAt: new Date().toISOString() });
                  setRestFrom(null);
                }}
              >
                Finish session
              </button>
            )}
            {saved && !isSessionStarted(session) && !session.completedAt && (
              <button type="button" className="label text-faint" onClick={() => deleteSession(date)}>
                Reset to plan
              </button>
            )}
          </div>
        </>
      )}

      <RestTimer from={restFrom} onDismiss={() => setRestFrom(null)} />

      <SetEditSheet
        open={!!editingFound}
        onClose={() => setEditing(null)}
        title={editingFound ? `${exById(editingFound.ex.exerciseId)?.name ?? "Set"}` : ""}
        set={editingFound?.set ?? null}
        measure={editingFound?.ex.measure ?? "reps"}
        onSave={(s) => {
          if (!editing) return;
          if (s.done && !editingFound?.set.done) setRestFrom(Date.now());
          update(mapSet(session, editing, () => s));
          setEditing(null);
        }}
        onDelete={
          editingFound && editingFound.block.kind === "accessory"
            ? () => {
                if (!editing) return;
                update(mapSet(session, editing, () => null));
                setEditing(null);
              }
            : undefined
        }
      />

      <AmrapSheet
        open={!!amrapFound}
        onClose={() => setAmrap(null)}
        set={amrapFound?.set ?? null}
        exerciseName={amrapFound ? (exById(amrapFound.ex.exerciseId)?.name ?? "") : ""}
        currentMaxLb={primaryMax?.valueLb ?? null}
        lbPerExtraRep={program.progression.lbPerExtraRep}
        progressionEnabled={program.progression.enabled}
        onLog={(reps) => {
          if (!amrap) return;
          update(mapSet(session, amrap, (x) => ({ ...x, done: true, reps, weight: x.weight ?? x.targetWeight })));
          setRestFrom(Date.now());
        }}
        onApply={async (gain, reps) => {
          if (!amrap || !amrapFound || !primaryMax) return;
          const g = progressionGain(program, amrapFound.set.targetReps ?? 0, reps) || gain;
          const entry = await addMax({
            exerciseId: amrapFound.ex.exerciseId,
            valueLb: primaryMax.valueLb + g,
            date,
            source: "amrap",
            note: `${reps} reps vs ${amrapFound.set.targetReps} @ ${amrapFound.set.weight ?? amrapFound.set.targetWeight} lb`,
          });
          markSeen([`max-${entry.id}`]);
          // Read the freshest copy after the await: onLog just marked the set done.
          update(mapSet(cachedSession(date) ?? session, amrap, (x) => ({ ...x, done: true, reps, appliedProgressionLb: g })));
        }}
      />

      <AddExerciseSheet
        open={!!adding}
        onClose={() => setAdding(null)}
        title={adding?.mode === "pair" ? "Add to superset" : "Add exercise"}
        exercises={data.exercises}
        recentIds={recentIds}
        onPick={addExercise}
        onCreate={async (input) => addExercise(await createExercise(input))}
      />

      <Sheet
        open={!!actions}
        onClose={() => setActions(null)}
        title={
          actions ? exById(session.blocks.find((b) => b.id === actions.blockId)?.exercises[actions.exIdx]?.exerciseId ?? -1)?.name : ""
        }
      >
        {actions && (
          <div className="space-y-2 pb-2">
            <button
              type="button"
              className="tap flex w-full items-center gap-3 rounded-2xl bg-white/[0.04] px-4 py-3.5 text-left"
              onClick={() => {
                setAdding({ mode: "pair", blockId: actions.blockId });
                setActions(null);
              }}
            >
              <Link2 size={16} className="text-glow" /> Superset with another exercise
            </button>
            {(session.blocks.find((b) => b.id === actions.blockId)?.exercises.length ?? 0) > 1 && (
              <button
                type="button"
                className="tap flex w-full items-center gap-3 rounded-2xl bg-white/[0.04] px-4 py-3.5 text-left"
                onClick={() => {
                  const block = session.blocks.find((b) => b.id === actions.blockId)!;
                  const ex = block.exercises[actions.exIdx]!;
                  const without = mapBlock(session, block.id, (b) => ({
                    ...b,
                    exercises: b.exercises.filter((_, i) => i !== actions.exIdx),
                  }));
                  const idx = without.blocks.findIndex((b) => b.id === block.id);
                  const blocks = [...without.blocks];
                  blocks.splice(idx + 1, 0, { id: newId(), kind: "accessory", exercises: [ex] });
                  update({ ...without, blocks });
                  setActions(null);
                }}
              >
                Split out of superset
              </button>
            )}
            <button
              type="button"
              className="tap flex w-full items-center gap-3 rounded-2xl bg-white/[0.04] px-4 py-3.5 text-left text-warn"
              onClick={() => {
                update(
                  mapBlock(session, actions.blockId, (b) => {
                    const exercises = b.exercises.filter((_, i) => i !== actions.exIdx);
                    return exercises.length ? { ...b, exercises } : null;
                  }),
                );
                setActions(null);
              }}
            >
              Remove from today
            </button>
          </div>
        )}
      </Sheet>

      <MaxSheet exercise={maxFor} open={!!maxFor} onClose={() => setMaxFor(null)} />
    </div>
  );
}

function SetChip({
  index,
  set,
  measure,
  onTap,
  onLongPress,
}: {
  index: number;
  set: SetEntry;
  measure: Measure;
  onTap: () => void;
  onLongPress: () => void;
}) {
  const [timer, setTimer] = useState<number | null>(null);
  const [long, setLong] = useState(false);
  const reps = set.done ? set.reps : set.targetReps;
  const weight = set.done ? set.weight : set.targetWeight;
  const unit = measureUnit(measure);
  return (
    <motion.button
      type="button"
      aria-label={`Set ${index + 1}: ${reps ?? "?"}${unit} ${weight ? `at ${weight} lb` : ""}${set.done ? ", done" : ""}`}
      className={clsx(
        "relative flex h-[52px] min-w-[64px] flex-col items-center justify-center rounded-2xl px-3 select-none",
        set.done ? "bg-accent/[0.13] text-fg ring-1 ring-accent/40 ring-inset" : "bg-white/[0.035] text-fg-2",
      )}
      whileTap={{ scale: 0.95 }}
      animate={set.done ? { boxShadow: "0 0 22px -8px rgb(183 243 106 / 0.7)" } : { boxShadow: "0 0 0 0 rgba(0,0,0,0)" }}
      onPointerDown={() => {
        setLong(false);
        setTimer(
          window.setTimeout(() => {
            setLong(true);
            tick();
            onLongPress();
          }, 420),
        );
      }}
      onPointerUp={() => timer && window.clearTimeout(timer)}
      onPointerLeave={() => timer && window.clearTimeout(timer)}
      onContextMenu={(e) => e.preventDefault()}
      onClick={() => {
        if (long) return;
        onTap();
      }}
    >
      <span className="num text-[15px] leading-none">
        {reps ?? "—"}
        {unit && <span className="text-[10px] text-mute">{unit}</span>}
      </span>
      {weight ? <span className="num mt-1 text-[10px] leading-none text-mute">{weight}</span> : null}
    </motion.button>
  );
}

function RestTimer({ from, onDismiss }: { from: number | null; onDismiss: () => void }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (from === null) return;
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [from]);
  const secs = from === null ? 0 : Math.max(0, Math.floor((now - from) / 1000));
  useEffect(() => {
    if (secs >= 600) onDismiss();
  }, [secs, onDismiss]);
  return (
    <AnimatePresence>
      {from !== null && (
        <motion.button
          type="button"
          onClick={onDismiss}
          aria-label="Rest timer, tap to dismiss"
          className="fixed top-[max(env(safe-area-inset-top),0.75rem)] left-1/2 z-30 flex -translate-x-1/2 items-center gap-2 rounded-full bg-ink-700/90 px-4 py-2 text-sm shadow-lg ring-1 ring-white/[0.06] backdrop-blur-xl"
          initial={{ y: -20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: -20, opacity: 0 }}
        >
          <Timer size={14} className={secs >= 90 ? "text-accent" : "text-mute"} />
          <span className="label">Rest</span>
          <span className={clsx("num", secs >= 90 ? "text-accent" : "text-fg")}>
            {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, "0")}
          </span>
        </motion.button>
      )}
    </AnimatePresence>
  );
}
