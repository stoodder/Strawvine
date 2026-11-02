/**
 * Three-way merges for version-checked saves (pure; no browser APIs). When a whole-document save
 * (a workout, the settings) comes back 409 because another device saved the document since this
 * edit was made, the edit is re-applied on top of the server's copy:
 *
 * - `ancestor`: the server's document the edit was based on (null: there was none),
 * - `local`: the edited document this device tried to save,
 * - `server`: the server's current document.
 *
 * Whatever this device changed (relative to the ancestor) wins; everything else comes from the
 * server, so the other device's changes are kept.
 */
import type { Block, BlockExercise, Session, SetEntry, Settings } from "../../shared/schemas";
import { derivedBlockId, MAX_BLOCKS, MAX_SETS, MAX_SUPERSET, normalizeMainLift } from "../../shared/sessionStructure";

/**
 * Deep equality for JSON-shaped data (keys whose value is `undefined` count as absent). Fast
 * when most of the structure is shared: identical references short-circuit.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  let n = 0;
  for (const k in ao) {
    if (ao[k] === undefined) continue;
    n++;
    if (!deepEqual(ao[k], bo[k])) return false;
  }
  for (const k in bo) if (bo[k] !== undefined) n--;
  return n === 0;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

type Side = "a" | "l" | "s";

/**
 * Pairs up the items of two lists: by key first, then (for items the ancestor doesn't know, i.e.
 * built independently on each device) by `fallback` in order. Returns, for each `local` index, the
 * `server` index it pairs with (or -1).
 */
function align<T>(
  local: readonly T[],
  server: readonly T[],
  key: (x: T, i: number, side: Side) => string,
  fallback: (x: T) => string,
  known: Set<string>,
) {
  const pairs = local.map(() => -1);
  const used = new Set<number>();
  const byKey = new Map<string, number>();
  server.forEach((x, i) => byKey.set(key(x, i, "s"), i));
  local.forEach((x, i) => {
    const j = byKey.get(key(x, i, "l"));
    if (j !== undefined && !used.has(j)) {
      pairs[i] = j;
      used.add(j);
    }
  });
  local.forEach((x, i) => {
    if (pairs[i] !== -1 || known.has(key(x, i, "l"))) return;
    const j = server.findIndex((y, n) => !used.has(n) && !known.has(key(y, n, "s")) && fallback(y) === fallback(x));
    if (j >= 0) {
      pairs[i] = j;
      used.add(j);
    }
  });
  return pairs;
}

/**
 * Whether one version changed the relative order of the items it shares with the ancestor (a
 * reorder; adding or removing items isn't one).
 */
function reordered<T>(ancestor: readonly T[] | null, list: readonly T[], key: (x: T, i: number, side: Side) => string, side: Side) {
  if (!ancestor) return false;
  const pos = new Map<string, number>();
  ancestor.forEach((x, i) => pos.set(key(x, i, "a"), i));
  let last = -1;
  for (let i = 0; i < list.length; i++) {
    const p = pos.get(key(list[i]!, i, side));
    if (p === undefined) continue;
    if (p < last) return true;
    last = p;
  }
  return false;
}

/**
 * The merged list: the items both versions hold (merged), the ones only one of them holds that are
 * worth keeping, in this device's order — or in the server's when only the server reordered the
 * items they share (e.g. a superset's order, or the workout's, changed there while this device
 * logged). Items only the other version holds go after the item that precedes them there — and
 * after everything both hold when nothing both hold follows them there (added at the end, they
 * stay at the end even when the other version moved their predecessor up).
 */
