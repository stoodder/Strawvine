/**
 * A workout's structure (§6.5 Accessories & supersets): which block each exercise is in and in
 * what order. A block holding more than one exercise is a superset; its order (A1, A2, …) is the
 * order a round is logged in. Pure and immutable.
 *
 * Blocks belong to a **group** (SPEC §6.7): the main lift, Strength's Accessories or Core
 * subsection (`section`), or one rehab block's section (`kind: "rehab"`, `rehab: id`). They are
 * stored in that order (`normalizeSectionOrder`), and read grouped by a stable sort, so a document
 * an older build reordered still reads right. A block moves between Accessories and Core only with
 * `moveToSection` (a superset whole); an exercise can join a superset of either (it is then in
 * that block's subsection), never one of rehab, nor rehab exercises one of Strength or of another
 * rehab block.
 *
 * Core is a group only where the page shows Strength's subsections (`StructureOpts.core`: the new
 * Train, flag `trainDay`). Without it every accessory block is one list in stored order, `section`
 * or not — the letters, block moves and their indices exactly as before subsections existed, and
 * as an older build reads a document holding Core. `section` itself is kept whatever moves.
 *
 * Every operation keeps the identity of what it doesn't change — an exercise moved or reordered is
 * the same object (with its sets, logged or not, and their ids), a block it doesn't touch is the
 * same block — so `savedAfterEdit` still tells an untouched exercise from an edited one, and the
 * sync merge follows a moved exercise by its set ids. An operation that can't apply (a server
 * limit, the main lift, a position out of range, another group, nothing to do) returns the session
 * unchanged (the same object), so applying one twice is the same as once.
 *
 * The main-lift (primary) block takes no part: it holds the main lift alone, never joins or
 * receives a superset member, and keeps its place (the screen always shows it first).
 */
import type { Block, BlockExercise, Session } from "./schemas";
import { newId } from "./session";

/** Server limits (sessionSchema): sets per exercise, exercises per superset, blocks per session (rehab included). */
export const MAX_SETS = 30;
export const MAX_SUPERSET = 6;
export const MAX_BLOCKS = 30;

/** An exercise by its block and position in it. */
export interface ExPlace {
  blockId: string;
  exIdx: number;
}

/** Where a block is shown: the main lift, Strength's Accessories or Core, or Rehab. */
export type BlockGroup = "main" | "accessories" | "core" | "rehab";

/**
 * How the page reads Strength: `core` — in its subsections, Accessories then Core (the new Train).
 * Without it (the default) Core is read as Accessories, as before subsections existed.
 */
export interface StructureOpts {
  core?: boolean;
}

/** A block's group (`kind`, then — with `opts.core` — an accessory's `section`; absent = Accessories). */
export const blockGroup = (b: Pick<Block, "kind" | "section">, opts: StructureOpts = {}): BlockGroup =>
  b.kind === "primary" ? "main" : b.kind === "rehab" ? "rehab" : opts.core && b.section === "core" ? "core" : "accessories";

const RANK: Record<BlockGroup, number> = { main: 0, accessories: 1, core: 2, rehab: 3 };

/** Two blocks are in the same group: the same subsection, or rehab blocks of the same rehab block. */
export const sameGroup = (a: Block, b: Block, opts: StructureOpts = {}): boolean =>
  blockGroup(a, opts) === blockGroup(b, opts) && (a.kind !== "rehab" || a.rehab === b.rehab);

/**
 * An exercise can move between the two blocks: both of Strength's accessories (Accessories or
 * Core — the superset it joins stays in its own subsection), or both of the same rehab block.
 */
const sameFamily = (a: Block, b: Block): boolean => a.kind === b.kind && (a.kind !== "rehab" || a.rehab === b.rehab);

/**
 * The blocks in page order: main lift, Accessories, Core (with `opts.core`), Rehab — each group in
 * stored order (a stable sort).
 */
export function pageOrder(session: Pick<Session, "blocks">, opts: StructureOpts = {}): Block[] {
  return session.blocks
    .map((b, i) => ({ b, i }))
    .sort((x, y) => RANK[blockGroup(x.b, opts)] - RANK[blockGroup(y.b, opts)] || x.i - y.i)
    .map((x) => x.b);
}

/**
 * The session with its blocks stored in page order (`pageOrder`): `[main, accessories, core,
 * rehab]`. The same object when they already are — every session saved before subsections and
 * rehab existed — so it is safe on any save.
 */
export function normalizeSectionOrder(session: Session, opts: StructureOpts = {}): Session {
  const sorted = pageOrder(session, opts);
  return sorted.every((b, i) => b === session.blocks[i]) ? session : { ...session, blocks: sorted };
}

/**
 * The blocks of one group in stored order: a subsection's, or rehab's (`opts.rehab`: of that rehab
 * block only; omitted, every rehab block).
 */
export function groupBlocks(session: Pick<Session, "blocks">, group: BlockGroup, opts: StructureOpts & { rehab?: string } = {}): Block[] {
  return session.blocks.filter((b) => blockGroup(b, opts) === group && (opts.rehab === undefined || b.rehab === opts.rehab));
}

/** A block exercises can move within: an accessory or rehab block (never the main lift's). */
const structural = (s: Session, blockId: string): Block | undefined => s.blocks.find((b) => b.id === blockId && b.kind !== "primary");

/**
 * Superset letters in page order (`pageOrder`): the first block of 2+ exercises is A, then B…
 * They run through the page — A, B in Accessories, C in Core (`opts.core`), D in Rehab — and come
 * out as an older build's (which reads Core as accessories) once blocks are stored in page order.
 * Without `opts.core`: in stored order, as a page without subsections lists the accessory blocks.
 */
