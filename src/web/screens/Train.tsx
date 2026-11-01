import clsx from "clsx";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { Check, ChevronLeft, ChevronRight, Link2, MoreHorizontal, Plus, RefreshCw, Trash2 } from "lucide-react";
import { addDays, formatShortDate, isISODate, weekdayName } from "../../shared/dates";
import { currentMax, cyclePosition, programDayFor, progressionGain } from "../../shared/program";
import type { Block, Exercise, Session, SetEntry } from "../../shared/schemas";
import { blankSet, buildSession, isSessionStarted, newId, sessionVolume } from "../../shared/session";
import { CheckDot, Empty, Section, Sheet } from "../components/ui";
import { useToast } from "../components/Toast";
import { AddExerciseSheet } from "../components/train/AddExerciseSheet";
import { FinishPanel } from "../components/train/FinishPanel";
import { RestTimer, useRestTimer } from "../components/train/RestTimer";
import { MainSetButton, SetChip } from "../components/train/SetControls";
import { AmrapSheet, measureUnit, Plates, SetEditSheet } from "../components/train/SetSheets";
import {
  describeSet,
  findSet,
  mapBlock,
  mapExercise,
  mapSet,
  planSignature,
  replaceSetAndPropagate,
  repScheme,
  type ExRef,
  type SetRef,
} from "../components/train/sessionEdit";
import { MaxSheet } from "../components/MaxSheet";
import { JournalText } from "../components/TextArea";
import { fmt } from "../lib/format";
import { success, tick } from "../lib/haptics";
import { cachedSession, useAddMax, useCreateExercise, useData, useDeleteSession, useMarkSeen, useSaveSession } from "../lib/store";
import { useTitle } from "../components/useTitle";

const MAX_SETS = 30;

/** What the plan prescribes for the main lift, for "has the plan changed?" (ids and loads aside). */
function primaryShape(s: Session, count?: number): string {
  const e = s.blocks.find((b) => b.kind === "primary")?.exercises[0];
  if (!e) return "none";
  return JSON.stringify([e.exerciseId, s.deload, e.sets.slice(0, count ?? e.sets.length).map((x) => [x.targetReps, x.amrap])]);
}