function mergeList<T>(
  ancestor: readonly T[] | null,
  local: readonly T[],
  server: readonly T[],
  key: (x: T, i: number, side: Side) => string,
  fallback: (x: T) => string,
  mergeItem: (a: T | undefined, l: T, s: T) => T,
): T[] {
  const anc = new Map<string, T>();
  ancestor?.forEach((x, i) => anc.set(key(x, i, "a"), x));
  const known = new Set(anc.keys());
  const pairs = align(local, server, key, fallback, known);
  const paired = new Set(pairs.filter((j) => j >= 0));

  type Entry = { item: T; l: number; s: number };
  const entries: Entry[] = [];
  local.forEach((l, i) => {
    const j = pairs[i]!;
    const a = anc.get(key(l, i, "l"));
    if (j >= 0) entries.push({ item: mergeItem(a, l, server[j]!), l: i, s: j });
    else if (!a || !deepEqual(a, l)) entries.push({ item: l, l: i, s: -1 }); // added here, or changed here after the server dropped it
    // else: unchanged here and removed on the server → stays removed
  });
  server.forEach((s, j) => {
    if (paired.has(j)) return;
    const a = anc.get(key(s, j, "s"));
    if (a && deepEqual(a, s)) return; // removed here, untouched on the server → stays removed
    // Added on the server (or changed there after this device removed it): keep it.
    entries.push({ item: s, l: -1, s: j });
  });

  // The order to follow, and where the other version's own items go: after the nearest earlier
  // item of their version that made it into the result.
  const byServer = !reordered(ancestor, local, key, "l") && reordered(ancestor, server, key, "s");
  const lead: keyof Entry = byServer ? "s" : "l";
  const other: keyof Entry = byServer ? "l" : "s";
  const out = entries.filter((e) => e[lead] >= 0).sort((x, y) => x[lead] - y[lead]);
  const shared = (o: Entry) => o.l >= 0 && o.s >= 0;
  for (const e of entries.filter((x) => x[lead] < 0).sort((x, y) => x[other] - y[other])) {
    let at = 0;
    for (let n = e[other] - 1; n >= 0; n--) {
      const k = out.findIndex((o) => o[other] === n);
      if (k >= 0) {
        at = k + 1;
        break;
      }
    }
    // One at the end of its version (nothing both hold comes after it there) stays at the end,
    // even when the other version moved the item before it up the list.
    const last = !entries.some((o) => shared(o) && o[other] > e[other]);
    if (last && out.slice(at).some(shared)) at = out.length;
    out.splice(at, 0, e);
  }
  return out.map((o) => o.item);
}

// ---------------------------------------------------------------------------
// Fields and settings
// ---------------------------------------------------------------------------

/**
 * How a list inside a merged object is merged (by its dotted path, list indexes as `#`):
 * - `byId`: items matched by their `id` (added/removed/edited on either side all survive),
 * - `index`: fixed-length lists, element by element (when all three have the same length),
 * - otherwise the list is one value: this device's when it changed it, else the server's. When
 *   both changed it differently this device's wins and the path is reported as a conflict.
 */
type ListRule = "byId" | "index";

interface FieldCtx {
  rules: Record<string, ListRule>;
  conflicts: string[];
}

function mergeAt(a: unknown, l: unknown, s: unknown, path: string, ctx: FieldCtx | null): unknown {
  if (isPlainObject(l) && isPlainObject(s) && (a == null || isPlainObject(a))) {
    const anc = (a ?? null) as Record<string, unknown> | null;
    const out: Record<string, unknown> = { ...s };
    for (const k of new Set([...Object.keys(l), ...Object.keys(s), ...(anc ? Object.keys(anc) : [])])) {
      const av = anc ? anc[k] : undefined;
      const lv = l[k];
      if (anc && deepEqual(lv, av)) continue; // untouched here: the server's value stands
      if (!anc) {
        // Nothing to compare with: keep what the server has unless this device has a value.
        if (lv !== undefined) out[k] = lv;
        continue;
      }
      const sub = path ? `${path}.${k}` : k;
      // Objects merge key by key, lists by their rule; anything else is this device's value.
      const v = (isPlainObject(lv) && isPlainObject(s[k]) && isPlainObject(av)) || Array.isArray(lv) ? mergeAt(av, lv, s[k], sub, ctx) : lv;
      if (v === undefined) delete out[k];
      else out[k] = v;
    }
    return out;
  }
  if (a !== undefined && a !== null && deepEqual(l, a)) return s;
  if (Array.isArray(l) && Array.isArray(s) && Array.isArray(a) && ctx) {
    const rule = ctx.rules[path];
    if (rule === "byId" && [a, l, s].every((xs) => xs.every((x) => isPlainObject(x) && typeof x.id === "string"))) {
      const idOf = (x: unknown) => (x as { id: string }).id;
      return mergeList(
        a,
        l,
        s,
        idOf,
        (x) => `#${idOf(x)}`,
        (ai, li, si) => (ai === undefined ? li : mergeAt(ai, li, si, `${path}.#`, ctx)),
      );
    }
    if (rule === "index" && a.length === l.length && a.length === s.length)
      return l.map((li, i) => mergeAt(a[i], li, s[i], `${path}.#`, ctx));
  }
  // One value: this device changed it (or there's no ancestor) → this device's.
  if (ctx && a != null && !deepEqual(s, a) && !deepEqual(s, l) && (Array.isArray(l) || Array.isArray(s))) ctx.conflicts.push(path);
  return l;
}

