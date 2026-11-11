/**
 * Immutable edits on a Session document for the Train screen. These are structural
 * helpers only (no training formulas): the plan itself comes from src/shared.
 */
import type { Block, BlockExercise, Measure, Session, SetEntry } from "../../../shared/schemas";
import { logAtTargets, needsLoadBeforeLogging, shownLoad } from "../../../shared/session";

export type SetRef = { blockId: string; exIdx: number; setId: string };
export type ExRef = { blockId: string; exIdx: number };

export function mapBlock(s: Session, blockId: string, fn: (b: Block) => Block | null): Session {
  return {
    ...s,
    blocks: s.blocks.map((b) => (b.id === blockId ? fn(b) : b)).filter((b): b is Block => b !== null),
  };
}

export function mapExercise(s: Session, ref: ExRef, fn: (e: BlockExercise) => BlockExercise): Session {
  return mapBlock(s, ref.blockId, (b) => ({ ...b, exercises: b.exercises.map((e, i) => (i === ref.exIdx ? fn(e) : e)) }));
}

export function mapSet(s: Session, ref: SetRef, fn: (x: SetEntry) => SetEntry | null): Session {
  return mapExercise(s, ref, (e) => ({
    ...e,
    sets: e.sets.map((x) => (x.id === ref.setId ? fn(x) : x)).filter((x): x is SetEntry => x !== null),
  }));
}

export function findSet(session: Session, ref: SetRef | null) {
  if (!ref) return null;
  const block = session.blocks.find((x) => x.id === ref.blockId);
  const ex = block?.exercises[ref.exIdx];
  const idx = ex?.sets.findIndex((x) => x.id === ref.setId) ?? -1;
  const set = ex?.sets[idx];
  return block && ex && set ? { block, ex, set, index: idx } : null;
}

/**
 * What a set's check does when pressed:
 *   "count"  — an open AMRAP set opens its rep counter (it needs the real count);
 *   "load"   — an open set of a weighted accessory with no load yet opens the set editor, so a
 *              weighted set is never logged without a load by accident (the main lift always has one);
 *   "toggle" — anything else is logged at its targets, or unlogged.
 */
export type CheckAction = "count" | "load" | "toggle";
export function checkAction(set: SetEntry, kind: Block["kind"], weighted: boolean): CheckAction {
  if (set.amrap && !set.done) return "count";
  if (kind === "accessory" && needsLoadBeforeLogging(set, weighted)) return "load";
  return "toggle";
}

/**
 * What saving the set editor did to a set:
 *   "none"   — nothing changed;
 *   "check"  — it only logged the set as it stood, which is what the row's check does (and undoes);
 *   "values" — a value changed (reps, load or a target): the one case with no other undo.
 */
export type EditorChange = "none" | "check" | "values";
export function editorChange(prev: SetEntry, next: SetEntry, weighted: boolean): EditorChange {
  const same = (a: SetEntry, b: SetEntry) =>
    a.done === b.done && a.reps === b.reps && a.weight === b.weight && a.targetReps === b.targetReps && a.targetWeight === b.targetWeight;
  if (same(prev, next)) return "none";
  return !prev.done && same(logAtTargets(prev, weighted), next) ? "check" : "values";
}

/** The value a set currently shows: what was done once logged, else the target. */
const shownWeight = (s: SetEntry) => (s.done ? (s.weight ?? s.targetWeight) : s.targetWeight);
const shownReps = (s: SetEntry) => (s.done ? (s.reps ?? s.targetReps) : s.targetReps);

/**
 * Replace one set and carry a changed load / target forward: later, still-unlogged sets of the
 * same exercise whose target is empty or still equals the edited set's old value take the new
 * value. Sets that were deliberately different (a pyramid, an AMRAP) are left alone.
 *
 * Loads carry on any edit (logging a set heavier means the next ones go up too). Rep counts carry
 * only when the set's *target* changed ("Save target"): logging 10 where 12 were planned is a
 * result, not a new plan, so the later sets keep their targets (and next week's pre-fill with them).
 */
export function replaceSetAndPropagate(ex: BlockExercise, prev: SetEntry, next: SetEntry): BlockExercise {
  const idx = ex.sets.findIndex((s) => s.id === prev.id);
  if (idx === -1) return ex;
  const oldW = shownWeight(prev);
  const newW = shownWeight(next);
  const oldWs = new Set([oldW, prev.targetWeight]);
  const repsRetargeted = next.targetReps !== prev.targetReps;
  const oldRs = new Set([shownReps(prev), prev.targetReps]);
  return {
    ...ex,
    sets: ex.sets.map((s, i) => {
      if (i === idx) return next;
      if (i < idx || s.done) return s;
      let out = s;
      if (newW !== oldW && (s.targetWeight === null || oldWs.has(s.targetWeight))) out = { ...out, targetWeight: newW };
      if (repsRetargeted && !s.amrap && (s.targetReps === null || oldRs.has(s.targetReps))) out = { ...out, targetReps: next.targetReps };
      return out;
    }),
  };
}

