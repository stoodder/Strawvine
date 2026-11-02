/**
 * Superset edits on top of sessionStructure (§6.5) that need more than one structure operation:
 * what "Add another exercise" can add to a block, and undoing "Remove from superset". Pure.
 */
import type { BlockExercise, Session } from "./schemas";
import { MAX_SUPERSET, moveExerciseToBlock, movableInto, reorderInBlock, type ExPlace } from "./sessionStructure";

/**
 * How an exercise of the library stands for "Add another exercise" on a block:
 * - `member`: already in that block (not offered again);
 * - `elsewhere`: an accessory of this workout in another block, at `place` — picking it moves it
 *   in with its sets (as "Add from this workout"), it isn't added a second time;
 * - `main`: this session's main lift (which never joins a superset) and not an accessory elsewhere.
 * Exercises not in the map are added as new (pre-filled).
 */
export type AddStanding = { kind: "member" } | { kind: "elsewhere"; place: ExPlace } | { kind: "main" };

export function addStandings(session: Session, blockId: string): ReadonlyMap<number, AddStanding> {
  const out = new Map<number, AddStanding>();
  for (const b of session.blocks) if (b.kind === "primary") for (const e of b.exercises) out.set(e.exerciseId, { kind: "main" });
  // The first copy in workout order (movableInto's order) is the one that moves.
  const seen = new Set<number>();
  for (const c of movableInto(session, blockId)) {
    if (seen.has(c.exercise.exerciseId)) continue;
    seen.add(c.exercise.exerciseId);
    out.set(c.exercise.exerciseId, { kind: "elsewhere", place: { blockId: c.blockId, exIdx: c.exIdx } });
  }
  const dest = session.blocks.find((b) => b.id === blockId);
  for (const e of dest?.exercises ?? []) out.set(e.exerciseId, { kind: "member" });
  return out;
}

export type RejoinResult = { session: Session } | { cannot: "gone" | "superset-gone" | "full" };

/**
 * Undo `splitOut(session, from, ownId)`: put the exercise back into its superset at its old
 * position (`from.exIdx`, clamped), wherever it is by now. It is found in the block of its own
 * (`ownId`) — by object, by a set it holds, else the one exercise of that id there — or, once
 * that block is gone, anywhere by object or set (`copies`: the objects it was known by, e.g. as
 * shown and as saved; an exercise with no sets whose measure the view changed matches neither by
 * set id, so the block is the reliable handle). Already back in the superset, it only takes its
 * old position again. Says why when it can't: the exercise or the superset is no longer in the
 * workout, or the superset has since filled up.
 */
export function rejoinSuperset(
  session: Session,
  from: ExPlace,
  ownId: string,
  exerciseId: number,
  copies: ReadonlyArray<BlockExercise | undefined> = [],
): RejoinResult {
  const known = copies.filter((c): c is BlockExercise => !!c && c.exerciseId === exerciseId);
  const ids = new Set(known.flatMap((c) => c.sets.map((s) => s.id)));
  const matches = (e: BlockExercise) => e.exerciseId === exerciseId && (known.includes(e) || e.sets.some((s) => ids.has(s.id)));
  let place: ExPlace | null = null;
  const own = session.blocks.find((b) => b.id === ownId && b.kind === "accessory");
  if (own) {
    let i = own.exercises.findIndex(matches);
    if (i === -1 && own.exercises.length === 1 && own.exercises[0]!.exerciseId === exerciseId) i = 0;
    if (i !== -1) place = { blockId: ownId, exIdx: i };
  }
  if (!place)
    for (const b of session.blocks) {
      if (b.kind !== "accessory") continue;
      const i = b.exercises.findIndex(matches);
      if (i !== -1) {
        place = { blockId: b.id, exIdx: i };
        break;
      }
    }
  if (!place) return { cannot: "gone" };
  const dest = session.blocks.find((b) => b.id === from.blockId && b.kind === "accessory");
  if (!dest) return { cannot: "superset-gone" };
  if (place.blockId === from.blockId) return { session: reorderInBlock(session, from.blockId, place.exIdx, from.exIdx) };
  if (dest.exercises.length >= MAX_SUPERSET) return { cannot: "full" };
  const next = moveExerciseToBlock(session, place, from.blockId, from.exIdx);
  return next === session ? { cannot: "gone" } : { session: next };
}