/**
 * Field-level merge: plain objects merge key by key (recursively); any other value (arrays
 * included) is taken whole from `local` when this device changed it, else from `server`.
 */
export function mergeFields<T>(ancestor: T | null | undefined, local: T, server: T): T {
  return mergeAt(ancestor, local, server, "", null) as T;
}

/** Settings lists that aren't single values (see `ListRule`). */
const SETTINGS_RULES: Record<string, ListRule> = {
  strengthTargets: "byId",
  "schedule.metcon": "index",
  "schedule.zone2": "index",
  "program.weeks": "index",
};

/** Readable names for settings paths a conflict can be reported on. */
const SETTINGS_LABELS: Array<[RegExp, string]> = [
  [/^program\.weeks/, "program weeks"],
  [/^program\.days/, "program days"],
  [/^strengthTargets/, "strength targets"],
  [/^schedule/, "weekly schedule"],
];

export interface SettingsMerge {
  value: Settings;
  /**
   * Lists both devices changed in ways that can't be combined (this device's version was kept),
   * as readable names ("program weeks"); empty when everything merged cleanly.
   */
  conflicts: string[];
}

/**
 * Settings: the keys this device changed (at any depth) on top of the server's copy. Lists
 * merge item by item where that's meaningful: strength targets by id, the weekly schedule and
 * the program's weeks element by element; other lists are single values (see `SettingsMerge`).
 */