export function TrainScreen() {
  const params = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { data, today } = useData();
  useTitle("Train");
  // Without a :date, show the day the screen was opened on (re-pinned on each navigation),
  // not a live "today": a session that runs past midnight keeps logging into its own day.
  const [opened, setOpened] = useState({ key: location.key, today });
  if (opened.key !== location.key) setOpened({ key: location.key, today });
  const requested = params.date && isISODate(params.date) ? params.date : opened.key === location.key ? opened.today : today;
  // No logging into the future (matches Today).
  const date = requested > today ? today : requested;
  const isToday = date === today;
  const saveSession = useSaveSession();
  const deleteSession = useDeleteSession();
  const addMax = useAddMax();
  const createExercise = useCreateExercise();
  const markSeen = useMarkSeen();
  const toast = useToast();
  const rest = useRestTimer();
  const hintId = useId();

  const saved = data.sessions.find((s) => s.date === date) ?? null;
  const program = data.settings.program;
  const programDay = programDayFor(program, date);
  const pos = cyclePosition(program, date);

  /** Today's plan as the program + history would build it right now. */
  const fresh = useMemo(
    () => buildSession(date, data),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [date, data.settings, data.maxEntries, data.exercises, data.sessions],
  );
  /**
   * An unsaved day is shown as a live draft: it follows plan changes until the first real edit
   * persists it (merely viewing or opening a sheet doesn't). The same plan keeps the same draft
   * object, so set ids held by open sheets stay valid across unrelated data changes.
   */
  const draftCache = useRef<{ sig: string; session: Session } | null>(null);
  const draft = useMemo(() => {
    if (saved) return null;
    const sig = planSignature(fresh);
    if (draftCache.current?.sig === sig) return draftCache.current.session;
    draftCache.current = { sig, session: fresh };
    return fresh;
  }, [saved, fresh]);
  const session = saved ?? draft!;
  const isPlannedDay = !!programDay || !!saved;

  const [editing, setEditing] = useState<SetRef | null>(null);
  const [amrap, setAmrap] = useState<SetRef | null>(null);
  const [adding, setAdding] = useState<{ mode: "new" } | { mode: "pair"; blockId: string } | null>(null);
  const [actions, setActions] = useState<ExRef | null>(null);
  const [maxFor, setMaxFor] = useState<Exercise | null>(null);

  const exById = (id: number) => data.exercises.find((e) => e.id === id);
  const exName = (id: number) => exById(id)?.name ?? "Exercise";

  // --- Undo toasts --------------------------------------------------------------------------
  const lastToast = useRef<number | null>(null);
  const [toastUp, setToastUp] = useState(false);
  const toastUpTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(toastUpTimer.current), []);
  const offerUndo = (message: string, onUndo: () => void, duration = 7000) => {
    if (lastToast.current !== null) toast.dismiss(lastToast.current);
    lastToast.current = toast.show({ message, duration, action: { label: "Undo", onAction: onUndo } });
    // Lift the rest timer clear of the toast while it shows.
    setToastUp(true);
    window.clearTimeout(toastUpTimer.current);
    toastUpTimer.current = window.setTimeout(() => setToastUp(false), duration);
  };

  // A sheet makes the app (and its toasts) inert and the toast would sit over the sheet's
  // buttons: retire the last undo offer when one opens.
  const sheetOpen = !!(editing || amrap || adding || actions || maxFor);
  useEffect(() => {
    if (sheetOpen && lastToast.current !== null) {
      toast.dismiss(lastToast.current);
      lastToast.current = null;
      setToastUp(false);
    }
  }, [sheetOpen, toast]);

  /**
   * Save a change (the first one persists a draft). With `undo`, offer to revert it: just the
   * touched exercise's sets when `scope` is given (later edits elsewhere survive), else the
   * whole session. Undoing the only change to a draft drops it back to the live plan.
   */
  const commit = (next: Session, undo?: { message: string; scope?: ExRef; duration?: number }) => {
    const before = session;
    const wasDraft = !saved;
    saveSession(next);
    if (!undo) return;
    offerUndo(
      undo.message,
      () => {
        const cur = cachedSession(date) ?? next;
        let restored = before;
        const scope = undo.scope;
        if (scope) {
          const prevEx = before.blocks.find((b) => b.id === scope.blockId)?.exercises[scope.exIdx];
          const curEx = cur.blocks.find((b) => b.id === scope.blockId)?.exercises[scope.exIdx];
          if (prevEx && curEx && curEx.exerciseId === prevEx.exerciseId) restored = mapExercise(cur, scope, () => prevEx);
        }
        if (wasDraft && JSON.stringify(restored) === JSON.stringify(before)) deleteSession(date);
        else saveSession(restored);
      },
      undo.duration,
    );
  };

  const setLabel = (ref: SetRef) => {
    const f = findSet(session, ref);
    return f ? `${exName(f.ex.exerciseId)} · set ${f.index + 1}` : "Set";
  };

  const toggleDone = (ref: SetRef) => {
    const found = findSet(session, ref);
    if (!found) return;
    if (found.set.amrap && !found.set.done) return setAmrap(ref);
    const logging = !found.set.done;
    const next = mapSet(session, ref, (x) =>
      x.done ? { ...x, done: false } : { ...x, done: true, reps: x.reps ?? x.targetReps, weight: x.weight ?? x.targetWeight },
    );
    tick();
    commit(next, { message: `${setLabel(ref)} ${logging ? "logged" : "unlogged"}`, scope: ref, duration: 4000 });
    if (logging) rest.start();
  };

  const deleteSet = (ref: SetRef) => {
    const label = setLabel(ref);
    commit(
      mapSet(session, ref, () => null),
      { message: `${label} deleted`, scope: ref },
    );
  };

  // --- Main lift ----------------------------------------------------------------------------
  const primaryBlock = session.blocks.find((b) => b.kind === "primary");
  const primaryEx = primaryBlock?.exercises[0];
  const primaryExId = primaryEx?.exerciseId;
  const primaryName = primaryExId != null ? exName(primaryExId) : "";
  const primaryMax = primaryExId != null ? currentMax(data.maxEntries, primaryExId) : null;
  const primaryStarted = primaryEx?.sets.some((s) => s.done) ?? false;
  /** Sets the program prescribed for this session's week; any beyond are added back-off sets. */
  const plannedCount =
    session.week !== null ? (program.weeks[session.week - 1]?.reps.length ?? primaryEx?.sets.length ?? 0) : (primaryEx?.sets.length ?? 0);
  const freshPrimary = fresh.blocks.find((b) => b.kind === "primary");
  const freshCount = freshPrimary?.exercises[0]?.sets.length;

  const maxChanged = !!saved && !!primaryBlock && !!primaryMax && session.primaryMaxLb !== primaryMax.valueLb && !primaryStarted;
  // A saved session nothing has been logged in yet, whose main lift no longer matches the program.
  const shapeDiffers = primaryShape(session, freshCount) !== primaryShape(fresh);
  const planChanged = !!saved && !session.completedAt && !isSessionStarted(session) && shapeDiffers;
  const missingPrimary = !!saved && !primaryBlock && !!freshPrimary && !session.completedAt;

  const recalcPrimary = () => {
    commit(
      {
        ...session,
        label: fresh.label,
        cycle: fresh.cycle,
        week: fresh.week,
        deload: fresh.deload,
        primaryMaxLb: fresh.primaryMaxLb ?? session.primaryMaxLb,
        blocks: [...(freshPrimary ? [freshPrimary] : []), ...session.blocks.filter((b) => b.kind !== "primary")],
      },
      { message: "Main lift recalculated" },
    );
  };

  const addMainSet = () => {
    if (!primaryBlock || !primaryEx || primaryEx.sets.length >= MAX_SETS) return;
    const last = primaryEx.sets[primaryEx.sets.length - 1];
    commit(
      mapExercise(session, { blockId: primaryBlock.id, exIdx: 0 }, (e) => ({
        ...e,
        sets: [...e.sets, blankSet({ targetReps: last?.targetReps ?? null, targetWeight: last?.weight ?? last?.targetWeight ?? null })],
      })),
    );
    tick();
  };

  // --- Accessories --------------------------------------------------------------------------
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
    if (adding?.mode === "pair") commit(mapBlock(session, adding.blockId, (b) => ({ ...b, exercises: [...b.exercises, item] })));
    else commit({ ...session, blocks: [...session.blocks, { id: newId(), kind: "accessory", exercises: [item] }] });
    tick();
    setAdding(null);
  };

  const addAccessorySet = (ref: ExRef) =>
    commit(
      mapExercise(session, ref, (x) => {
        if (x.sets.length >= MAX_SETS) return x;
        const last = x.sets[x.sets.length - 1];
        return {
          ...x,
          sets: [
            ...x.sets,
            blankSet({ targetReps: last?.reps ?? last?.targetReps ?? null, targetWeight: last?.weight ?? last?.targetWeight ?? null }),
          ],
        };
      }),
    );

  const editingFound = findSet(session, editing);
  const amrapFound = findSet(session, amrap);
  const actionsBlock = actions ? session.blocks.find((b) => b.id === actions.blockId) : undefined;
  const actionsEx = actions ? actionsBlock?.exercises[actions.exIdx] : undefined;
  const volume = sessionVolume(session);
  const totalSets = session.blocks.reduce((n, b) => n + b.exercises.reduce((m, e) => m + e.sets.length, 0), 0);
  const doneSets = session.blocks.reduce((n, b) => n + b.exercises.reduce((m, e) => m + e.sets.filter((s) => s.done).length, 0), 0);

  /** Edited set can be deleted: any accessory set, or a main-lift set added beyond the plan. */
  const canDelete = (f: NonNullable<ReturnType<typeof findSet>>) =>
    f.block.kind === "accessory" || (!f.set.amrap && f.index >= plannedCount);

  const go = (d: string) => navigate(d === today ? "/train" : `/train/${d}`);
  const weekday = weekdayName(date);

  let supersetCount = 0;

  return (
    <div>
      <header className="flex items-center justify-between gap-2 pt-2">
        <div className="flex min-w-0 items-center gap-1">
          <button type="button" aria-label="Previous day" onClick={() => go(addDays(date, -1))} className="tap -ml-2 p-2 text-mute">
            <ChevronLeft size={18} />
          </button>
          <div className="label whitespace-nowrap text-fg-2">
            {weekdayName(date, true)} · {formatShortDate(date)}
          </div>
          <button
            type="button"
            aria-label="Next day"
            disabled={date >= today}
            onClick={() => go(addDays(date, 1))}
            className="tap p-2 text-mute disabled:opacity-20"
          >
            <ChevronRight size={18} />
          </button>
        </div>
        {pos && (
          <div className="label whitespace-nowrap">
            <span aria-hidden>
              C{pos.cycle} · {pos.week.deload ? <span className="text-glow">Deload</span> : `W${pos.weekIndex + 1}/${program.weeks.length}`}
            </span>
            <span className="sr-only">
              Cycle {pos.cycle}, {pos.week.deload ? "deload week" : `week ${pos.weekIndex + 1} of ${program.weeks.length}`}
            </span>
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
            isToday ? (
              "Build today's work below."
            ) : (
              `Build ${weekday}'s work below.`
            )
          ) : (
            "Rest day."
          )}
        </p>
        {(!isToday || planChanged || maxChanged || missingPrimary) && (
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
            {!isToday && (
              <Link to="/train" className="label inline-flex min-h-11 items-center text-accent">
                ← Today
              </Link>
            )}
            {(planChanged || maxChanged || missingPrimary) && (
              <button type="button" onClick={recalcPrimary} className="chip min-h-9 bg-accent/10 text-accent">
                <RefreshCw size={12} className="mr-1.5" />
                {planChanged || missingPrimary || shapeDiffers
                  ? "Plan changed — recalculate"
                  : `Recalculate from new max (${fmt(primaryMax!.valueLb)})`}
              </button>
            )}
          </div>
        )}
      </div>

      {!isPlannedDay && !saved ? (
        <div className="mt-10">
          <Empty>
            {isToday
              ? "Rest from the barbell today. Metcon, zone 2 and steps still count toward closing the day."
              : `No lifting was scheduled for ${weekday}.`}
          </Empty>
          <div className="flex flex-wrap gap-3">
            <button type="button" className="btn-ghost whitespace-nowrap" onClick={() => commit({ ...session, label: "Extra session" })}>
              <Plus size={16} /> {isToday ? "Start a session anyway" : "Log a session anyway"}
            </button>
            {isToday && (
              <Link to="/" className="btn-ghost whitespace-nowrap">
                Back to today
              </Link>
            )}
          </div>
        </div>
      ) : (
        <>
          {/* Main lift */}
          {primaryBlock && primaryEx && primaryExId != null && (
            <Section
              label="Main lift"
              right={
                <button
                  type="button"
                  aria-haspopup="dialog"
                  className="label -mx-2 -my-3.5 px-2 py-3.5 text-mute"
                  onClick={() => setMaxFor(exById(primaryExId) ?? null)}
                >
                  max <span className="num text-fg-2">{fmt(primaryMax?.valueLb ?? session.primaryMaxLb, 0)}</span>
                </button>
              }
            >
              <div className="mb-4 flex flex-wrap items-baseline justify-between gap-x-3">
                <div className="text-2xl font-light">{primaryName}</div>
                {session.deload && (
                  <span className="label whitespace-nowrap text-glow">
                    deload · {repScheme(primaryEx.sets.slice(0, plannedCount).map((s) => s.targetReps))}
                  </span>
                )}
              </div>
              <div>
                {primaryEx.sets.map((s, i) => {
                  const ref = { blockId: primaryBlock.id, exIdx: 0, setId: s.id };
                  const over = s.amrap && s.done && s.reps !== null && s.targetReps !== null ? s.reps - s.targetReps : 0;
                  const beat = over > 0;
                  const extra = i >= plannedCount;
                  const tag = s.amrap
                    ? beat
                      ? `+${over} reps${s.appliedProgressionLb ? ` · +${s.appliedProgressionLb} lb` : ""}`
                      : "AMRAP"
                    : extra
                      ? "back-off"
                      : null;
                  return (
                    <div key={s.id} className="flex items-center gap-4 py-2">
                      <span className="label w-5" aria-hidden>
                        {i + 1}
                      </span>
                      <MainSetButton
                        label={`${primaryName} set ${i + 1}: ${describeSet(s, "reps")}${s.amrap ? `, AMRAP${beat ? `, ${over} over target` : ""}` : ""}`}
                        pressed={s.done}
                        describedBy={hintId}
                        onTap={() => toggleDone(ref)}
                        onHold={() => (s.amrap ? setAmrap(ref) : setEditing(ref))}
                      >
                        <span className={clsx("num text-3xl font-light tracking-tight", s.done ? "text-fg" : "text-fg-2")}>
                          {s.done ? s.weight : s.targetWeight}
                        </span>
                        <span className="text-sm whitespace-nowrap text-mute">
                          × {s.done ? s.reps : s.targetReps}
                          {s.amrap && !s.done && "+"}
                        </span>
                        {tag && (
                          <span className={clsx("label whitespace-nowrap", s.amrap ? (beat ? "text-gold" : "text-accent") : "text-faint")}>
                            {tag}
                          </span>
                        )}
                      </MainSetButton>
                      <CheckDot
                        done={s.done}
                        tone={beat ? "gold" : "accent"}
                        onClick={() => toggleDone(ref)}
                        label={`${primaryName} set ${i + 1} logged`}
                      />
                    </div>
                  );
                })}
              </div>
              <div className="mt-1 flex min-h-11 flex-wrap items-center justify-between gap-x-4 gap-y-1">
                <div className="min-h-6">
                  <Plates weight={primaryEx.sets.find((s) => !s.done)?.targetWeight ?? null} />
                </div>
                {primaryEx.sets.length < MAX_SETS && (
                  <button
                    type="button"
                    onClick={addMainSet}
                    aria-label={`Add a back-off set of ${primaryName}`}
                    className="tap label -mr-2 inline-flex min-h-11 items-center gap-1.5 px-2 whitespace-nowrap text-mute"
                  >
                    <Plus size={12} /> set
                  </button>
                )}
              </div>
            </Section>
          )}

          {!primaryBlock && programDay?.primaryExerciseId != null && !primaryMax && !freshPrimary && (
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
                const letter = superset ? String.fromCharCode(65 + supersetCount++) : "";
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
                        const name = exName(e.exerciseId);
                        return (
                          <div key={exIdx} className={clsx(exIdx > 0 && "mt-5")}>
                            <div className="flex items-center justify-between">
                              <div className="text-[15px]">
                                {superset && <span className="label mr-2 text-glow">{`${letter}${exIdx + 1}`}</span>}
                                {name}
                              </div>
                              <button
                                type="button"
                                aria-label={`${name} options`}
                                aria-haspopup="dialog"
                                className="tap -mr-3 grid h-11 w-11 place-items-center text-mute"
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
                                    exerciseName={name}
                                    index={si}
                                    set={s}
                                    measure={e.measure}
                                    describedBy={hintId}
                                    onTap={() => toggleDone(ref)}
                                    onHold={() => setEditing(ref)}
                                  />
                                );
                              })}
                              {e.sets.length < MAX_SETS && (
                                <button
                                  type="button"
                                  aria-label={`Add ${name} set`}
                                  className="tap grid h-[52px] w-11 place-items-center rounded-2xl text-faint ring-1 ring-white/[0.06] ring-inset"
                                  onClick={() => addAccessorySet({ blockId: b.id, exIdx })}
                                >
                                  <Plus size={14} />
                                </button>
                              )}
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
                Add the accessories and core work for {isToday ? "today" : weekday} — next {weekday} they'll be here waiting.
              </p>
            )}
            <div className="flex gap-3">
              <button type="button" className="btn-ghost" onClick={() => setAdding({ mode: "new" })}>
                <Plus size={16} /> Exercise
              </button>
            </div>
            <p id={hintId} className="mt-4 text-xs text-mute">
              Tap a set to log it · hold to edit
            </p>
          </Section>

          <Section label="Notes">
            <JournalText
              key={date}
              ariaLabel="Session notes"
              value={session.notes || null}
              onSave={(v) => commit({ ...(cachedSession(date) ?? session), notes: v ?? "" })}
              placeholder="Cues, feel, what to change next time…"
              minRows={2}
            />
          </Section>

          <div className="mt-10 flex flex-col items-center gap-4">
            <FinishPanel
              session={session}
              doneSets={doneSets}
              totalSets={totalSets}
              volume={volume}
              exName={exName}
              onFinish={() => {
                success();
                commit({ ...session, completedAt: new Date().toISOString() });
                rest.stop();
              }}
              onReopen={() => commit({ ...session, completedAt: null })}
            />
            {saved && !isSessionStarted(session) && !session.completedAt && (
              <button
                type="button"
                className="label min-h-11 px-3 text-faint"
                onClick={() => {
                  const before = session;
                  deleteSession(date);
                  offerUndo("Reset to plan", () => saveSession(before));
                }}
              >
                Reset to plan
              </button>
            )}
          </div>
        </>
      )}

      {/* Room for the floating rest timer above the nav, so it never covers the last controls. */}
      <div className="h-14" aria-hidden />
      <RestTimer from={rest.from} onDismiss={rest.stop} raised={toastUp} />

      <SetEditSheet
        open={!!editingFound}
        onClose={() => setEditing(null)}
        title={editingFound ? `${exName(editingFound.ex.exerciseId)} · set ${editingFound.index + 1}` : ""}
        set={editingFound?.set ?? null}
        measure={editingFound?.ex.measure ?? "reps"}
        showPlates={
          !!editingFound &&
          editingFound.ex.measure === "reps" &&
          (editingFound.block.kind === "primary" || exById(editingFound.ex.exerciseId)?.category === "primary")
        }
        onSave={(s) => {
          if (!editing || !editingFound) return;
          const prev = editingFound.set;
          const logged = s.done && !prev.done;
          commit(
            mapExercise(session, editing, (e) => replaceSetAndPropagate(e, prev, s)),
            { message: `${setLabel(editing)} ${logged ? "logged" : "updated"}`, scope: editing, duration: 4000 },
          );
          if (logged) rest.start();
          setEditing(null);
        }}
        onDelete={
          editingFound && canDelete(editingFound)
            ? () => {
                if (!editing) return;
                deleteSet(editing);
                setEditing(null);
              }
            : undefined
        }
      />

      <AmrapSheet
        open={!!amrapFound}
        onClose={() => setAmrap(null)}
        set={amrapFound?.set ?? null}
        exerciseName={amrapFound ? exName(amrapFound.ex.exerciseId) : ""}
        currentMaxLb={primaryMax?.valueLb ?? null}
        lbPerExtraRep={program.progression.lbPerExtraRep}
        progressionEnabled={program.progression.enabled}
        onLog={(reps, weight) => {
          if (!amrap) return;
          // No undo toast here: it would sit over the sheet's Apply step. Tap the set to unlog.
          commit(mapSet(session, amrap, (x) => ({ ...x, done: true, reps, weight: weight ?? x.targetWeight })));
          rest.start();
        }}
        onApply={async (gain, reps) => {
          if (!amrap || !amrapFound || !primaryMax) return;
          const g = progressionGain(program, amrapFound.set.targetReps ?? 0, reps) || gain;
          const fromSession = cachedSession(date);
          const loggedWeight = findSet(fromSession ?? session, amrap)?.set.weight ?? amrapFound.set.targetWeight;
          const entry = await addMax({
            exerciseId: amrapFound.ex.exerciseId,
            valueLb: primaryMax.valueLb + g,
            date,
            source: "amrap",
            note: `${reps} reps vs ${amrapFound.set.targetReps} @ ${loggedWeight} lb`,
          });
          markSeen([`max-${entry.id}`]);
          // Read the freshest copy after the await: onLog just marked the set done.
          saveSession(mapSet(cachedSession(date) ?? session, amrap, (x) => ({ ...x, done: true, reps, appliedProgressionLb: g })));
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

      <Sheet open={!!actionsEx} onClose={() => setActions(null)} title={actionsEx ? exName(actionsEx.exerciseId) : ""}>
        {actions && actionsBlock && actionsEx && (
          <div className="pb-2">
            <h4 className="label mb-2">Edit sets</h4>
            {actionsEx.sets.length ? (
              <ul className="space-y-2">
                {actionsEx.sets.map((s, si) => {
                  const ref = { ...actions, setId: s.id };
                  const unit = measureUnit(actionsEx.measure);
                  const reps = s.done ? s.reps : s.targetReps;
                  const weight = s.done ? s.weight : s.targetWeight;
                  return (
                    <li key={s.id} className="flex items-center gap-2">
                      <button
                        type="button"
                        aria-label={`Edit set ${si + 1}: ${describeSet(s, actionsEx.measure)}${s.done ? ", logged" : ""}`}
                        className="tap flex min-h-11 flex-1 items-center justify-between rounded-2xl bg-white/[0.04] px-4 py-3 text-left"
                        onClick={() => {
                          setActions(null);
                          setEditing(ref);
                        }}
                      >
                        <span className="flex items-center gap-2 text-sm">
                          Set {si + 1}
                          {s.done && <Check size={12} strokeWidth={3} className="text-accent" />}
                        </span>
                        <span className="num text-sm text-fg-2">
                          {reps ?? "—"}
                          {unit || " reps"}
                          {weight ? ` · ${weight} lb` : ""}
                        </span>
                      </button>
                      <button
                        type="button"
                        aria-label={`Delete set ${si + 1}`}
                        className="tap grid h-11 w-11 shrink-0 place-items-center rounded-2xl text-mute hover:text-warn"
                        onClick={() => {
                          // Close so the Undo toast is reachable (the app behind a sheet is inert).
                          setActions(null);
                          deleteSet(ref);
                        }}
                      >
                        <Trash2 size={15} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="text-sm text-mute">No sets.</p>
            )}

            <div className="mt-6 space-y-2">
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
              {actionsBlock.exercises.length > 1 && (
                <button
                  type="button"
                  className="tap flex w-full items-center gap-3 rounded-2xl bg-white/[0.04] px-4 py-3.5 text-left"
                  onClick={() => {
                    const without = mapBlock(session, actionsBlock.id, (b) => ({
                      ...b,
                      exercises: b.exercises.filter((_, i) => i !== actions.exIdx),
                    }));
                    const idx = without.blocks.findIndex((b) => b.id === actionsBlock.id);
                    const blocks: Block[] = [...without.blocks];
                    blocks.splice(idx + 1, 0, { id: newId(), kind: "accessory", exercises: [actionsEx] });
                    commit({ ...without, blocks });
                    setActions(null);
                  }}
                >
                  Split out of superset
                </button>
              )}
              <button
                type="button"
                className="tap flex w-full items-center gap-3 rounded-2xl bg-warn/[0.06] px-4 py-3.5 text-left text-warn"
                onClick={() => {
                  commit(
                    mapBlock(session, actions.blockId, (b) => {
                      const exercises = b.exercises.filter((_, i) => i !== actions.exIdx);
                      return exercises.length ? { ...b, exercises } : null;
                    }),
                    { message: `${exName(actionsEx.exerciseId)} removed` },
                  );
                  setActions(null);
                }}
              >
                <Trash2 size={16} /> Remove — also from future {weekday}s
              </button>
              <p className="px-1 pt-1 text-xs leading-relaxed text-mute">
                Skipping it just today? Leave its sets unlogged — it stays in next {weekday}'s plan.
              </p>
            </div>
          </div>
        )}
      </Sheet>

      <MaxSheet exercise={maxFor} open={!!maxFor} onClose={() => setMaxFor(null)} />
    </div>
  );
}
