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

/**
 * Field-level merge: plain objects merge key by key (recursively); any other value (arrays
 * included) is taken whole from `local` when this device changed it, else from `server`.
 */
export function mergeFields<T>(ancestor: T | null | undefined, local: T, server: T): T {
  if (isPlainObject(local) && isPlainObject(server) && (ancestor == null || isPlainObject(ancestor))) {
    const anc = (ancestor ?? null) as Record<string, unknown> | null;
    const out: Record<string, unknown> = { ...server };
    for (const k of new Set([...Object.keys(local), ...Object.keys(server), ...(anc ? Object.keys(anc) : [])])) {
      const a = anc ? anc[k] : undefined;
      const l = local[k];
      const s = server[k];
      if (anc && deepEqual(l, a)) continue; // untouched here: the server's value stands
      if (!anc) {
        // Nothing to compare with: keep what the server has unless this device has a value.
        if (l !== undefined) out[k] = l;
        continue;
      }
      const v = isPlainObject(l) && isPlainObject(s) && isPlainObject(a) ? mergeFields(a, l, s) : l;
      if (v === undefined) delete out[k];
      else out[k] = v;
    }
    return out as T;
  }
  if (ancestor !== undefined && ancestor !== null && deepEqual(local, ancestor)) return server;
  return local;
}

/** Settings: the keys this device changed (at any depth) on top of the server's copy. */
export function mergeSettings(ancestor: Settings | null | undefined, local: Settings, server: Settings): Settings {
  return mergeFields(ancestor, local, server);
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/**
 * Pairs up the items of two lists: by key first, then (for items the ancestor doesn't know, i.e.
 * built independently on each device) by `fallback` in order. Returns, for each `local` index, the
 * `server` index it pairs with (or -1).
 */
function align<T>(
  local: readonly T[],
  server: readonly T[],
  key: (x: T, i: number) => string,
  fallback: (x: T) => string,
  known: Set<string>,
) {
  const pairs = local.map(() => -1);
  const used = new Set<number>();
  const byKey = new Map<string, number>();
  server.forEach((x, i) => byKey.set(key(x, i), i));
  local.forEach((x, i) => {
    const j = byKey.get(key(x, i));
    if (j !== undefined && !used.has(j)) {
      pairs[i] = j;
      used.add(j);
    }
  });
  local.forEach((x, i) => {
    if (pairs[i] !== -1 || known.has(key(x, i))) return;
    const j = server.findIndex((y, n) => !used.has(n) && !known.has(key(y, n)) && fallback(y) === fallback(x));
    if (j >= 0) {
      pairs[i] = j;
      used.add(j);
    }
  });
  return pairs;
}

/**
 * The merged list: local items (merged with their server counterpart) in local order, plus the
 * server items worth keeping, each placed after the server item that precedes it.
 */
function mergeList<T>(
  ancestor: readonly T[] | null,
  local: readonly T[],
  server: readonly T[],
  key: (x: T, i: number) => string,
  fallback: (x: T) => string,
  mergeItem: (a: T | undefined, l: T, s: T) => T,
): T[] {
  const anc = new Map<string, T>();
  ancestor?.forEach((x, i) => anc.set(key(x, i), x));
  const known = new Set(anc.keys());
  const pairs = align(local, server, key, fallback, known);
  const paired = new Set(pairs.filter((j) => j >= 0));

  const out: Array<{ item: T; serverIndex: number }> = [];
  local.forEach((l, i) => {
    const j = pairs[i]!;
    const a = anc.get(key(l, i));
    if (j >= 0) out.push({ item: mergeItem(a, l, server[j]!), serverIndex: j });
    else if (!a || !deepEqual(a, l)) out.push({ item: l, serverIndex: -1 }); // added here, or changed here after the server dropped it
    // else: unchanged here and removed on the server → stays removed
  });
  server.forEach((s, j) => {
    if (paired.has(j)) return;
    const a = anc.get(key(s, j));
    if (a && deepEqual(a, s)) return; // removed here, untouched on the server → stays removed
    // Added on the server (or changed there after this device removed it): keep it, after the
    // nearest earlier server item that made it into the result.
    let at = 0;
    for (let n = j - 1; n >= 0; n--) {
      const k = out.findIndex((o) => o.serverIndex === n);
      if (k >= 0) {
        at = k + 1;
        break;
      }
    }
    out.splice(at, 0, { item: s, serverIndex: j });
  });
  return out.map((o) => o.item);
}

/** A set logged or edited on this device wins; with no common ancestor, a logged set beats an unlogged one. */
function mergeSet(a: SetEntry | undefined, l: SetEntry, s: SetEntry): SetEntry {
  if (a) return deepEqual(l, a) ? s : l;
  if (s.done && !l.done) return { ...s, id: l.id };
  return l;
}

const exKey = (x: BlockExercise, i: number) => `${i}:${x.exerciseId}`;

function mergeExercise(a: BlockExercise | undefined, l: BlockExercise, s: BlockExercise): BlockExercise {
  const { sets: _a, ...aRest } = a ?? ({} as Partial<BlockExercise>);
  const { sets: _l, ...lRest } = l;
  const { sets: _s, ...sRest } = s;
  const head = mergeFields(a ? aRest : null, lRest, sRest);
  const sets = mergeList(
    a?.sets ?? null,
    l.sets,
    s.sets,
    (x) => x.id,
    () => "set", // independently built: pair sets in order
    mergeSet,
  );
  return { ...head, sets } as BlockExercise;
}

const blockFallback = (b: Block) => (b.kind === "primary" ? "primary" : `accessory:${b.exercises.map((e) => e.exerciseId).join(",")}`);

function mergeBlock(a: Block | undefined, l: Block, s: Block): Block {
  const { exercises: _a, ...aRest } = a ?? ({} as Partial<Block>);
  const { exercises: _l, ...lRest } = l;
  const { exercises: _s, ...sRest } = s;
  const head = mergeFields(a ? aRest : null, lRest, sRest);
  const exercises = mergeList(a?.exercises ?? null, l.exercises, s.exercises, exKey, (x) => String(x.exerciseId), mergeExercise);
  return { ...head, id: l.id, exercises } as Block;
}

/**
 * A workout saved on two devices: blocks matched by id (independently built sessions: the main
 * lift with the main lift, accessory blocks by their exercises), exercises by position and lift,
 * sets by id (else in order). A set logged or edited here wins; sets and blocks only the server
 * has are kept (unless this device removed them and the server didn't touch them); every other
 * field merges like settings. Ids of matched items are this device's (what its screen holds).
 */
export function mergeSession(ancestor: Session | null | undefined, local: Session, server: Session): Session {
  const { blocks: _a, ...aRest } = ancestor ?? ({} as Partial<Session>);
  const { blocks: _l, ...lRest } = local;
  const { blocks: _s, ...sRest } = server;
  let head = mergeFields(ancestor ? aRest : null, lRest, sRest) as Omit<Session, "blocks">;
  if (!ancestor) {
    // Built on both devices: a finish or notes from either side survive.
    head = { ...head, completedAt: local.completedAt ?? server.completedAt, notes: local.notes || server.notes };
  }
  const blocks = mergeList(ancestor?.blocks ?? null, local.blocks, server.blocks, (b) => b.id, blockFallback, mergeBlock);
  return { ...head, date: local.date, blocks } as Session;
}
