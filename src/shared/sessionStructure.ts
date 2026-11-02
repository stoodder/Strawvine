/**
 * A workout's structure (§6.5 Accessories & supersets): which accessory block each exercise is in
 * and in what order. A block holding more than one exercise is a superset; its order (A1, A2, …)
 * is the order a round is logged in. Pure and immutable.
 *
 * Every operation keeps the identity of what it doesn't change — an exercise moved or reordered is
 * the same object (with its sets, logged or not, and their ids), a block it doesn't touch is the
 * same block — so `savedAfterEdit` still tells an untouched exercise from an edited one, and the
 * sync merge follows a moved exercise by its set ids. An operation that can't apply (a server
 * limit, the main lift, a position out of range, nothing to do) returns the session unchanged (the
 * same object), so applying one twice is the same as once.
 *
 * The main-lift (primary) block takes no part: it holds the main lift alone, never joins or
 * receives a superset member, and keeps its place (the screen always shows it first).
 */
import type { Block, BlockExercise, Session } from "./schemas";
import { newId } from "./session";

/** Server limits (sessionSchema): sets per exercise, exercises per superset, blocks per session. */
export const MAX_SETS = 30;
export const MAX_SUPERSET = 6;
export const MAX_BLOCKS = 30;

/** An exercise by its block and position in it. */
export interface ExPlace {
  blockId: string;
  exIdx: number;
}

const accessory = (s: Session, blockId: string): Block | undefined => s.blocks.find((b) => b.id === blockId && b.kind === "accessory");

/** Superset letters in page order: the first accessory block of 2+ exercises is A, then B… */
export function supersetLetters(session: Session): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const b of session.blocks) if (b.kind === "accessory" && b.exercises.length > 1) out.set(b.id, String.fromCharCode(65 + out.size));
  return out;
}

/** The accessory blocks in the order the workout lists them. */
export const accessoryBlocks = (session: Session): Block[] => session.blocks.filter((b) => b.kind === "accessory");

/**
 * Move an accessory exercise (with all its sets) into another accessory block, at `at` (default:
 * the end, i.e. the next member of the superset). Its old block loses it, and disappears when that
 * leaves it empty. Unchanged when either block is the main lift's or missing, it's the same block,
 * or the target already holds `MAX_SUPERSET` exercises.
 */
export function moveExerciseToBlock(session: Session, from: ExPlace, toBlockId: string, at?: number): Session {
  const src = accessory(session, from.blockId);
  const dest = accessory(session, toBlockId);
  const ex = src?.exercises[from.exIdx];
  if (!src || !dest || !ex || src === dest || dest.exercises.length >= MAX_SUPERSET) return session;
  const exercises = [...dest.exercises];
  exercises.splice(at === undefined ? exercises.length : Math.max(0, Math.min(at, exercises.length)), 0, ex);
  const left = src.exercises.filter((_, i) => i !== from.exIdx);
  const blocks = session.blocks.flatMap((b): Block[] =>
    b === src ? (left.length ? [{ ...b, exercises: left }] : []) : b === dest ? [{ ...b, exercises }] : [b],
  );
  return { ...session, blocks };
}

/**
 * Put an exercise of a block at another position in it (`to`, clamped): the superset's new A1,
 * A2… order. Unchanged for the main lift's block, a missing exercise, or the same position.
 */
export function reorderInBlock(session: Session, blockId: string, fromIdx: number, to: number): Session {
  const b = accessory(session, blockId);
  if (!b || !b.exercises[fromIdx]) return session;
  const target = Math.max(0, Math.min(to, b.exercises.length - 1));
  if (target === fromIdx) return session;
  const exercises = [...b.exercises];
  const [ex] = exercises.splice(fromIdx, 1);
  exercises.splice(target, 0, ex!);
  return { ...session, blocks: session.blocks.map((x) => (x === b ? { ...b, exercises } : x)) };
}

/**
 * Put an accessory block at another position among the accessory blocks (`to`, clamped). The main
 * lift's block keeps its own place in the list. Unchanged when the block is missing, the main
 * lift's, or already there.
 */