export function mergeSettingsDetailed(ancestor: Settings | null | undefined, local: Settings, server: Settings): SettingsMerge {
  const ctx: FieldCtx = { rules: SETTINGS_RULES, conflicts: [] };
  const value = mergeAt(ancestor, local, server, "", ctx) as Settings;
  const conflicts = [...new Set(ctx.conflicts.map((p) => SETTINGS_LABELS.find(([re]) => re.test(p))?.[1] ?? p.replace(/\.#/g, "")))];
  return { value, conflicts };
}

export function mergeSettings(ancestor: Settings | null | undefined, local: Settings, server: Settings): Settings {
  return mergeSettingsDetailed(ancestor, local, server).value;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/**
 * A set logged or edited on this device wins — except that a set logged on either side beats an
 * edit of the same, still unlogged set's targets on the other (its targets, or a measure change
 * shown on a stale copy, must never unlog what was done). With no common ancestor, a logged set
 * beats an unlogged one.
 */
function mergeSet(a: SetEntry | undefined, l: SetEntry, s: SetEntry): SetEntry {
  if (a) {
    if (deepEqual(l, a)) return s;
    if (!a.done && !l.done && s.done) return s;
    return l;
  }
  if (s.done && !l.done) return { ...s, id: l.id };
  return l;
}

/**
 * Exercise identities across the three versions of a session. Set ids are unique within a
 * session and travel with their exercise (moved into or out of a superset, swapped for another
 * lift), so an exercise is identified by the sets it holds: exercises in different versions that
 * share a set id are the same exercise, wherever each version keeps it.
 *
 * An exercise the ancestor holds without sets has nothing to follow it by, so it is identified
 * across the whole workout by its lift: in this device's and the server's version, an exercise
 * none of whose sets the ancestor knows (still set-less, or with sets added since) takes the
 * identity of an ancestor set-less exercise of the same lift — first one in the same block (in
 * order), else anywhere in the workout (in workout order), set-less exercises before ones that
 * gained sets. So one moved to another block on one device while the other skips it, logs it or
 * moves it elsewhere is still one exercise; the same lift twice on purpose stays twice. One
 * left over (added on this device or the server) is new.
 */
class Idents {
  private readonly bySet = new Map<string, string>();
  private readonly of: Record<Side, Map<BlockExercise, string>> = { a: new Map(), l: new Map(), s: new Map() };
  /** The ancestor's set-less exercises, in workout order. */
  private readonly bare: Array<{ t: string; block: string; exerciseId: number }> = [];
  private n = 0;

  add(doc: Session | null, side: Side) {
    if (!doc) return;
    const mine = this.of[side];
    const taken = new Set<string>();
    const open: Array<{ x: BlockExercise; block: string }> = [];
    for (const b of doc.blocks) {
      for (const x of b.exercises) {
        let t: string | undefined;
        for (const st of x.sets) {
          const k = this.bySet.get(st.id);
          if (k && !taken.has(k)) {
            t = k;
            break;
          }
        }
        if (!t && side === "a" && !x.sets.length) {
          t = `z${this.n++}`;
          this.bare.push({ t, block: b.id, exerciseId: x.exerciseId });
        }
        if (!t && side !== "a") {
          open.push({ x, block: b.id });
          continue;
        }
        t ??= `t${this.n++}`;
        this.claim(x, t, side, taken);
      }
    }
    // Set-less first, then the ones with (new) sets; same block first, then anywhere.
    const order = [...open.filter((o) => !o.x.sets.length), ...open.filter((o) => o.x.sets.length)];
    for (const sameBlock of [true, false])
      for (const o of order) {
        if (mine.has(o.x)) continue;
        const z = this.bare.find((e) => !taken.has(e.t) && e.exerciseId === o.x.exerciseId && (!sameBlock || e.block === o.block));
        if (z) this.claim(o.x, z.t, side, taken);
      }
    for (const o of open) if (!mine.has(o.x)) this.claim(o.x, `t${this.n++}`, side, taken);
  }

  private claim(x: BlockExercise, t: string, side: Side, taken: Set<string>) {
    taken.add(t);
    for (const st of x.sets) if (!this.bySet.has(st.id)) this.bySet.set(st.id, t);
    this.of[side].set(x, t);
  }

  get(x: BlockExercise, side: Side): string {
    return this.of[side].get(x) ?? `?${x.exerciseId}`;
  }

  /** Where each identity lives in a version: block id and position. */
  places(doc: Session | null, side: Side): Map<string, { block: string; index: number }> {
    const out = new Map<string, { block: string; index: number }>();
    doc?.blocks.forEach((b) => b.exercises.forEach((x, index) => out.set(this.get(x, side), { block: b.id, index })));
    return out;
  }
}

/**
 * Puts every exercise one version moved to another block (a superset split or joined) in that
 * block in all three versions, so the per-block merge pairs it with itself instead of seeing a
 * removal in one block and an addition in another. The mover's place wins (this device's when
 * both moved it); blocks left empty are dropped.
 */
function normalizeMoves(ids: Idents, docs: Record<Side, Session | null>): Record<Side, Session | null> {
  const places = { a: ids.places(docs.a, "a"), l: ids.places(docs.l, "l"), s: ids.places(docs.s, "s") };
  const moves: Array<{ t: string; to: { block: string; index: number }; from: Side }> = [];
  const all = new Set([...places.l.keys(), ...places.s.keys()]);
  for (const t of all) {
    const pa = places.a.get(t);
    const pl = places.l.get(t);
    const ps = places.s.get(t);
    let win: Side | null = null;
    if (pl && (!pa || pl.block !== pa.block) && ((ps && ps.block !== pl.block) || (pa && pl.block !== pa.block))) win = "l";
    else if (ps && pa && ps.block !== pa.block) win = "s";
    if (!win) continue;
    const to = (win === "l" ? pl : ps)!;
    if ([pa, pl, ps].every((p) => !p || p.block === to.block)) continue;
    moves.push({ t, to, from: win });
  }
  if (!moves.length) return docs;

  const out = { ...docs };
  for (const side of ["a", "l", "s"] as const) {
    const doc = docs[side];
    if (!doc) continue;
    let blocks = doc.blocks.map((b) => ({ ...b, exercises: [...b.exercises] }));
    let changed = false;
    for (const m of moves) {
      const p = places[side].get(m.t);
      if (!p || p.block === m.to.block) continue;
      const src = blocks.find((b) => b.id === p.block);
      const k = src ? src.exercises.findIndex((x) => ids.get(x, side) === m.t) : -1;
      if (!src || k < 0) continue;
      const [x] = src.exercises.splice(k, 1);
      let dest = blocks.find((b) => b.id === m.to.block);
      if (!dest) {
        // The block exists only in the mover's version: create it here, after the block that
        // precedes it there (or after the block the exercise came from).
        const winDoc = docs[m.from]!;
        const wi = winDoc.blocks.findIndex((b) => b.id === m.to.block);
        const head = winDoc.blocks[wi]!;
        dest = { ...head, exercises: [] };
        const prevId = wi > 0 ? winDoc.blocks[wi - 1]!.id : null;
        const after = prevId !== null ? blocks.findIndex((b) => b.id === prevId) : -1;
        const at = after >= 0 ? after + 1 : prevId === null ? 0 : blocks.indexOf(src) + 1;
        blocks.splice(at, 0, dest);
      }
      dest.exercises.splice(Math.min(m.to.index, dest.exercises.length), 0, x!);
      changed = true;
    }
    if (!changed) continue;
    blocks = blocks.filter((b) => b.exercises.length > 0);
    out[side] = { ...doc, blocks };
  }
  return out;
}

const hasLogged = (x: BlockExercise) => x.sets.some((st) => st.done);

/**
 * Exercises a merge had to keep apart from the one they were merged with (`mergeExercise`): the
 * block merge puts each right after it.
 */
const spills = new WeakMap<BlockExercise, BlockExercise>();

/**
 * An exercise saved on two devices: its fields merge like settings, its sets by id (`mergeSet`).
 * Sets are counted in the exercise's `measure`, so sets in two measures are never mixed. When the
 * two versions disagree on it:
 * - the side holding logged sets decides: its measure and its sets (the other side's are unlogged,
 *   and their targets meant another measure). A stale device showing a measure change can't turn
 *   rep sets logged elsewhere into seconds, nor the other way round;
 * - nothing logged on either side: the measure as fields merge it (this device's when it changed
 *   it), with that side's sets;
 * - logged sets on both sides, in different measures: the server's version stands — it is already
 *   what every other device has, and history and volume read it — and the sets logged on this
 *   device are kept apart, as a second entry of the exercise in their own measure right after it
 *   (spilled), rather than mixed in or lost.
 */
function mergeExercise(a: BlockExercise | undefined, l: BlockExercise, s: BlockExercise): BlockExercise {
  const { sets: _a, ...aRest } = a ?? ({} as Partial<BlockExercise>);
  const { sets: _l, ...lRest } = l;
  const { sets: _s, ...sRest } = s;
  const head = mergeFields(a ? aRest : null, lRest, sRest);
  if (l.measure !== s.measure) {
    const lLogged = hasLogged(l);
    const sLogged = hasLogged(s);
    if (lLogged && sLogged) {
      const kept = { ...head, measure: s.measure, sets: s.sets } as BlockExercise;
      const taken = new Set(s.sets.map((st) => st.id));
      const mine = l.sets.filter((st) => {
        if (!st.done) return false;
        const before = a?.sets.find((x) => x.id === st.id);
        const there = s.sets.find((x) => x.id === st.id);
        return !(before && deepEqual(before, st)) && !(there && deepEqual(there, st));
      });
      if (mine.length) {
        const sets = mine.map((st) => (taken.has(st.id) ? { ...st, id: `${st.id.slice(0, 36)}~m` } : st));
        const { skipped: _skip, ...rest } = l;
        spills.set(kept, { ...rest, sets });
      }
      return kept;
    }
    const from = lLogged ? l : sLogged ? s : head.measure === l.measure ? l : s;
    return { ...head, measure: from.measure, sets: from.sets } as BlockExercise;
  }
  const sets = mergeList(
    a?.sets ?? null,
    l.sets,
    s.sets,
    (x) => x.id,
    // Built independently on each device: pair sets in order. Sets added to a known exercise
    // on both devices are separate sets.
    a ? (x) => `#${x.id}` : () => "set",
    mergeSet,
  );
  return { ...head, sets } as BlockExercise;
}

const blockFallback = (b: Block) => (b.kind === "primary" ? "primary" : `accessory:${b.exercises.map((e) => e.exerciseId).join(",")}`);

function blockMerger(ids: Idents) {
  return (a: Block | undefined, l: Block, s: Block): Block => {
    const { exercises: _a, ...aRest } = a ?? ({} as Partial<Block>);
    const { exercises: _l, ...lRest } = l;
    const { exercises: _s, ...sRest } = s;
    const head = mergeFields(a ? aRest : null, lRest, sRest);
    const exercises = mergeList(
      a?.exercises ?? null,
      l.exercises,
      s.exercises,
      (x, _i, side) => ids.get(x, side),
      (x) => String(x.exerciseId),
      mergeExercise,
    ).flatMap((x) => {
      const apart = spills.get(x);
      return apart ? [x, apart] : [x];
    });
    return { ...head, id: l.id, exercises } as Block;
  };
}

const doneSets = (b: Block) => b.exercises.reduce((n, x) => n + x.sets.filter((st) => st.done).length, 0);
const samePlan = (x: Session, y: Session) =>
  (x.planSig ?? null) === (y.planSig ?? null) && (x.plannedFor ?? null) === (y.plannedFor ?? null);

/**
 * One main lift per workout. Two primary blocks survive a merge only when one device rebuilt the
 * session (a different plan: new block ids) while the other logged on the old one. The rule:
 * - the primary block kept is the one from the version whose plan (`planSig` and `plannedFor`,
 *   i.e. the program day `plannedFor ?? date`) the merged workout has; when both or neither
 *   match, the one with more logged sets (this device's on a tie);
 * - another primary block with nothing logged is dropped;
 * - one with logged sets for the same lift has those sets folded into the kept block (set by
 *   set onto sets not logged there yet; the rest appended);
 * - one with logged sets for a different lift is kept as an accessory block, so no logged work
 *   is lost.
 */
function oneMainLift(blocks: Block[], head: Session, local: Session, server: Session): Block[] {
  const primaries = blocks.filter((b) => b.kind === "primary");
  if (primaries.length < 2) return blocks;
  const sideOf = (b: Block): Side | null =>
    local.blocks.some((x) => x.id === b.id) ? "l" : server.blocks.some((x) => x.id === b.id) ? "s" : null;
  const planSide: Side | null =
    samePlan(head, local) && !samePlan(head, server) ? "l" : samePlan(head, server) && !samePlan(head, local) ? "s" : null;
  let keep = planSide ? primaries.find((b) => sideOf(b) === planSide) : undefined;
  keep ??= primaries.reduce((best, b) => (doneSets(b) > doneSets(best) ? b : best));
  let kept: Block = keep;
  // Placeholder for the main lift, at the place of the first one (filled in once folded).
  const out: Array<Block | null> = [];
  let placed = false;
  for (const b of blocks) {
    if (b.kind !== "primary") {
      out.push(b);
      continue;
    }
    if (!placed) {
      out.push(null);
      placed = true;
    }
    if (b === keep || !doneSets(b)) continue;
    const kx = kept.exercises;
    const bx = b.exercises;
    if (kx.length === 1 && bx.length === 1 && kx[0]!.exerciseId === bx[0]!.exerciseId) {
      const sets = [...kx[0]!.sets];
      for (const [i, st] of bx[0]!.sets.entries()) {
        if (!st.done) continue;
        const into = sets[i];
        if (into && !into.done)
          sets[i] = { ...into, reps: st.reps, weight: st.weight, done: true, appliedProgressionLb: st.appliedProgressionLb };
        else sets.push(st);
      }
      kept = { ...kept, exercises: [{ ...kx[0]!, sets }] };
      continue;
    }
    out.push({ ...b, kind: "accessory" });
  }
  return out.map((b) => b ?? kept);
}

/**
 * The finished merge must be a valid document: no set id twice (an exercise already present in
 * full is dropped, a stray duplicate set gets a fresh id), no empty block.
 */
function dedupe(blocks: Block[]): Block[] {
  const seen = new Set<string>();
  const out: Block[] = [];
  for (const b of blocks) {
    const exercises: BlockExercise[] = [];
    for (const x of b.exercises) {
      if (x.sets.length && x.sets.every((st) => seen.has(st.id))) continue;
      let changed = false;
      const sets = x.sets.map((st) => {
        if (!seen.has(st.id)) {
          seen.add(st.id);
          return st;
        }
        changed = true;
        let n = 2;
        while (seen.has(`${st.id.slice(0, 36)}~${n}`)) n++;
        const id = `${st.id.slice(0, 36)}~${n}`;
        seen.add(id);
        return { ...st, id };
      });
      exercises.push(changed ? { ...x, sets } : x);
    }
    if (!exercises.length) continue;
    out.push(exercises.length === b.exercises.length && exercises.every((x, i) => x === b.exercises[i]) ? b : { ...b, exercises });
  }
  return out;
}

/**
 * A workout saved on two devices: blocks matched by id (independently built sessions: the main
 * lift with the main lift, accessory blocks by their exercises); exercises by the sets they hold
 * (wherever each version keeps them: a superset split or joined on one device while the other
 * logged is followed — see `normalizeMoves`), else by lift; sets by id (else in order). A set
 * logged or edited here wins; sets, exercises and blocks only the server has are kept (unless
 * this device removed them and the server didn't touch them); every other field merges like
 * settings. Ids of matched items are this device's (what its screen holds). The result has one
 * main lift (see `oneMainLift`), no repeated set id and no empty block. It can exceed the
 * server's limits (see `fitSession`).
 */
export function mergeSession(ancestor: Session | null | undefined, local: Session, server: Session): Session {
  const ids = new Idents();
  ids.add(ancestor ?? null, "a");
  ids.add(local, "l");
  ids.add(server, "s");
  const docs = normalizeMoves(ids, { a: ancestor ?? null, l: local, s: server });
  const anc = docs.a;
  const loc = docs.l!;
  const srv = docs.s!;

  const { blocks: _a, ...aRest } = anc ?? ({} as Partial<Session>);
  const { blocks: _l, ...lRest } = loc;
  const { blocks: _s, ...sRest } = srv;
  let head = mergeFields(anc ? aRest : null, lRest, sRest) as Omit<Session, "blocks">;
  if (!anc) {
    // Built on both devices: a finish or notes from either side survive.
    head = { ...head, completedAt: loc.completedAt ?? srv.completedAt, notes: loc.notes || srv.notes };
  }
  let blocks = mergeList(anc?.blocks ?? null, loc.blocks, srv.blocks, (b) => b.id, blockFallback, blockMerger(ids));
  blocks = oneMainLift(blocks, { ...head, blocks } as Session, local, server);
  blocks = dedupe(blocks);
  return { ...head, date: local.date, blocks } as Session;
}

// ---------------------------------------------------------------------------
// Server limits
// ---------------------------------------------------------------------------

/** The server's limits on a workout (sessionSchema) that a merge can run into. */
export const SESSION_LIMITS = { blocks: MAX_BLOCKS, superset: MAX_SUPERSET, sets: MAX_SETS } as const;

export interface SessionFit {
  doc: Session;
  /** Why it still doesn't fit (only logged work is left over a limit); `doc` is then as close as it gets. */
  error: string | null;
  /** Unlogged work left out to fit, as readable phrases ("2 unlogged sets were left out (…)"). */
  notices: string[];
}

const leftOut = (n: number, what: string, why: string) => `${n} unlogged ${what}${n === 1 ? " was" : "s were"} left out (${why})`;

/**
 * Brings a merged workout within the server's limits without losing logged work:
 * - a main-lift block holding more than its lift is split (`normalizeMainLift`);
 * - unlogged sets beyond 30 per exercise are dropped (from the end);
 * - a superset of more than 6 (e.g. each device moved an exercise into a superset of 5) keeps 6 —
 *   those with logged sets first, then in order, so what arrived last leaves — and the others
 *   move, with their sets, into a block of their own right after it (more for more than 12);
 * - beyond 30 blocks, blocks with nothing logged are dropped from the end — first the ones a
 *   superset's overflow would have needed, then any other.
 * Whatever unlogged work is dropped is reported in `notices`.
 */
export function fitSession(input: Session): SessionFit {
  const { blocks: maxBlocks, superset: maxEx, sets: maxSets } = SESSION_LIMITS;
  const doc = normalizeMainLift(input);
  let changed = doc !== input;
  let error: string | null = null;
  let lostSets = 0;
  const taken = new Set(doc.blocks.map((b) => b.id));
  const out: Array<{ block: Block; overflow: boolean }> = [];
  for (const b of doc.blocks) {
    const exercises = b.exercises.map((x) => {
      if (x.sets.length <= maxSets) return x;
      const sets = [...x.sets];
      for (let i = sets.length - 1; i >= 0 && sets.length > maxSets; i--) if (!sets[i]!.done) sets.splice(i, 1);
      if (sets.length > maxSets) error ??= `An exercise in the merged workout has more than ${maxSets} logged sets.`;
      lostSets += x.sets.length - sets.length;
      return { ...x, sets };
    });
    const edited = exercises.some((x, i) => x !== b.exercises[i]);
    changed ||= edited;
    if (exercises.length <= maxEx) {
      out.push({ block: edited ? { ...b, exercises } : b, overflow: false });
      continue;
    }
    changed = true;
    const rank = exercises.map((_, i) => i).sort((i, j) => Number(hasLogged(exercises[j]!)) - Number(hasLogged(exercises[i]!)) || i - j);
    const stays = new Set(rank.slice(0, maxEx));
    out.push({ block: { ...b, exercises: exercises.filter((_, i) => stays.has(i)) }, overflow: false });
    const extra = exercises.filter((_, i) => !stays.has(i));
    for (let i = 0; i < extra.length; i += maxEx)
      out.push({ block: { id: derivedBlockId(b.id, taken), kind: "accessory", exercises: extra.slice(i, i + maxEx) }, overflow: true });
  }
  const notices: string[] = [];
  if (lostSets) notices.push(leftOut(lostSets, "set", `an exercise holds at most ${maxSets} sets`));
  if (out.length > maxBlocks) {
    changed = true;
    let lostEx = 0;
    let lostBlocks = 0;
    for (const overflow of [true, false])
      for (let i = out.length - 1; i >= 0 && out.length > maxBlocks; i--) {
        const o = out[i]!;
        if ((overflow && !o.overflow) || doneSets(o.block)) continue;
        if (o.overflow) lostEx += o.block.exercises.length;
        else lostBlocks++;
        out.splice(i, 1);
      }
    const why = `a workout holds at most ${maxBlocks} blocks`;
    if (lostEx) notices.push(leftOut(lostEx, "exercise", why));
    if (lostBlocks) notices.push(leftOut(lostBlocks, "block", why));
    if (out.length > maxBlocks) error ??= `The merged workout has more than ${maxBlocks} blocks with logged sets.`;
  }
  return { doc: changed ? { ...doc, blocks: out.map((o) => o.block) } : doc, error, notices };
}