export function unitWord(m: Measure, n: number | null): string {
  const one = n === 1;
  return m === "seconds" ? (one ? "second" : "seconds") : m === "meters" ? (one ? "meter" : "meters") : one ? "rep" : "reps";
}

/**
 * "10 reps at 50 lb", "30 seconds at 25 lb" — the spoken form of a set. A set of a weighted
 * exercise without a load yet says so ("10 reps (no load)"); otherwise a load is only mentioned
 * when there is one. When `weighted` is given, the load is the one the set shows (`shownLoad`): an
 * unweighted exercise's open set mentions no target load; without it (the main lift), any load.
 */
export function describeSet(s: SetEntry, m: Measure, weighted?: boolean): string {
  const reps = shownReps(s);
  const weight = weighted === undefined ? shownWeight(s) : shownLoad(s, weighted);
  const load = weight ? ` at ${weight} lb` : weighted ? " (no load)" : "";
  return `${reps ?? "no target"} ${reps === null ? "" : unitWord(m, reps)}${load}`.replace(/\s+/g, " ").trim();
}

/** "4×10" when every set shares a rep count, else "6/8/10/12". */
export function repScheme(reps: ReadonlyArray<number | null>): string {
  const xs = reps.filter((r): r is number => r !== null);
  if (!xs.length) return "";
  return xs.every((r) => r === xs[0]) ? `${xs.length}×${xs[0]}` : xs.join("/");
}

/** Session content without ids: two builds of the same plan compare equal. */
export function planSignature(s: Session): string {
  return JSON.stringify({
    ...s,
    blocks: s.blocks.map((b) => ({
      ...b,
      id: "",
      exercises: b.exercises.map((e) => ({ ...e, sets: e.sets.map((x) => ({ ...x, id: "" })) })),
    })),
  });
}

/** A set in page order: the main lift first, then the accessory blocks as listed. */
export interface OrderedSet {
  block: Block;
  ex: BlockExercise;
  ref: SetRef;
  set: SetEntry;
}

/** Every set the screen shows as loggable, in page order (skipped exercises and a skipped main lift left out). */
export function setsInPageOrder(session: Session): OrderedSet[] {
  const blocks = [...session.blocks.filter((b) => b.kind === "primary"), ...session.blocks.filter((b) => b.kind !== "primary")];
  const out: OrderedSet[] = [];
  for (const block of blocks) {
    if (block.skipped) continue;
    block.exercises.forEach((ex, exIdx) => {
      if (ex.skipped) return;
      for (const set of ex.sets) out.push({ block, ex, set, ref: { blockId: block.id, exIdx, setId: set.id } });
    });
  }
  return out;
}

/**
 * The set that comes next after `after` was logged: the next open set of the same exercise, else
 * the first open set after it in page order. Without `after` (e.g. a rest restored after a
 * reload), the first open set of the session.
 */
export function nextOpenSet(session: Session, after: SetRef | null): OrderedSet | null {
  const all = setsInPageOrder(session);
  const at = after ? all.findIndex((x) => x.ref.setId === after.setId) : -1;
  if (at === -1) return all.find((x) => !x.set.done) ?? null;
  const rest = all.slice(at + 1).filter((x) => !x.set.done);
  return rest.find((x) => x.ref.blockId === after!.blockId && x.ref.exIdx === after!.exIdx) ?? rest[0] ?? null;
}

/**
 * Re-locate a set held by an open sheet in the latest session (it may have moved: a merge with
 * another device's edit can insert or remove an exercise before it). The same ref when nothing
 * moved; null when the set is gone.
 */
export function resolveSetRef(session: Session, ref: SetRef | null): SetRef | null {
  if (!ref) return null;
  const block = session.blocks.find((b) => b.id === ref.blockId);
  if (!block) return null;
  if (block.exercises[ref.exIdx]?.sets.some((s) => s.id === ref.setId)) return ref;
  const exIdx = block.exercises.findIndex((e) => e.sets.some((s) => s.id === ref.setId));
  return exIdx === -1 ? null : { ...ref, exIdx };
}

/** An exercise held by an open sheet, by block and exercise id (see `resolveSetRef`). */
export type HeldEx = ExRef & { exerciseId: number };

export function resolveExRef(session: Session, ref: HeldEx | null): HeldEx | null {
  if (!ref) return null;
  const block = session.blocks.find((b) => b.id === ref.blockId);
  if (!block) return null;
  if (block.exercises[ref.exIdx]?.exerciseId === ref.exerciseId) return ref;
  const exIdx = block.exercises.findIndex((e) => e.exerciseId === ref.exerciseId);
  return exIdx === -1 ? null : { ...ref, exIdx };
}