export function moveBlock(session: Session, blockId: string, to: number): Session {
  const list = accessoryBlocks(session);
  const from = list.findIndex((b) => b.id === blockId);
  if (from === -1) return session;
  const target = Math.max(0, Math.min(to, list.length - 1));
  if (target === from) return session;
  const [b] = list.splice(from, 1);
  list.splice(target, 0, b!);
  let k = 0;
  return { ...session, blocks: session.blocks.map((x) => (x.kind === "accessory" ? list[k++]! : x)) };
}

/**
 * Take an exercise out of its superset: it gets a block of its own right after the superset (a
 * superset of two leaves a single exercise behind). Unchanged when it isn't in a superset, the
 * session already holds `MAX_BLOCKS` blocks, or the block is the main lift's.
 */
export function splitOut(session: Session, place: ExPlace, id: string = newId()): Session {
  const b = accessory(session, place.blockId);
  const ex = b?.exercises[place.exIdx];
  if (!b || !ex || b.exercises.length < 2 || session.blocks.length >= MAX_BLOCKS) return session;
  const rest: Block = { ...b, exercises: b.exercises.filter((_, i) => i !== place.exIdx) };
  const own: Block = { id, kind: "accessory", exercises: [ex] };
  return { ...session, blocks: session.blocks.flatMap((x) => (x === b ? [rest, own] : [x])) };
}

/**
 * An id for a block derived from another (`<id>-2`, `-3`, … — the first not in `taken`, which it
 * joins). Deterministic, so two devices deriving a block from the same one agree on its id.
 */
export function derivedBlockId(from: string, taken: Set<string>): string {
  let n = 2;
  while (taken.has(`${from.slice(0, 36)}-${n}`)) n++;
  const id = `${from.slice(0, 36)}-${n}`;
  taken.add(id);
  return id;
}

/**
 * The main-lift block holds the main lift alone (the screen shows only its first exercise). A
 * main-lift block holding more (from an old build, a hand-made import, a merge) keeps its first
 * exercise; the others, with all their sets, move into an accessory block right after it (with a
 * derived id, see `derivedBlockId`) — nothing is dropped. The same session (same object) when
 * there is nothing to do. The result can hold one block more than `MAX_BLOCKS` per such block.
 */
export function normalizeMainLift(session: Session): Session {
  if (!session.blocks.some((b) => b.kind === "primary" && b.exercises.length > 1)) return session;
  const taken = new Set(session.blocks.map((b) => b.id));
  const blocks = session.blocks.flatMap((b): Block[] => {
    if (b.kind !== "primary" || b.exercises.length < 2) return [b];
    const [first, ...rest] = b.exercises;
    return [
      { ...b, exercises: [first!] },
      { id: derivedBlockId(b.id, taken), kind: "accessory", exercises: rest },
    ];
  });
  return { ...session, blocks };
}

/** An exercise of the workout that can join a block (`movableInto`). */
export interface MoveCandidate extends ExPlace {
  exercise: BlockExercise;
  /** The superset it would leave (its block holds others too). */
  fromSuperset: boolean;
}

/**
 * The exercises in the other accessory blocks, in workout order: what "Add from this workout"
 * offers for a block. Empty when the block is the main lift's, missing or full.
 */
export function movableInto(session: Session, blockId: string): MoveCandidate[] {
  const dest = accessory(session, blockId);
  if (!dest || dest.exercises.length >= MAX_SUPERSET) return [];
  return accessoryBlocks(session).flatMap((b) =>
    b === dest ? [] : b.exercises.map((exercise, exIdx) => ({ blockId: b.id, exIdx, exercise, fromSuperset: b.exercises.length > 1 })),
  );
}

/**
 * Where an exercise is now (by the object, else by a set it holds): an exercise keeps its sets'
 * ids wherever it moves, so a place remembered before a move can be found again.
 */
export function locateExercise(session: Session, ex: BlockExercise): ExPlace | null {
  const ids = new Set(ex.sets.map((s) => s.id));
  for (const b of session.blocks) {
    const i = b.exercises.findIndex((e) => e === ex || (ids.size > 0 && e.sets.some((s) => ids.has(s.id))));
    if (i !== -1) return { blockId: b.id, exIdx: i };
  }
  return null;
}