export function supersetLetters(session: Session, opts: StructureOpts = {}): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const b of pageOrder(session, opts))
    if (b.kind !== "primary" && b.exercises.length > 1) out.set(b.id, String.fromCharCode(65 + out.size));
  return out;
}

/** The accessory blocks (Accessories and Core) in the order the workout lists them. */
export const accessoryBlocks = (session: Session): Block[] => session.blocks.filter((b) => b.kind === "accessory");

/**
 * Move an exercise (with all its sets) into another block, at `at` (default: the end, i.e. the next
 * member of the superset). Its old block loses it, and disappears when that leaves it empty; it is
 * then in the target block's subsection (a Core exercise joining an Accessories superset is an
 * accessory there, as it always was). Unchanged when either block is the main lift's or missing,
 * one is Strength's and the other rehab's, they are of two rehab blocks, it's the same block, or
 * the target already holds `MAX_SUPERSET` exercises.
 */
export function moveExerciseToBlock(session: Session, from: ExPlace, toBlockId: string, at?: number): Session {
  const src = structural(session, from.blockId);
  const dest = structural(session, toBlockId);
  const ex = src?.exercises[from.exIdx];
  if (!src || !dest || !ex || src === dest || !sameFamily(src, dest) || dest.exercises.length >= MAX_SUPERSET) return session;
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
  const b = structural(session, blockId);
  if (!b || !b.exercises[fromIdx]) return session;
  const target = Math.max(0, Math.min(to, b.exercises.length - 1));
  if (target === fromIdx) return session;
  const exercises = [...b.exercises];
  const [ex] = exercises.splice(fromIdx, 1);
  exercises.splice(target, 0, ex!);
  return { ...session, blocks: session.blocks.map((x) => (x === b ? { ...b, exercises } : x)) };
}

/**
 * Put a block at another position among the blocks of its group (`to`, clamped: an index into that
 * group, in stored order): a rehab block among its own; with `opts.core`, Accessories' blocks among
 * Accessories', Core's among Core's (crossing between them is `moveToSection`) — without it, an
 * accessory block among every accessory block (`accessoryBlocks`, Core's included), as before
 * subsections existed. Every other block keeps its place in the list. Unchanged when the block is
 * missing, the main lift's, or already there.
 */
export function moveBlock(session: Session, blockId: string, to: number, opts: StructureOpts = {}): Session {
  const block = structural(session, blockId);
  if (!block) return session;
  const inGroup = (b: Block) => sameGroup(b, block, opts);
  const list = session.blocks.filter(inGroup);
  const from = list.indexOf(block);
  const target = Math.max(0, Math.min(to, list.length - 1));
  if (target === from) return session;
  list.splice(from, 1);
  list.splice(target, 0, block);
  let k = 0;
  return { ...session, blocks: session.blocks.map((x) => (inGroup(x) ? list[k++]! : x)) };
}

/**
 * Move an accessory block — a superset whole — to Strength's other subsection (`to`), at position
 * `at` among that subsection's blocks (clamped; default: the end), stored in page order
 * (`normalizeSectionOrder`). It is written as `section: to`: a block moved to Accessories says so
 * ("accessories"), so pre-fill's legacy Core rule — which only reads a template with no `section`
 * at all — never files it under Core again. Unchanged for the main lift, a rehab block, a missing
 * block, or one already there.
 */
export function moveToSection(session: Session, blockId: string, to: "accessories" | "core", at?: number): Session {
  const core = { core: true };
  const block = session.blocks.find((b) => b.id === blockId && b.kind === "accessory");
  if (!block || blockGroup(block, core) === to) return session;
  const moved: Block = { ...block, section: to };
  const others = session.blocks.filter((b) => b !== block);
  const dest = others.filter((b) => blockGroup(b, core) === to);
  const before = at !== undefined && at < dest.length ? dest[Math.max(0, at)] : undefined;
  const blocks = before ? others.flatMap((b) => (b === before ? [moved, b] : [b])) : [...others, moved];
  return normalizeSectionOrder({ ...session, blocks }, core);
}

/**
 * Take an exercise out of its superset: it gets a block of its own (in the same group: kind,
 * subsection and rehab block copied) right after the superset (a superset of two leaves a single
 * exercise behind). Unchanged when it isn't in a superset, the session already holds `MAX_BLOCKS`
 * blocks, or the block is the main lift's.
 */
export function splitOut(session: Session, place: ExPlace, id: string = newId()): Session {
  const b = structural(session, place.blockId);
  const ex = b?.exercises[place.exIdx];
  if (!b || !ex || b.exercises.length < 2 || session.blocks.length >= MAX_BLOCKS) return session;
  const rest: Block = { ...b, exercises: b.exercises.filter((_, i) => i !== place.exIdx) };
  const own: Block = { id, kind: b.kind, exercises: [ex] };
  if (b.section !== undefined) own.section = b.section;
  if (b.rehab !== undefined) own.rehab = b.rehab;
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
 * The exercises of the other blocks that can move into the block (`moveExerciseToBlock`), in
 * workout order: what "Add from this workout" offers for a block (a superset of Strength: every
 * accessory and Core exercise, as it always did; a rehab one: its rehab block's). Empty when the
 * block is the main lift's, missing or full.
 */
export function movableInto(session: Session, blockId: string): MoveCandidate[] {
  const dest = structural(session, blockId);
  if (!dest || dest.exercises.length >= MAX_SUPERSET) return [];
  return session.blocks.flatMap((b) =>
    b === dest || !sameFamily(b, dest)
      ? []
      : b.exercises.map((exercise, exIdx) => ({ blockId: b.id, exIdx, exercise, fromSuperset: b.exercises.length > 1 })),
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
