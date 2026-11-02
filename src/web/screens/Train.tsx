import clsx from "clsx";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Link2,
  CalendarCheck,
  ListChecks,
  MoreHorizontal,
  Plus,
  RefreshCw,
  SkipForward,
  Trash2,
  Unlink2,
  X,
} from "lucide-react";
import { addDays, isISODate, weekdayName } from "../../shared/dates";
import { trainingPrefs } from "../../shared/defaults";
import { amrapPrs } from "../../shared/gamify";
import { currentMax, cyclePosition, programDayFor, progressionGain } from "../../shared/program";
import type { Block, BlockExercise, Exercise, Session, SetEntry } from "../../shared/schemas";
import {
  accessoryHint,
  blankSet,
  buildSession,
  buildSessionFrom,
  isSessionStarted,
  newId,
  planChanged,
  sessionCounts,
  sessionDoneEarly,
  sessionVolume,
} from "../../shared/session";
import { useDockHeight, useDockTop } from "../components/Dock";
import { CheckDot, Empty, Section, Sheet } from "../components/ui";
import { useToast } from "../components/Toast";
import { DateJump } from "../components/today/DateJump";
import { AddExerciseSheet } from "../components/train/AddExerciseSheet";
import { FinishPanel } from "../components/train/FinishPanel";
import { RestTimer, useRestTimer } from "../components/train/RestTimer";
import { useDismissedHints } from "../components/train/hintDismiss";
import { afterLayout, useRevealAboveDock, whenReady } from "../components/train/reveal";
import { MainSetButton, PlannedChip, SetChip } from "../components/train/SetControls";
import { AmrapSheet, measureUnit, Plates, SetEditSheet, type AmrapRepPr } from "../components/train/SetSheets";
import {
  describeSet,
  findSet,
  mapBlock,
  mapExercise,
  mapSet,
  nextOpenSet,
  planSignature,
  replaceSetAndPropagate,
  repScheme,
  resolveExRef,
  resolveSetRef,
  type ExRef,
  type HeldEx,
  type SetRef,
} from "../components/train/sessionEdit";
import { MaxSheet } from "../components/MaxSheet";
import { JournalText } from "../components/TextArea";
import { fmt } from "../lib/format";
import { success, tick } from "../lib/haptics";
import { currentData } from "../lib/sync";
import {
  cachedSession,
  useAddMax,
  useCreateExercise,
  useData,
  useDeleteSession,
  useMarkSeen,
  usePendingDates,
  useSaveSession,
} from "../lib/store";
import { useFocusAfter } from "../components/useFocusAfter";
import { useTitle } from "../components/useTitle";

/** Server limits (sessionSchema): sets per exercise, exercises per superset, blocks per session. */
const MAX_SETS = 30;
const MAX_SUPERSET = 6;
const MAX_BLOCKS = 30;
/** How far ahead the planned sessions can be previewed (read-only). */
const PREVIEW_DAYS = 14;

/** A set still to do that "log as planned" may fill in (an AMRAP needs its real rep count). */
const loggable = (s: SetEntry) => !s.done && !s.amrap;
/** Mark a set done at its targets. */
const logAsPlanned = (s: SetEntry): SetEntry =>
  loggable(s) ? { ...s, done: true, reps: s.reps ?? s.targetReps, weight: s.weight ?? s.targetWeight } : s;
const lb = (v: number) => fmt(v, v % 1 ? 1 : 0);
/**
 * A finished session stays consistent with its sets: once nothing is logged in it any more (an
 * Undo or unlog after Finish), it's open again — unless the main lift was skipped, which may
 * finish with nothing logged.
 */
const settled = (s: Session): Session =>
  s.completedAt && sessionCounts(s).done === 0 && !s.blocks.some((b) => b.kind === "primary" && b.skipped)
    ? { ...s, completedAt: null }
    : s;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

type Hint = NonNullable<ReturnType<typeof accessoryHint>>;
/**
 * Whether a progression hint still says something: a "hold" while there are sets to do; an
 * increase while a pending set isn't at the suggestion yet.
 */
