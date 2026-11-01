/**
 * Immutable edits on a Session document for the Train screen. These are structural
 * helpers only (no training formulas): the plan itself comes from src/shared.
 */
import type { Block, BlockExercise, Measure, Session, SetEntry } from "../../../shared/schemas";

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

/** The value a set currently shows: what was done once logged, else the target. */
const shownWeight = (s: SetEntry) => (s.done ? (s.weight ?? s.targetWeight) : s.targetWeight);
const shownReps = (s: SetEntry) => (s.done ? (s.reps ?? s.targetReps) : s.targetReps);

/**
 * Replace one set and carry a changed load / rep count forward: later, still-unlogged sets of
 * the same exercise whose target is empty or still equals the edited set's old value take the
 * new value. Sets that were deliberately different (a pyramid, an AMRAP) are left alone.
 */
export function replaceSetAndPropagate(ex: BlockExercise, prev: SetEntry, next: SetEntry): BlockExercise {
  const idx = ex.sets.findIndex((s) => s.id === prev.id);
  if (idx === -1) return ex;
  const oldW = shownWeight(prev);
  const newW = shownWeight(next);
  const oldR = shownReps(prev);
  const newR = shownReps(next);
  const oldWs = new Set([oldW, prev.targetWeight]);
  const oldRs = new Set([oldR, prev.targetReps]);
  return {
    ...ex,
    sets: ex.sets.map((s, i) => {
      if (i === idx) return next;
      if (i < idx || s.done) return s;
      let out = s;
      if (newW !== oldW && (s.targetWeight === null || oldWs.has(s.targetWeight))) out = { ...out, targetWeight: newW };
      if (!s.amrap && newR !== oldR && (s.targetReps === null || oldRs.has(s.targetReps))) out = { ...out, targetReps: newR };
      return out;
    }),
  };
}

export function unitWord(m: Measure, n: number | null): string {
  const one = n === 1;
  return m === "seconds" ? (one ? "second" : "seconds") : m === "meters" ? (one ? "meter" : "meters") : one ? "rep" : "reps";
}

/** "10 reps at 50 lb" — the spoken form of a set. */
export function describeSet(s: SetEntry, m: Measure): string {
  const reps = shownReps(s);
  const weight = shownWeight(s);
  return `${reps ?? "no target"} ${reps === null ? "" : unitWord(m, reps)}${weight ? ` at ${weight} lb` : ""}`.replace(/\s+/g, " ").trim();
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