function hintApplies(hint: Hint, sets: ReadonlyArray<SetEntry>): boolean {
  if (hint.kind === "hold") return sets.some(loggable);
  const up = hint.suggestedWeight >= hint.lastWeight;
  return sets.some(
    (s) => loggable(s) && (s.targetWeight === null || (up ? s.targetWeight < hint.suggestedWeight : s.targetWeight > hint.suggestedWeight)),
  );
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
  // Future days are a read-only preview of the plan (capped a couple of weeks out); no logging into them.
  const lastPreview = addDays(today, PREVIEW_DAYS);
  const date = requested > lastPreview ? lastPreview : requested;
  const isToday = date === today;
  const isPreview = date > today;
  const saveSession = useSaveSession();
  const deleteSession = useDeleteSession();
  const addMax = useAddMax();
  const createExercise = useCreateExercise();
  const markSeen = useMarkSeen();
  const toast = useToast();
  const rest = useRestTimer();
  const hintId = useId();
  const dockHeight = useDockHeight();
  const revealAboveDock = useRevealAboveDock();
  const focusAfter = useFocusAfter();
  /** Focus hand-offs wait for an edit that reaches the screen through the store (a frame or more). */
  const focusWhenReady = (find: () => HTMLElement | null) => focusAfter(find, 20);
  const pending = usePendingDates().has(date);

  const saved = data.sessions.find((s) => s.date === date) ?? null;
  const program = data.settings.program;
  const prefs = trainingPrefs(data.settings);
  /** Default rest after a set: longer after the main lift than after accessories (Settings). */
  const restFor = (kind: Block["kind"]) => (kind === "primary" ? prefs.restSecondsMain : prefs.restSecondsAccessory);
  const programDay = programDayFor(program, date);
  const weekday = weekdayName(date);

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
  /** The cycle week the header shows: a moved session's own program day's (it may be another week). */
  const pos = cyclePosition(program, session.plannedFor ?? date);
  /**
   * This day's plan was already done on another day ("Do this session today"): the day shows that
   * instead of the same plan again (and can still hold a session of its own).
   */
  const earlyDone = sessionDoneEarly(date, data.sessions);
  const shownEarly = saved ? null : earlyDone;
  const trainPath = (d: string) => (d === today ? "/train" : `/train/${d}`);

  // What the open sheets hold, re-located in the latest session on every render: a merge with
  // another device's edit (or a revalidation) can move or remove what a sheet points at. A ref
  // whose target is gone closes its sheet instead of pointing at a neighbour.
  const [editingHeld, setEditing] = useState<SetRef | null>(null);
  const [amrapHeld, setAmrap] = useState<SetRef | null>(null);
  const [adding, setAdding] = useState<{ mode: "new" } | { mode: "pair"; blockId: string } | null>(null);
  const [actionsHeld, setActions] = useState<HeldEx | null>(null);
  const editing = resolveSetRef(session, editingHeld);
  const amrap = resolveSetRef(session, amrapHeld);
  const actions = resolveExRef(session, actionsHeld);
  if (editingHeld && editing !== editingHeld) setEditing(editing);
  if (amrapHeld && amrap !== amrapHeld) setAmrap(amrap);
  if (actionsHeld && actions !== actionsHeld) setActions(actions);
  if (adding?.mode === "pair" && !session.blocks.some((b) => b.id === adding.blockId)) setAdding(null);
  const [maxFor, setMaxFor] = useState<Exercise | null>(null);
  /** The set whose logging started the current rest: the rest pill shows the plates for the one after it. */
  const [lastLogged, setLastLogged] = useState<SetRef | null>(null);
  const { isDismissed: hintDismissed, dismiss: dismissHint } = useDismissedHints(date);

  const exById = (id: number) => data.exercises.find((e) => e.id === id);
  const exName = (id: number) => exById(id)?.name ?? "Exercise";

  // --- Undo toasts --------------------------------------------------------------------------
  const lastToast = useRef<number | null>(null);
  const offerUndo = (message: string, onUndo: () => void, duration = 7000) => {
    if (lastToast.current !== null) toast.dismiss(lastToast.current);
    lastToast.current = toast.show({ message, duration, action: { label: "Undo", onAction: onUndo } });
  };

  // A sheet makes the app (and its toasts) inert and the toast would sit over the sheet's
  // buttons: retire the last undo offer when one opens.
  const sheetOpen = !!(editing || amrap || adding || actions || maxFor);
  useEffect(() => {
    if (sheetOpen && lastToast.current !== null) {
      toast.dismiss(lastToast.current);
      lastToast.current = null;
    }
  }, [sheetOpen, toast]);

  /**
   * Save a change (the first one persists a draft). With `undo`, offer to revert it: just the
   * touched exercise (or block) when `scope` is given (later edits elsewhere survive), else the
   * whole session. Undoing the only change to a draft drops it back to the live plan.
   * A preview never saves.
   */
  const commit = (
    edited: Session,
    undo?: {
      message: string;
      scope?: ExRef | { blockId: string };
      /** Custom revert on top of the latest saved session (instead of `scope`). */
      revert?: (cur: Session) => Session;
      duration?: number;
      /** After the Undo is applied: where focus should go (the toast's button is gone). */
      onUndone?: () => void;
    },
  ) => {
    if (isPreview) return;
    const before = session;
    const wasDraft = !saved;
    const next = settled(edited);
    saveSession(next);
    if (!undo) return;
    offerUndo(
      undo.message,
      () => {
        const cur = cachedSession(date) ?? next;
        let restored = before;
        const scope = undo.scope;
        if (undo.revert) restored = undo.revert(cur);
        else if (scope) {
          const prevBlock = before.blocks.find((b) => b.id === scope.blockId);
          const curBlock = cur.blocks.find((b) => b.id === scope.blockId);
          const same = (i: number) => {
            const p = prevBlock?.exercises[i];
            return p && curBlock?.exercises[i]?.exerciseId === p.exerciseId ? p : null;
          };
          if ("exIdx" in scope) {
            const prevEx = same(scope.exIdx);
            if (prevEx) restored = mapExercise(cur, scope, () => prevEx);
          } else if (prevBlock && curBlock)
            restored = mapBlock(cur, scope.blockId, (b) => ({ ...b, exercises: b.exercises.map((e, i) => same(i) ?? e) }));
        }
        if (wasDraft && JSON.stringify(restored) === JSON.stringify(before)) deleteSession(date);
        else saveSession(settled(restored));
        undo.onUndone?.();
      },
      undo.duration,
    );
  };

  const setLabel = (ref: SetRef) => {
    const f = findSet(session, ref);
    return f ? `${exName(f.ex.exerciseId)} · set ${f.index + 1}` : "Set";
  };

  /**
   * After logging, bring the next open set (in page order) clear of the dock, where the rest pill
   * just appeared — only if it's covered.
   */
  const revealNextOpen = (afterSetId: string) => {
    const logged = () => document.querySelector(`[data-set="${afterSetId}"]`);
    // Wait for the logged state to reach the screen (a draft's first save goes through the store).
    whenReady(
      () => !!logged() && !logged()!.hasAttribute("data-open"),
      () =>
        afterLayout(() => {
          const el = logged();
          const next =
            el &&
            [...document.querySelectorAll("[data-set][data-open]")].find(
              (x) => el.compareDocumentPosition(x) & Node.DOCUMENT_POSITION_FOLLOWING,
            );
          revealAboveDock(next ?? null);
        }),
    );
  };

  const toggleDone = (ref: SetRef) => {
    const found = findSet(session, ref);
    if (!found || found.block.skipped) return;
    if (found.set.amrap && !found.set.done) return setAmrap(ref);
    const logging = !found.set.done;
    const next = mapSet(session, ref, (x) =>
      x.done ? { ...x, done: false } : { ...x, done: true, reps: x.reps ?? x.targetReps, weight: x.weight ?? x.targetWeight },
    );
    tick();
    // A main-lift set gets no undo toast: tapping the row again unlogs it, and the toast would sit
    // in the dock right over the next set. Accessory chips are small and dense, so they keep a
    // short one.
    if (found.block.kind === "primary") commit(next);
    else commit(next, { message: `${setLabel(ref)} ${logging ? "logged" : "unlogged"}`, scope: ref, duration: 4000 });
    if (logging) {
      rest.start(restFor(found.block.kind));
      setLastLogged(ref);
      revealNextOpen(ref.setId);
    }
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
  /** Main lift skipped today (injury, fatigue): collapsed, counts toward nothing, the day can still finish. */
  const primarySkipped = !!primaryBlock?.skipped;
  /** Sets the program prescribed for this session's week; any beyond are added back-off sets. */
  const plannedCount =
    session.week !== null ? (program.weeks[session.week - 1]?.reps.length ?? primaryEx?.sets.length ?? 0) : (primaryEx?.sets.length ?? 0);
  /**
   * The plan this session follows: today's, or — for a session moved here from another day
   * ("Do this session today") — that day's, rebuilt for this date.
   */
  const plannedFor = session.plannedFor ?? null;
  const planFresh = useMemo(
    () => (plannedFor ? buildSessionFrom(plannedFor, date, data) : fresh),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [plannedFor, fresh],
  );
  const freshPrimary = planFresh.blocks.find((b) => b.kind === "primary");

  const maxChanged = !!saved && !!primaryBlock && !!primaryMax && session.primaryMaxLb !== primaryMax.valueLb && !primaryStarted;
  // A saved session nothing has been logged in yet, whose program prescription changed since it
  // was built (the same test Today uses). Editing its own targets isn't a plan change.
  // (`planChanged` follows a moved session's own program day.)
  const programMoved = !!saved && !session.completedAt && !isSessionStarted(session) && planChanged(session, data);
  const missingPrimary = !!saved && !primaryBlock && !!freshPrimary && !session.completedAt;
  // A day whose plan was done early holds an extra session (if any), not the plan: nothing to recalculate.
  const offerRecalc = !isPreview && !earlyDone && (programMoved || maxChanged || missingPrimary);

  const recalcPrimary = () => {
    // A skipped main lift stays skipped through a recalculation.
    const nextPrimary = freshPrimary && (primarySkipped ? { ...freshPrimary, skipped: true } : freshPrimary);
    commit(
      {
        ...session,
        label: planFresh.label,
        cycle: planFresh.cycle,
        week: planFresh.week,
        deload: planFresh.deload,
        primaryMaxLb: planFresh.primaryMaxLb ?? session.primaryMaxLb,
        planSig: planFresh.planSig,
        blocks: [...(nextPrimary ? [nextPrimary] : []), ...session.blocks.filter((b) => b.kind !== "primary")],
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

  /** The main lift's Skip / Unskip / Skip rest / Restore control (whichever the row shows now). */
  const mainControl = (which: "skip" | "unskip" | "skip-rest" | "restore") => () =>
    document.querySelector<HTMLElement>(`[data-main-control="${which}"]`);

  /**
   * Skip the main lift for today (injury, fatigue): its sets leave the counts, no AMRAP or
   * progression is offered, and the session can still be finished. Undo / Unskip bring it back.
   */
  const setPrimarySkipped = (skip: boolean) => {
    if (!primaryBlock) return;
    const id = primaryBlock.id;
    const withFlag = (s: Session, on: boolean) =>
      mapBlock(s, id, (b) => {
        if (on) return { ...b, skipped: true };
        const { skipped: _unskip, ...kept } = b;
        return kept;
      });
    tick();
    commit(
      withFlag(session, skip),
      skip
        ? {
            message: "Main lift skipped today",
            revert: (cur) => withFlag(cur, false),
            onUndone: () => focusWhenReady(mainControl("skip")),
          }
        : undefined,
    );
    if (primaryBlock.id === amrap?.blockId) setAmrap(null);
    focusWhenReady(mainControl(skip ? "unskip" : "skip"));
  };

  /**
   * Stop the main lift part-way (a tweak mid-session): its unlogged sets leave the session, the
   * logged ones still count, and the session can finish without asking about them. Undo puts the
   * same sets back; later, "Restore" rebuilds the prescribed ones from the plan.
   */
  const openMain = primaryEx?.sets.filter((s) => !s.done).length ?? 0;
  const skipRestOfMain = () => {
    if (!primaryBlock || !primaryEx || !openMain) return;
    const ref = { blockId: primaryBlock.id, exIdx: 0 };
    const removed = primaryEx.sets.map((s, i) => [i, s] as const).filter(([, s]) => !s.done);
    tick();
    commit(
      mapExercise(session, ref, (e) => ({ ...e, sets: e.sets.filter((s) => s.done) })),
      {
        message: `Rest of ${primaryName} skipped`,
        // Put the removed sets back where they were, around whatever was logged since.
        revert: (cur) =>
          mapExercise(cur, ref, (e) => {
            const sets = e.sets.filter((s) => !removed.some(([, r]) => r.id === s.id));
            for (const [i, r] of removed) sets.splice(Math.min(i, sets.length), 0, r);
            return { ...e, sets: sets.slice(0, MAX_SETS) };
          }),
        onUndone: () => focusWhenReady(mainControl("skip-rest")),
      },
    );
    if (primaryBlock.id === amrap?.blockId) setAmrap(null);
    focusWhenReady(mainControl("restore"));
  };
  /** Prescribed sets the session no longer holds (the rest of the main lift was skipped). */
  const missingMain =
    primaryEx && freshPrimary && !session.completedAt && primaryEx.sets.length < plannedCount
      ? (freshPrimary.exercises[0]?.sets.slice(primaryEx.sets.length, plannedCount) ?? [])
      : [];
  const restoreMain = () => {
    if (!primaryBlock || !missingMain.length) return;
    tick();
    commit(
      mapExercise(session, { blockId: primaryBlock.id, exIdx: 0 }, (e) => ({
        ...e,
        sets: [...e.sets, ...missingMain.map((s) => ({ ...s, id: newId() }))],
      })),
    );
    focusWhenReady(mainControl("skip-rest"));
  };

  // --- Do this session today ----------------------------------------------------------------
  const todaySaved = data.sessions.find((s) => s.date === today) ?? null;
  /** Today already holds logged work (or is finished): a previewed day can't replace it. */
  const todayBusy = !!todaySaved && (isSessionStarted(todaySaved) || !!todaySaved.completedAt);
  const [confirmMove, setConfirmMove] = useState(false);
  const [confirmFor, setConfirmFor] = useState(date);
  if (confirmFor !== date) {
    setConfirmFor(date);
    setConfirmMove(false);
  }

  /**
   * Save the previewed day's plan under today (travel, a moved rest day) and go there. Notes
   * already written on today's session come along (nothing is logged in it: it isn't busy).
   */
  const doThisToday = () => {
    if (!isPreview || todayBusy) return;
    const before = todaySaved;
    const moved = buildSessionFrom(date, today, data);
    saveSession(before?.notes ? { ...moved, notes: before.notes } : moved);
    setConfirmMove(false);
    tick();
    navigate("/train");
    offerUndo(`${weekdayName(date, true)}'s ${session.label} moved to today`, () => {
      if (before) saveSession(before);
      else deleteSession(today);
    });
    // The button that was pressed is gone with the preview: land on the moved session's header.
    focusWhenReady(() => document.querySelector<HTMLElement>("[data-train-title]"));
  };

  /** A moved session nothing has been logged in yet can go back to this date's own plan. */
  const canRevert = !!saved && !!plannedFor && !isPreview && !isSessionStarted(session) && !session.completedAt;
  /** Drop a moved session: today shows its own plan again (Undo restores the moved one). */
  const revertToTodaysPlan = () => {
    const before = session;
    // Notes written on the moved session (or carried into it by "Replace") stay with the day.
    if (session.notes) saveSession({ ...fresh, label: programDay ? fresh.label : "Extra session", notes: session.notes });
    else deleteSession(date);
    offerUndo("Back to today's plan", () => saveSession(before));
    focusWhenReady(() => document.querySelector<HTMLElement>("[data-train-title]"));
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

  /** Log every still-open set of one exercise, or of a whole superset block, at its targets. */
  const logRemaining = (scope: ExRef | { blockId: string }, what: string) => {
    let n = 0;
    const logEx = (e: BlockExercise): BlockExercise => {
      if (e.skipped) return e;
      n += e.sets.filter(loggable).length;
      return { ...e, sets: e.sets.map(logAsPlanned) };
    };
    const next =
      "exIdx" in scope
        ? mapExercise(session, scope, logEx)
        : mapBlock(session, scope.blockId, (b) => ({ ...b, exercises: b.exercises.map(logEx) }));
    if (!n) return;
    tick();
    commit(next, { message: `${what} · ${plural(n, "set")} logged`, scope });
    rest.start(restFor("accessory"));
    setLastLogged(null);
  };

  /** After a sheet action logged sets: show the next open set below the block, if covered. */
  const revealNextAfterBlock = (blockId: string) =>
    afterLayout(() => {
      const block = document.querySelector(`[data-block="${blockId}"]`);
      const inBlock = block?.querySelector("[data-set][data-open]");
      const after = block
        ? [...document.querySelectorAll("[data-set][data-open]")].find(
            (el) => block.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING,
          )
        : null;
      revealAboveDock(inBlock ?? after ?? null);
    });

  /** Log the next open set of each exercise in a superset: one round (A1, A2, …). */
  const logRound = (blockId: string, what: string) => {
    let n = 0;
    const next = mapBlock(session, blockId, (b) => ({
      ...b,
      exercises: b.exercises.map((e) => {
        const i = e.skipped ? -1 : e.sets.findIndex(loggable);
        if (i === -1) return e;
        n++;
        return { ...e, sets: e.sets.map((x, j) => (j === i ? logAsPlanned(x) : x)) };
      }),
    }));
    if (!n) return;
    tick();
    commit(next, { message: `${what} · round logged`, scope: { blockId } });
    rest.start(restFor("accessory"));
    setLastLogged(null);
  };

  /**
   * Skip an accessory for today only: the next session of this day type still carries it.
   * Skipping offers an Undo; the skipped row's own "Unskip" reverses it any time later.
   */
  const setSkipped = (ref: ExRef, skipped: boolean) =>
    commit(
      mapExercise(session, ref, (e) => {
        if (skipped) return { ...e, skipped: true };
        const { skipped: _unskip, ...kept } = e;
        return kept;
      }),
      // The exercise is named by the row that just changed; keep the toast short.
      skipped
        ? {
            message: `Skipped today · stays in next ${weekday}'s plan`,
            scope: ref,
            onUndone: () => focusWhenReady(exControl(ref, "options")),
          }
        : undefined,
    );
  /** The skipped row's Unskip button, or (once unskipped) that exercise's options button. */
  const exControl = (ref: ExRef, which: "unskip" | "options") => () =>
    document.querySelector<HTMLElement>(`[data-ex="${ref.blockId}:${ref.exIdx}"][data-control="${which}"]`);

  /** Move the open sets of an accessory to the suggested load (never automatic). */
  const applyHint = (ref: ExRef, weight: number, name: string) => {
    tick();
    commit(
      mapExercise(session, ref, (e) => ({ ...e, sets: e.sets.map((x) => (loggable(x) ? { ...x, targetWeight: weight } : x)) })),
      { message: `${name} → ${lb(weight)} lb`, scope: ref },
    );
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
  // Exercises skipped today count toward nothing (the same counts Today shows).
  const { done: doneSets, total: totalSets } = sessionCounts(session);
  const blocksFull = session.blocks.length >= MAX_BLOCKS;
  /** A previewed day with planned work can be done today instead (not once today holds logged work). */
  const canMove = isPreview && !earlyDone && !todayBusy && totalSets > 0 && todaySaved?.plannedFor !== date;

  // The rest pill's "next 225 · 45 45": the set after the one that started the rest (without one —
  // a rest restored after a reload — the first open set of a session in progress). Barbell lifts
  // show their plates; anything else with a load just the load ("next 50 lb").
  const [restDate, setRestDate] = useState(date);
  if (restDate !== date) {
    setRestDate(date);
    setLastLogged(null);
  }
  const nextUp = isPreview || session.completedAt || (!lastLogged && !isSessionStarted(session)) ? null : nextOpenSet(session, lastLogged);
  const nextIsBarbell =
    !!nextUp && nextUp.ex.measure === "reps" && (nextUp.block.kind === "primary" || exById(nextUp.ex.exerciseId)?.category === "primary");
  const nextWeightLb = nextUp?.set.targetWeight ?? null;

  /**
   * While resting, the next set stays clear of the dock: when the dock grows over it after the
   * first reveal (a toast arrives — merged changes, sync — or the pill grows), bring it back up.
   * Only a set the growth covered (it was on screen above the old dock edge); one the athlete
   * scrolled away from is left alone.
   */
  const dockTop = useDockTop();
  const lastDockTop = useRef(dockTop);
  const resting = rest.from !== null;
  const nextUpId = nextUp?.set.id ?? null;
  useEffect(() => {
    const was = lastDockTop.current;
    lastDockTop.current = dockTop;
    if (!resting || !nextUpId || dockTop >= was) return;
    afterLayout(() => {
      const el = document.querySelector(`[data-set="${nextUpId}"][data-open]`);
      const r = el?.getBoundingClientRect();
      if (el && r && r.top >= 0 && r.top < was && r.bottom > dockTop - 16) revealAboveDock(el);
    });
  }, [dockTop, resting, nextUpId, revealAboveDock]);

  /** Edited set can be deleted: any accessory set, or a main-lift set added beyond the plan. */
  const canDelete = (f: NonNullable<ReturnType<typeof findSet>>) =>
    f.block.kind === "accessory" || (!f.set.amrap && f.index >= plannedCount);

  const go = (d: string) => navigate(d === today ? "/train" : `/train/${d}`);

  let supersetCount = 0;

  return (
    <div>
      <header className="flex items-center justify-between gap-2 pt-2">
        <div className="flex min-w-0 items-center">
          <button
            type="button"
            aria-label="Previous day"
            onClick={() => go(addDays(date, -1))}
            className="tap -ml-3 grid h-11 w-11 place-items-center text-mute"
          >
            <ChevronLeft size={18} />
          </button>
          {/* Jump to any day, up to the last previewable one. */}
          <DateJump date={date} today={today} max={lastPreview} pending={pending} onPick={go} />
          <button
            type="button"
            aria-label="Next day"
            disabled={date >= lastPreview}
            onClick={() => go(addDays(date, 1))}
            className="tap grid h-11 w-11 place-items-center text-mute disabled:opacity-20"
          >
            <ChevronRight size={18} />
          </button>
        </div>
        {pos && (
          <div className="label whitespace-nowrap">
            <span aria-hidden>
              C{pos.cycle} · {pos.week.deload ? <span className="text-fg-2">Deload</span> : `W${pos.weekIndex + 1}/${program.weeks.length}`}
            </span>
            <span className="sr-only">
              Cycle {pos.cycle}, {pos.week.deload ? "deload week" : `week ${pos.weekIndex + 1} of ${program.weeks.length}`}
            </span>
          </div>
        )}
      </header>

      <div className="mt-6">
        <h1 data-train-title tabIndex={-1} className="text-[clamp(2.125rem,11vw,2.75rem)] leading-none font-light tracking-tight">
          {session.label}
        </h1>
        <p className="mt-3 text-sm text-mute">
          {shownEarly ? (
            <>
              Done {weekdayName(shownEarly.date, true)} · <span className="text-fg-2">{shownEarly.label}</span> —{" "}
              <Link
                to={trainPath(shownEarly.date)}
                aria-label={`View ${weekdayName(shownEarly.date)}'s ${shownEarly.label} session`}
                className="-mx-1 -my-3 inline-block px-1 py-3 text-accent"
              >
                view
              </Link>
            </>
          ) : isPreview ? (
            <>
              <span className="label mr-2 rounded-full bg-white/[0.05] px-2 py-1 text-fg-2">Preview</span>
              {totalSets ? (
                <>
                  <span className="num text-fg-2">{totalSets}</span> sets planned
                </>
              ) : isPlannedDay ? (
                "Nothing planned yet"
              ) : (
                "Rest day"
              )}
            </>
          ) : totalSets ? (
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
        {plannedFor && (
          <div className="mt-1 flex flex-wrap items-center gap-x-3">
            <span className="text-sm text-mute">
              Planned for <span className="text-fg-2">{weekdayName(plannedFor, true)}</span>
            </span>
            {canRevert && (
              <button type="button" className="tap label -mx-2 min-h-11 px-2 text-left text-accent" onClick={revertToTodaysPlan}>
                {isToday ? "Revert to today's plan" : `Revert to ${weekday}'s plan`}
              </button>
            )}
          </div>
        )}
        {earlyDone && saved && (
          <p className="mt-1 text-sm text-mute">
            Plan done {weekdayName(earlyDone.date, true)} ·{" "}
            <Link
              to={trainPath(earlyDone.date)}
              aria-label={`View ${weekdayName(earlyDone.date)}'s ${earlyDone.label} session`}
              className="-mx-1 -my-3 inline-block px-1 py-3 text-accent"
            >
              view
            </Link>
          </p>
        )}
        {(!isToday || offerRecalc) && (
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
            {!isToday && (
              <Link to="/train" className="label inline-flex min-h-11 items-center text-accent">
                ← Today
              </Link>
            )}
            {canMove &&
              (confirmMove ? (
                <div role="group" aria-labelledby={`${hintId}-move`} className="flex w-full flex-wrap items-center gap-x-3 gap-y-1">
                  <span id={`${hintId}-move`} className="text-sm text-fg-2">
                    {todaySaved?.notes ? "Replace today's saved session? Its notes come along." : "Replace today's saved session?"}
                  </span>
                  <span className="inline-flex items-center gap-2">
                    <button
                      type="button"
                      data-move-cancel
                      className="chip min-h-9 bg-white/[0.05] text-fg-2"
                      onClick={() => {
                        setConfirmMove(false);
                        focusAfter(() => document.querySelector<HTMLElement>("[data-move-start]"));
                      }}
                    >
                      Cancel
                    </button>
                    <button type="button" data-move-confirm className="chip min-h-9 bg-accent/10 text-accent" onClick={doThisToday}>
                      Replace
                    </button>
                  </span>
                </div>
              ) : (
                <button
                  type="button"
                  data-move-start
                  className="chip min-h-9 bg-accent/10 text-accent"
                  onClick={() => {
                    if (todaySaved) {
                      setConfirmMove(true);
                      // The safe choice first: a stray second tap doesn't replace anything.
                      focusAfter(() => document.querySelector<HTMLElement>("[data-move-cancel]"));
                    } else doThisToday();
                  }}
                >
                  <CalendarCheck size={12} className="mr-1.5" />
                  Do this session today
                </button>
              ))}
            {offerRecalc && (
              <button type="button" onClick={recalcPrimary} className="chip min-h-9 bg-accent/10 text-accent">
                <RefreshCw size={12} className="mr-1.5" />
                {/* planMatches also compares loads, so a new max reads as its own reason. */}
                {maxChanged && !missingPrimary ? `Recalculate from new max (${fmt(primaryMax!.valueLb)})` : "Plan changed — recalculate"}
              </button>
            )}
          </div>
        )}
      </div>

      {shownEarly ? (
        <div className="mt-10">
          <Empty>
            {`${weekday}'s ${shownEarly.label} was done on ${weekdayName(shownEarly.date)}.`}
            {isPreview ? " Nothing else is planned for the day." : ""}
          </Empty>
          {!isPreview && (
            <button
              type="button"
              className="btn-ghost whitespace-nowrap"
              onClick={() => commit({ ...session, label: "Extra session", blocks: [] })}
            >
              <Plus size={16} /> Log a session anyway
            </button>
          )}
        </div>
      ) : !isPlannedDay && !saved ? (
        <div className="mt-10">
          <Empty>
            {isToday
              ? "Rest from the barbell today. Metcon, zone 2 and steps still count toward closing the day."
              : isPreview
                ? `No lifting scheduled for ${weekday}.`
                : `No lifting was scheduled for ${weekday}.`}
          </Empty>
          {!isPreview && (
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
          )}
        </div>
      ) : (
        <>
          {/* Main lift */}
          {primaryBlock && primaryEx && primaryExId != null && (
            <Section
              label="Main lift"
              right={
                isPreview ? (
                  <span className="label text-mute">
                    max <span className="num text-fg-2">{fmt(primaryMax?.valueLb ?? session.primaryMaxLb, 0)}</span>
                  </span>
                ) : (
                  <button
                    type="button"
                    aria-haspopup="dialog"
                    className="label -mx-2 -my-3.5 px-2 py-3.5 text-mute"
                    onClick={() => setMaxFor(exById(primaryExId) ?? null)}
                  >
                    max <span className="num text-fg-2">{fmt(primaryMax?.valueLb ?? session.primaryMaxLb, 0)}</span>
                  </button>
                )
              }
            >
              {primarySkipped ? (
                // Skipped today: one dimmed row; its sets count toward nothing until it's unskipped.
                <div className="flex min-h-11 items-center justify-between gap-3">
                  <div className="min-w-0 truncate text-[0.9375rem] text-mute">{primaryName}</div>
                  <div className="flex shrink-0 items-center">
                    <span className="label">Skipped today</span>
                    {!isPreview && (
                      <>
                        <span className="label px-1.5" aria-hidden>
                          ·
                        </span>
                        <button
                          type="button"
                          aria-label={`Unskip ${primaryName}`}
                          data-main-control="unskip"
                          className="tap label -mr-2 min-h-11 px-2 text-accent"
                          onClick={() => setPrimarySkipped(false)}
                        >
                          Unskip
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ) : (
                <>
                  <div className="mb-4 flex flex-wrap items-center justify-between gap-x-3">
                    <div className="flex flex-wrap items-baseline gap-x-3">
                      <div className="text-2xl font-light">{primaryName}</div>
                      {session.deload && (
                        <span className="label whitespace-nowrap text-fg-2">
                          deload · {repScheme(primaryEx.sets.slice(0, plannedCount).map((s) => s.targetReps))}
                        </span>
                      )}
                    </div>
                    {/* Injury or fatigue: skip the main lift for today (nothing logged in it yet), or
                        the rest of it once some sets are in (those still count). */}
                    {!isPreview && !session.completedAt && !primaryStarted && (
                      <button
                        type="button"
                        onClick={() => setPrimarySkipped(true)}
                        aria-label={`Skip ${primaryName} today`}
                        data-main-control="skip"
                        className="tap label -my-2 -mr-2 inline-flex min-h-11 items-center gap-1.5 px-2 whitespace-nowrap text-mute"
                      >
                        <SkipForward size={12} /> skip
                      </button>
                    )}
                    {!isPreview && !session.completedAt && primaryStarted && openMain > 0 && (
                      <button
                        type="button"
                        onClick={skipRestOfMain}
                        aria-label={`Skip rest of ${primaryName} today`}
                        data-main-control="skip-rest"
                        className="tap label -my-2 -mr-2 inline-flex min-h-11 items-center gap-1.5 px-2 whitespace-nowrap text-mute"
                      >
                        <SkipForward size={12} /> skip rest
                      </button>
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
                      if (isPreview)
                        return (
                          <div key={s.id} className="flex min-h-11 items-center gap-4 py-2">
                            <span className="label w-5" aria-hidden>
                              {i + 1}
                            </span>
                            <span className="sr-only">{`Set ${i + 1}: ${describeSet(s, "reps")}${s.amrap ? ", AMRAP" : ""}`}</span>
                            <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-1" aria-hidden>
                              <span className="num text-3xl font-light tracking-tight text-fg-2">{s.targetWeight}</span>
                              <span className="text-sm whitespace-nowrap text-mute">
                                × {s.targetReps}
                                {s.amrap && "+"}
                              </span>
                              {tag && <span className={clsx("label whitespace-nowrap", s.amrap ? "text-accent" : "text-mute")}>{tag}</span>}
                            </span>
                          </div>
                        );
                      return (
                        <div key={s.id} data-set={s.id} data-open={s.done ? undefined : ""} className="flex items-center gap-4 py-2">
                          <span className="label w-5" aria-hidden>
                            {i + 1}
                          </span>
                          <MainSetButton
                            srPrefix={`${primaryName} set ${i + 1}:`}
                            pressed={s.done}
                            describedBy={hintId}
                            onTap={() => toggleDone(ref)}
                            onHold={() => (s.amrap ? setAmrap(ref) : setEditing(ref))}
                          >
                            <span className={clsx("num text-3xl font-light tracking-tight", s.done ? "text-fg" : "text-fg-2")}>
                              {s.done ? s.weight : s.targetWeight}
                            </span>
                            {/* Flex items drop the spaces between them; keep them in the accessible name. */}
                            <span className="sr-only">{"\u00a0"}</span>
                            <span className="text-sm whitespace-nowrap text-mute">
                              × {s.done ? s.reps : s.targetReps}
                              {s.amrap && !s.done && "+"}
                            </span>
                            {tag && (
                              <>
                                <span className="sr-only">{"\u00a0"}</span>
                                <span
                                  className={clsx("label whitespace-nowrap", s.amrap ? (beat ? "text-gold" : "text-accent") : "text-mute")}
                                >
                                  {tag}
                                </span>
                              </>
                            )}
                          </MainSetButton>
                          {/* CheckDot carries its own hc-edge (high contrast). */}
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
                    {!isPreview && (
                      <div className="-mr-2 ml-auto flex items-center">
                        {missingMain.length > 0 && (
                          <span className="flex items-center">
                            <span className="label">{plural(missingMain.length, "set")} skipped</span>
                            <span className="label px-1.5" aria-hidden>
                              ·
                            </span>
                            <button
                              type="button"
                              aria-label={`Restore ${plural(missingMain.length, "skipped set")} of ${primaryName}`}
                              data-main-control="restore"
                              className="tap label min-h-11 px-2 text-accent"
                              onClick={restoreMain}
                            >
                              Restore
                            </button>
                          </span>
                        )}
                        {primaryEx.sets.length < MAX_SETS && (
                          <button
                            type="button"
                            onClick={addMainSet}
                            aria-label={`Add a back-off set of ${primaryName}`}
                            className="tap label inline-flex min-h-11 items-center gap-1.5 px-2 whitespace-nowrap text-mute"
                          >
                            <Plus size={12} /> set
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </>
              )}
            </Section>
          )}

          {!primaryBlock && programDay?.primaryExerciseId != null && !primaryMax && !freshPrimary && (
            <Section label="Main lift">
              <Empty>
                Set a max for {exById(programDay.primaryExerciseId)?.name ?? "this lift"} and the working sets calculate themselves.{" "}
                {!isPreview && (
                  <button type="button" className="text-accent" onClick={() => setMaxFor(exById(programDay.primaryExerciseId!) ?? null)}>
                    Set max →
                  </button>
                )}
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
                  <div key={b.id} data-block={b.id} className="mb-8">
                    {superset && (
                      <div className="mb-2 flex items-center gap-2 text-glow">
                        <Link2 size={12} />
                        <span className="label text-glow">Superset {letter}</span>
                      </div>
                    )}
                    <div className={clsx(superset && "border-l border-glow/25 pl-4")}>
                      {b.exercises.map((e, exIdx) => {
                        const name = exName(e.exerciseId);
                        const ref = { blockId: b.id, exIdx };
                        const tagLabel = superset && <span className="label mr-2 text-glow">{`${letter}${exIdx + 1}`}</span>;
                        if (e.skipped)
                          return (
                            <div key={exIdx} className={clsx("flex min-h-11 items-center justify-between gap-3", exIdx > 0 && "mt-3")}>
                              <div className="min-w-0 truncate text-[0.9375rem] text-mute">
                                {tagLabel}
                                {name}
                              </div>
                              <div className="flex shrink-0 items-center">
                                <span className="label">Skipped today</span>
                                {!isPreview && (
                                  <>
                                    <span className="label px-1.5" aria-hidden>
                                      ·
                                    </span>
                                    <button
                                      type="button"
                                      aria-label={`Unskip ${name}`}
                                      data-ex={`${b.id}:${exIdx}`}
                                      data-control="unskip"
                                      className="tap label -mr-2 min-h-11 px-2 text-accent"
                                      onClick={() => {
                                        setSkipped(ref, false);
                                        focusWhenReady(exControl(ref, "options"));
                                      }}
                                    >
                                      Unskip
                                    </button>
                                  </>
                                )}
                              </div>
                            </div>
                          );
                        const hint =
                          isPreview || session.deload || session.completedAt || e.measure !== "reps"
                            ? null
                            : accessoryHint(e.exerciseId, date, data.sessions, prefs.accessoryIncrementLb);
                        const showHint = !!hint && hintApplies(hint, e.sets) && !hintDismissed(e.exerciseId);
                        return (
                          <div key={exIdx} className={clsx(exIdx > 0 && "mt-5")}>
                            <div className={clsx("flex items-center justify-between", isPreview && "min-h-11")}>
                              <div className="text-[0.9375rem]">
                                {tagLabel}
                                {name}
                              </div>
                              {!isPreview && (
                                <button
                                  type="button"
                                  aria-label={`${name} options`}
                                  aria-haspopup="dialog"
                                  data-ex={`${b.id}:${exIdx}`}
                                  data-control="options"
                                  className="tap -mr-3 grid h-11 w-11 place-items-center text-mute"
                                  onClick={() => setActions({ ...ref, exerciseId: e.exerciseId })}
                                >
                                  <MoreHorizontal size={16} />
                                </button>
                              )}
                            </div>
                            {showHint && hint && (
                              <div className="-mt-1 mb-1 flex flex-wrap items-center gap-x-2 text-xs text-mute">
                                {hint.kind === "hold" ? (
                                  // Calmer than an increase: nothing to apply, just "stay here" — with
                                  // when it was missed ("Missed reps at 60 lb on Nov 2 · hold").
                                  <span>{hint.reason.replace(" — ", " · ")}</span>
                                ) : (
                                  <>
                                    <span title={hint.reason}>
                                      Last time <span className="num text-fg-2">{lb(hint.lastWeight)}</span> lb
                                      <span className="max-[359px]:hidden"> · all reps</span> → try{" "}
                                      <span className="num text-accent">{lb(hint.suggestedWeight)}</span>
                                    </span>
                                    <button
                                      type="button"
                                      aria-label={`Apply ${lb(hint.suggestedWeight)} lb to the open ${name} sets`}
                                      className="tap label -my-2 min-h-11 px-1.5 text-accent"
                                      onClick={() => {
                                        applyHint(ref, hint.suggestedWeight, name);
                                        // The hint row goes once the sets are at the suggestion.
                                        focusWhenReady(exControl(ref, "options"));
                                      }}
                                    >
                                      Apply
                                    </button>
                                  </>
                                )}
                                <button
                                  type="button"
                                  aria-label={`Dismiss the ${name} hint for today`}
                                  className="tap -my-2 -ml-2 grid min-h-11 w-11 place-items-center text-mute"
                                  onClick={() => {
                                    dismissHint(e.exerciseId);
                                    focusAfter(exControl(ref, "options"));
                                  }}
                                >
                                  <X size={12} />
                                </button>
                              </div>
                            )}
                            {isPreview ? (
                              <ul className="mt-1 flex flex-wrap gap-2" aria-label={`${name} sets`}>
                                {e.sets.map((s, si) => (
                                  <PlannedChip key={s.id} index={si} set={s} measure={e.measure} />
                                ))}
                              </ul>
                            ) : (
                              <div className="mt-1 flex flex-wrap gap-2">
                                {e.sets.map((s, si) => {
                                  const setRef = { ...ref, setId: s.id };
                                  return (
                                    <SetChip
                                      key={s.id}
                                      dataSet={s.id}
                                      open={!s.done}
                                      exerciseName={name}
                                      index={si}
                                      set={s}
                                      measure={e.measure}
                                      describedBy={hintId}
                                      onTap={() => toggleDone(setRef)}
                                      onHold={() => setEditing(setRef)}
                                    />
                                  );
                                })}
                                {e.sets.length < MAX_SETS && (
                                  <button
                                    type="button"
                                    aria-label={`Add ${name} set`}
                                    className="tap hc-edge grid h-[52px] w-11 place-items-center rounded-2xl text-mute ring-1 ring-white/[0.06] ring-inset"
                                    onClick={() => addAccessorySet(ref)}
                                  >
                                    <Plus size={14} />
                                  </button>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            {!session.blocks.some((b) => b.kind === "accessory") && (
              <p className="mb-6 text-sm text-mute">
                {isPreview
                  ? `Nothing to carry over yet — the accessories you log on a ${weekday} show up here.`
                  : `Add the accessories and core work for ${isToday ? "today" : weekday} — next ${weekday} they'll be here waiting.`}
              </p>
            )}
            {isPreview ? (
              <p className="text-xs leading-relaxed text-mute">
                Carried over from your last {weekday}
                {primaryBlock ? `; main-lift loads use today's max and move with any AMRAP before then` : ""}.
              </p>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  <button
                    type="button"
                    className="btn-ghost"
                    disabled={blocksFull}
                    aria-describedby={blocksFull ? `${hintId}-full` : undefined}
                    onClick={() => setAdding({ mode: "new" })}
                  >
                    <Plus size={16} /> Exercise
                  </button>
                  {blocksFull && (
                    <span id={`${hintId}-full`} className="text-xs text-mute">
                      A session holds up to {MAX_BLOCKS} blocks
                    </span>
                  )}
                </div>
                <p id={hintId} className="mt-4 text-xs text-mute">
                  Tap a set to log it · hold to edit
                  <span className="sr-only">. With a keyboard, press Shift+F10 or the context-menu key on a set to edit it.</span>
                </p>
              </>
            )}
          </Section>

          {!isPreview && (
            <>
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
                  allowEmpty={primarySkipped}
                  doneSets={doneSets}
                  totalSets={totalSets}
                  volume={volume}
                  exName={exName}
                  onFinish={() => {
                    success();
                    // A leftover Undo (a set logged a moment ago) would undo into a finished session.
                    if (lastToast.current !== null) {
                      toast.dismiss(lastToast.current);
                      lastToast.current = null;
                    }
                    commit({ ...session, completedAt: new Date().toISOString() });
                    rest.stop();
                  }}
                  onReopen={() => commit({ ...session, completedAt: null })}
                />
                {saved && !plannedFor && !isSessionStarted(session) && !session.completedAt && (
                  <button
                    type="button"
                    className="label min-h-11 px-3 text-mute"
                    onClick={() => {
                      const before = session;
                      deleteSession(date);
                      offerUndo(earlyDone ? "Session discarded" : "Reset to plan", () => saveSession(before));
                    }}
                  >
                    {earlyDone ? "Discard session" : "Reset to plan"}
                  </button>
                )}
              </div>
            </>
          )}
        </>
      )}

      {/* Room for whatever the bottom dock holds (rest pill, toasts, sync), so it never covers the last controls. */}
      <div aria-hidden style={{ height: dockHeight }} />
      <RestTimer
        from={rest.from}
        target={rest.target}
        base={rest.base}
        onTarget={rest.setTarget}
        onDismiss={rest.stop}
        nextWeightLb={nextWeightLb}
        nextPlates={nextIsBarbell}
      />

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
          if (logged) {
            rest.start(restFor(editingFound.block.kind));
            setLastLogged(editing);
          }
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
        onLog={(reps, weight): AmrapRepPr | null => {
          if (!amrap || !amrapFound) return null;
          // No undo toast here: it would sit over the sheet's Apply step. Tap the set to unlog.
          const next = mapSet(session, amrap, (x) => ({ ...x, done: true, reps, weight: weight ?? x.targetWeight }));
          // A rep PR shows on the sheet's result screen; mark it seen first (same tick as the save)
          // so the full-screen celebration doesn't follow it.
          const key = `amrap-${date}-${amrapFound.ex.exerciseId}`;
          const pr = amrapPrs([...data.sessions.filter((x) => x.date !== date), next], date).find((p) => p.key === key) ?? null;
          if (pr) markSeen([key]);
          commit(next);
          rest.start(restFor("primary"));
          setLastLogged(amrap);
          return pr && { reps: pr.reps, weightLb: pr.weightLb, previousReps: pr.previousReps };
        }}
        onApply={async (gain, reps) => {
          if (!amrap || !amrapFound || !primaryMax) return;
          const g = progressionGain(program, amrapFound.set.targetReps ?? 0, reps) || gain;
          const fromSession = cachedSession(date) ?? session;
          if (findSet(fromSession, amrap)?.set.appliedProgressionLb) return; // already applied
          const loggedWeight = findSet(fromSession, amrap)?.set.weight ?? amrapFound.set.targetWeight;
          // Queue the max and record the bump on the set in the same step (no waiting for the
          // server's row in between), so the set can never show the AMRAP as unapplied while the
          // max is already raised — which would offer the bump twice.
          const exerciseId = amrapFound.ex.exerciseId;
          const valueLb = primaryMax.valueLb + g;
          // The sheet just showed the bump (and any rep PR): no full-screen celebration may follow
          // it. The store marks the server's entry seen as it is acknowledged; the local entry's
          // temporary key is marked now, in the same step as the write, so the celebrations never
          // see it unseen (the outbox swaps the temp id in the key for the real one).
          const entry = addMax(
            { exerciseId, valueLb, date, source: "amrap", note: `${reps} reps vs ${amrapFound.set.targetReps} @ ${loggedWeight} lb` },
            { markSeenOnAck: true },
          );
          const applied = mapSet(fromSession, amrap, (x) => ({ ...x, done: true, reps, appliedProgressionLb: g }));
          const temp = currentData()?.maxEntries.find(
            (e) => e.id < 0 && e.exerciseId === exerciseId && e.source === "amrap" && e.date === date && e.valueLb === valueLb,
          );
          const repKey = `amrap-${date}-${exerciseId}`;
          const repPr = amrapPrs([...data.sessions.filter((x) => x.date !== date), applied], date).some((p) => p.key === repKey);
          markSeen([...(temp ? [`max-${temp.id}`] : []), ...(repPr ? [repKey] : [])]);
          saveSession(applied);
          markSeen([`max-${(await entry).id}`]);
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
            {(() => {
              // "Log as planned": this exercise's open sets, and for a superset the next round / the whole block.
              const exOpen = actionsEx.sets.filter(loggable).length;
              const isSuperset = actionsBlock.exercises.length > 1;
              const live = actionsBlock.exercises.filter((e) => !e.skipped);
              const blockOpen = live.reduce((n, e) => n + e.sets.filter(loggable).length, 0);
              const roundSize = live.filter((e) => e.sets.some(loggable)).length;
              const letter = isSuperset
                ? String.fromCharCode(
                    65 +
                      session.blocks
                        .filter((x) => x.kind === "accessory" && x.exercises.length > 1)
                        .findIndex((x) => x.id === actionsBlock.id),
                  )
                : "";
              const name = exName(actionsEx.exerciseId);
              const row =
                "tap flex min-h-12 w-full items-center gap-3 rounded-2xl bg-accent/[0.07] px-4 py-3 text-left text-fg disabled:opacity-40";
              if (!exOpen && !(isSuperset && blockOpen)) return null;
              return (
                <div className="mb-6">
                  <h4 className="label mb-2">Log as planned</h4>
                  <div className="space-y-2">
                    {exOpen > 0 && (
                      <button
                        type="button"
                        className={row}
                        onClick={() => {
                          setActions(null);
                          logRemaining(actions, name);
                          revealNextAfterBlock(actions.blockId);
                        }}
                      >
                        <ListChecks size={16} className="shrink-0 text-accent" />
                        <span className="flex-1">Log remaining sets</span>
                        <span className="num text-sm text-fg-2">{exOpen}</span>
                      </button>
                    )}
                    {isSuperset && roundSize > 1 && (
                      <button
                        type="button"
                        className={row}
                        onClick={() => {
                          setActions(null);
                          logRound(actionsBlock.id, `Superset ${letter}`);
                          revealNextAfterBlock(actionsBlock.id);
                        }}
                      >
                        <Link2 size={16} className="shrink-0 text-glow" />
                        <span className="flex-1">Log next round of Superset {letter}</span>
                        <span className="num text-sm text-fg-2">{roundSize}</span>
                      </button>
                    )}
                    {isSuperset && blockOpen > exOpen && (
                      <button
                        type="button"
                        className={row}
                        onClick={() => {
                          setActions(null);
                          logRemaining({ blockId: actionsBlock.id }, `Superset ${letter}`);
                          revealNextAfterBlock(actionsBlock.id);
                        }}
                      >
                        <Link2 size={16} className="shrink-0 text-glow" />
                        <span className="flex-1">Log all of Superset {letter}</span>
                        <span className="num text-sm text-fg-2">{blockOpen}</span>
                      </button>
                    )}
                  </div>
                </div>
              );
            })()}

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
              {(() => {
                const full = actionsBlock.exercises.length >= MAX_SUPERSET;
                return (
                  <button
                    type="button"
                    disabled={full}
                    className="tap flex w-full items-center gap-3 rounded-2xl bg-white/[0.04] px-4 py-3.5 text-left disabled:opacity-60"
                    onClick={() => {
                      setAdding({ mode: "pair", blockId: actions.blockId });
                      setActions(null);
                    }}
                  >
                    <Link2 size={16} className="shrink-0 text-glow" />
                    <span>
                      Superset with another exercise
                      {full && <span className="block text-xs text-fg-2">A superset holds up to {MAX_SUPERSET} exercises</span>}
                    </span>
                  </button>
                );
              })()}
              {actionsBlock.exercises.length > 1 && (
                <button
                  type="button"
                  disabled={blocksFull}
                  className="tap flex w-full items-center gap-3 rounded-2xl bg-white/[0.04] px-4 py-3.5 text-left disabled:opacity-60"
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
                  <Unlink2 size={16} className="shrink-0 text-mute" />
                  <span>
                    Split out of superset
                    {blocksFull && <span className="block text-xs text-fg-2">A session holds up to {MAX_BLOCKS} blocks</span>}
                  </span>
                </button>
              )}
              <button
                type="button"
                className="tap flex w-full items-center gap-3 rounded-2xl bg-white/[0.04] px-4 py-3.5 text-left"
                onClick={() => {
                  setSkipped(actions, true);
                  setActions(null);
                  // The options button that opened this sheet is gone with the row it was on.
                  focusWhenReady(exControl(actions, "unskip"));
                }}
              >
                <SkipForward size={16} className="shrink-0 text-mute" />
                <span>
                  Skip today
                  <span className="block text-xs text-fg-2">Stays in next {weekday}'s plan</span>
                </span>
              </button>
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
            </div>
          </div>
        )}
      </Sheet>

      <MaxSheet key={maxFor?.id ?? "none"} exercise={maxFor} open={!!maxFor} onClose={() => setMaxFor(null)} />
    </div>
  );
}
