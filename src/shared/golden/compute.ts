/**
 * The golden check of chunk 2 (sections, skips and rehab): what every legacy session — one without
 * rehab or Core — reads as. This module only calls functions that already existed before (commit
 * b60f4e3), so the very same file computes the expected answers on the old code (`generate.ts`)
 * and the actual ones on the new code (`golden.test.ts`).
 *
 * Two kinds of cases:
 * - **recorded**: the arguments of every top-level call the existing test suites (node and web,
 *   but perf.test.ts) made into session / gamify / insights / swap / sessionStructure(Undo),
 *   captured on the old code (`inputs.json.gz`, a content-addressed pool), replayed;
 * - **random**: seeded random worlds (settings, exercises incl. core-category ones, maxes, day logs
 *   and sessions without rehab or Core), every reading computed over them (stored as hashes).
 *
 * The one intended change for legacy data is pre-fill's Core rule (SPEC §6.5), and only where the
 * new Train asks for it (`{ core: true }`, flag `trainDay`): `legacyCore` is that rule as a pure
 * transform, applied to the *old* output only, so the new code has to produce it by itself. Without
 * the option (every Train with the flag off), pre-fill must give exactly the old output: the
 * `…FlagOff` cases compare it with the old answer untouched.
 */
import { createHash } from "node:crypto";
import { addDays, type ISODate } from "../dates";
import { defaultSettings } from "../defaults";
import { emptyDayLog } from "../empty";
import * as gamify from "../gamify";
import * as insights from "../insights";
import type { Block, DayLog, Exercise, MaxEntry, Session, SetEntry, Settings } from "../schemas";
import * as session from "../session";
import * as structure from "../sessionStructure";
import * as structureUndo from "../sessionStructureUndo";
import * as swap from "../swap";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Fn = (...a: any[]) => unknown;

/** The functions replayed, by name (all of them existed before chunk 2). */
export const FNS: Record<string, Fn> = {
  buildSession: session.buildSession,
  buildSessionFrom: session.buildSessionFrom,
  buildSessionFlagOff: session.buildSession,
  buildSessionFromFlagOff: session.buildSessionFrom,
  templateSource: session.templateSource,
  setsForAddedExercise: session.setsForAddedExercise,
  mainLiftBlock: session.mainLiftBlock,
  planSignature: session.planSignature,
  planChanged: session.planChanged,
  planMatches: session.planMatches,
  sessionCounts: session.sessionCounts,
  blockCounts: session.blockCounts,
  sessionVolume: session.sessionVolume,
  isSessionStarted: session.isSessionStarted,
  accessoryHint: session.accessoryHint,
  effectiveSession: session.effectiveSession,
  mainLiftSwap: session.mainLiftSwap,
  mainLiftAdded: session.mainLiftAdded,
  sessionDoneEarly: session.sessionDoneEarly,
  nextSession: session.nextSession,
  checklist: gamify.checklist,
  dayChecklist: gamify.dayChecklist,
  closedDates: gamify.closedDates,
  streaks: gamify.streaks,
  achievements: gamify.achievements,
  amrapPrs: gamify.amrapPrs,
  buildModel: insights.buildModel,
  weeklyCheckin: insights.weeklyCheckin,
  swapMainLift: swap.swapMainLift,
  removeMainLift: swap.removeMainLift,
  undoSwap: swap.undoSwap,
  swapChoices: swap.swapChoices,
  swapSuggestion: swap.swapSuggestion,
  swapBlocked: swap.swapBlocked,
  addBlocked: swap.addBlocked,
  supersetLetters: structure.supersetLetters,
  moveExerciseToBlock: structure.moveExerciseToBlock,
  reorderInBlock: structure.reorderInBlock,
  moveBlock: structure.moveBlock,
  splitOut: structure.splitOut,
  normalizeMainLift: structure.normalizeMainLift,
  movableInto: structure.movableInto,
  locateExercise: structure.locateExercise,
  addStandings: structureUndo.addStandings,
  rejoinSuperset: structureUndo.rejoinSuperset,
};

/**
 * Calls whose output is a pre-filled session for the new Train: the Core rule applies to the old
 * output, and the new code is asked for it (`{ core: true }`).
 */
export const PREFILL = new Set(["buildSession", "buildSessionFrom"]);
/** The same pre-fills without the option (the flag off): the old output as it was. */
export const PREFILL_OFF: Record<string, string> = { buildSession: "buildSessionFlagOff", buildSessionFrom: "buildSessionFromFlagOff" };

/** The arguments of a new-side pre-fill call with the new Train's option. */
function withCore(fn: string, args: unknown[]): unknown[] {
  return fn === "buildSession" ? [args[0], args[1], { core: true }] : [args[0], args[1], args[2], args[3] ?? null, { core: true }];
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface Pack {
  pool: unknown[];
  calls: Array<[string, number]>;
}

/** A recorded call's arguments as fresh objects (a pooled object used twice in one call is one object, as it most likely was). */
export function argsOf(pack: Pack, ref: number, made = new Map<number, unknown>()): unknown[] {
  const build = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v;
    if (!Array.isArray(v) && "$r" in v) {
      const i = (v as { $r: number }).$r;
      if (!made.has(i)) made.set(i, build(pack.pool[i]));
      return made.get(i);
    }
    return Array.isArray(v) ? v.map(build) : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, build(x)]));
  };
  return build({ $r: ref }) as unknown[];
}

/** Every distinct session the recorded calls were given (each pooled once). */
export function recordedSessions(pack: Pack): Session[] {
  const made = new Map<number, unknown>();
  const out: Session[] = [];
  pack.pool.forEach((v, i) => {
    if (v && typeof v === "object" && !Array.isArray(v) && "blocks" in v && "date" in v)
      out.push(argsOf(pack, i, made) as unknown as Session);
  });
  return out;
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

function ids(v: unknown, out = new Set<string>()): Set<string> {
  if (v && typeof v === "object")
    for (const [k, x] of Object.entries(v)) {
      if (k === "id" && typeof x === "string") out.add(x);
      else ids(x, out);
    }
  return out;
}

/**
 * Fields added to an output after the golden answers were computed, by later work with tests of its own (the weekly
 * check-in's Zone 2 activities, SPEC §3.5): left out of the comparison — the old code has nothing to say of them.
 */
const LATER_FIELDS = new Set(["zone2Activities"]);

/**
 * An output as plain data: Maps and Sets spelled out, `undefined` kept apart from absent, and the
 * ids an output made up (fresh `newId`s) renamed in order of appearance — ids it took from its
 * inputs stay as they are. `LATER_FIELDS` are left out.
 */
export function normalize(out: unknown, args: unknown[]): unknown {
  const known = ids(args);
  const fresh = new Map<string, string>();
  const walk = (v: unknown, key?: string): unknown => {
    if (v === undefined) return "$undefined";
    if (typeof v === "function") return "$fn";
    if (typeof v === "string" && key === "id" && !known.has(v)) {
      if (!fresh.has(v)) fresh.set(v, `~${fresh.size + 1}`);
      return fresh.get(v);
    }
    if (v instanceof Map) return { $map: [...v].map(([k, x]) => [walk(k), walk(x)]) };
    if (v instanceof Set) return { $set: [...v].map((x) => walk(x)).sort() };
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.entries(v)
          .filter(([k]) => !LATER_FIELDS.has(k))
          .map(([k, x]) => [k, walk(x, k)]),
      );
    return v;
  };
  // Whether a structure edit handed back its input unchanged (the same object) is part of its contract.
  const same = args.findIndex((a) => a !== null && typeof a === "object" && a === out);
  return { out: walk(out), same };
}

/**
 * Pre-fill's Core rule (SPEC §6.5) as a transform of a pre-filled session from before it: an
 * accessory block made only of core-category exercises (the template was saved before
 * subsections existed) is filed under Core (`section: "core"`) and stored after the others.
 */
export function legacyCore(s: unknown, exercises: ReadonlyArray<Pick<Exercise, "id" | "category">>): unknown {
  if (!s || typeof s !== "object" || !Array.isArray((s as Session).blocks)) return s;
  const blocks = (s as Session).blocks;
  const isCore = (b: Block) =>
    b.kind === "accessory" && b.exercises.every((e) => exercises.find((x) => x.id === e.exerciseId)?.category === "core");
  const keep = blocks.filter((b) => !isCore(b));
  const core = blocks.filter(isCore).map((b) => ({ ...b, section: "core" as const }));
  return { ...(s as Session), blocks: [...keep, ...core] };
}

/** The exercises a pre-fill call was given (its context). */
function exercisesOf(fn: string, args: unknown[]): Exercise[] {
  const ctx = (fn.startsWith("buildSessionFrom") ? args[2] : args[1]) as { exercises?: Exercise[] } | undefined;
  return ctx?.exercises ?? [];
}

/** One call's normalized output. `old`: the expected side, where the Core rule is applied to pre-fill. */
export function run(fn: string, args: unknown[], side: "old" | "new"): unknown {
  let out: unknown;
  try {
    out = FNS[fn]!(...(side === "new" && PREFILL.has(fn) ? withCore(fn, args) : args));
  } catch (e) {
    return { threw: String(e) };
  }
  if (side === "old" && PREFILL.has(fn)) out = legacyCore(out, exercisesOf(fn, args));
  return normalize(out, args);
}

export const hash = (v: unknown): string => createHash("sha1").update(JSON.stringify(v)).digest("hex").slice(0, 16);

/**
 * Train's "Recalculate" before chunk 2 (Train.tsx `recalcPrimary`, written out with the shared
 * functions it used): `swap.recalculateMainLift` must give the same.
 */
export function recalcBefore(s: Session, ctx: session.BuildContext): Session {
  const plannedFor = s.plannedFor ?? null;
  const planFresh = plannedFor ? session.buildSessionFrom(plannedFor, s.date, ctx) : session.buildSession(s.date, ctx);
  const freshPrimary = planFresh.blocks.find((b) => b.kind === "primary");
  const unplanned = session.mainLiftSwap(s)?.to ?? session.mainLiftAdded(s, ctx);
  const swapPlan =
    unplanned !== null && freshPrimary?.exercises[0]?.exerciseId !== unplanned
      ? session.mainLiftBlock(plannedFor ?? s.date, ctx, unplanned)
      : null;
  const planPrimary = swapPlan?.block ?? freshPrimary;
  const primarySkipped = !!s.blocks.find((b) => b.kind === "primary")?.skipped;
  const nextPrimary = planPrimary && (primarySkipped ? { ...planPrimary, skipped: true } : planPrimary);
  return {
    ...s,
    label: planFresh.label,
    cycle: planFresh.cycle,
    week: planFresh.week,
    deload: planFresh.deload,
    primaryMaxLb: swapPlan?.primaryMaxLb ?? planFresh.primaryMaxLb ?? s.primaryMaxLb,
    planSig: planFresh.planSig,
    blocks: [...(nextPrimary ? [nextPrimary] : []), ...s.blocks.filter((b) => b.kind !== "primary")],
  };
}

// ---------------------------------------------------------------------------
// Random worlds (no rehab, no Core)
// ---------------------------------------------------------------------------

/** mulberry32: a small seeded PRNG. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    chance: (p: number) => next() < p,
    pick: <T>(xs: ReadonlyArray<T>): T => xs[Math.floor(next() * xs.length)]!,
  };
}
type Rng = ReturnType<typeof rng>;

export const WORLD_START = "2026-10-05"; // a Monday
const LIFTS = { bench: 1, deadlift: 2, backSquat: 3, frontSquat: 4, strictPress: 5 };

function worldExercises(r: Rng): Exercise[] {
  const lift = (id: number, name: string): Exercise => ({
    id,
    name,
    category: "primary",
    tracksMax: true,
    measure: "reps",
    weighted: true,
    archived: false,
  });
  const acc: Exercise[] = [
    { id: 10, name: "Dumbbell row", category: "accessory", tracksMax: false, measure: "reps", weighted: true, archived: false },
    { id: 11, name: "Lateral raise", category: "accessory", tracksMax: false, measure: "reps", weighted: r.chance(0.8), archived: false },
    { id: 12, name: "Hanging knee raise", category: "core", tracksMax: false, measure: "reps", weighted: false, archived: false },
    {
      id: 13,
      name: "Weighted plank",
      category: "core",
      tracksMax: false,
      measure: r.pick(["seconds", "reps"] as const),
      weighted: true,
      archived: false,
    },
    { id: 14, name: "Farmer's carry", category: "carry", tracksMax: false, measure: "meters", weighted: true, archived: false },
    { id: 15, name: "Pull-up", category: "accessory", tracksMax: false, measure: "reps", weighted: r.chance(0.3), archived: false },
    {
      id: 16,
      name: "Bike sprint",
      category: "conditioning",
      tracksMax: false,
      measure: "seconds",
      weighted: false,
      archived: r.chance(0.3),
    },
    { id: 17, name: "Hollow hold", category: "core", tracksMax: false, measure: "seconds", weighted: r.chance(0.5), archived: false },
  ];
  return [lift(1, "Bench press"), lift(2, "Deadlift"), lift(3, "Back squat"), lift(4, "Front squat"), lift(5, "Strict press"), ...acc];
}

let setSeq = 0;
function set(r: Rng, done: boolean, amrap = false, measureHint: "reps" | "seconds" | "meters" = "reps"): SetEntry {
  const target = measureHint === "reps" ? r.pick([5, 6, 8, 10, 12]) : measureHint === "seconds" ? r.pick([20, 30, 45]) : r.pick([20, 40]);
  const tw = r.chance(0.8) ? r.pick([0, 15, 25, 35.5, 50, 95, 135, 185]) : null;
  return {
    id: `s${++setSeq}`,
    targetReps: r.chance(0.9) ? target : null,
    targetWeight: tw,
    reps: done ? (r.chance(0.8) ? target + r.int(-2, 4) : null) : r.chance(0.1) ? target : null,
    weight: done ? (r.chance(0.85) ? (tw ?? r.pick([20, 40])) + r.pick([0, 0, 5, -5]) : null) : null,
    done,
    amrap,
    appliedProgressionLb: amrap && done && r.chance(0.3) ? r.int(1, 4) : null,
  };
}

function randomSession(r: Rng, date: ISODate, exercises: Exercise[], settings: Settings): Session {
  const wd = new Date(`${date}T12:00:00Z`).getUTCDay();
  const day = settings.program.days[String(wd)];
  const started = r.next();
  const doneP = started < 0.25 ? 0 : started < 0.5 ? 1 : r.next();
  const blocks: Block[] = [];
  if ((day?.primaryExerciseId != null && r.chance(0.9)) || r.chance(0.1)) {
    const lift = r.chance(0.85) && day?.primaryExerciseId != null ? day.primaryExerciseId : r.int(1, 5);
    const n = r.int(3, 5);
    const b: Block = {
      id: `b${++setSeq}`,
      kind: "primary",
      exercises: [
        {
          exerciseId: lift,
          measure: "reps",
          sets: Array.from({ length: n }, (_, i) => set(r, r.chance(doneP), i === n - 1 && r.chance(0.7))),
        },
      ],
    };
    if (r.chance(0.12)) b.skipped = true;
    if (r.chance(0.05)) b.exercises.push({ exerciseId: r.int(10, 17), measure: "reps", sets: [set(r, r.chance(doneP))] });
    blocks.push(b);
  }
  const accIds = exercises.filter((e) => e.category !== "primary").map((e) => e.id);
  const nBlocks = r.chance(0.15) ? 0 : r.int(1, 5);
  for (let i = 0; i < nBlocks; i++) {
    const members = r.chance(0.3) ? r.int(2, 3) : 1;
    const ex = Array.from({ length: members }, () => {
      const id = r.chance(0.05) ? 99 : r.pick(accIds);
      const known = exercises.find((e) => e.id === id);
      const measure = r.chance(0.85) ? (known?.measure ?? "reps") : r.pick(["reps", "seconds", "meters"] as const);
      const e = {
        exerciseId: id,
        measure,
        sets: Array.from({ length: r.int(1, 4) }, () => set(r, r.chance(doneP), false, measure)),
      } as Block["exercises"][number];
      if (r.chance(0.12)) e.skipped = true;
      return e;
    });
    blocks.push({ id: `b${++setSeq}`, kind: "accessory", exercises: ex });
  }
  const week = r.int(1, 5);
  const s: Session = {
    date,
    label: day?.label ?? (r.chance(0.5) ? "Extra session" : "Training"),
    cycle: r.chance(0.9) ? 1 : null,
    week: r.chance(0.9) ? week : null,
    deload: week === 5,
    primaryMaxLb: blocks[0]?.kind === "primary" ? r.pick([200, 225, 315, 405]) : null,
    blocks,
    notes: r.chance(0.2) ? "felt good" : "",
    completedAt: r.chance(doneP > 0.6 ? 0.8 : 0.2) ? `${date}T18:00:00Z` : null,
  };
  const sig = r.next();
  if (sig < 0.3) s.planSig = null;
  else if (sig < 0.85) {
    const lift = blocks[0]?.kind === "primary" ? (r.chance(0.8) ? blocks[0].exercises[0]!.exerciseId : r.int(1, 5)) : r.int(1, 5);
    s.planSig = JSON.stringify({ exerciseId: lift, week: week - 1, deload: week === 5, sets: [[6, 200, false]] });
  }
  if (r.chance(0.1)) s.plannedFor = addDays(date, r.int(-2, 3));
  else if (r.chance(0.05)) s.plannedFor = null;
  return s;
}

function randomDay(r: Rng, date: ISODate): DayLog {
  const d = emptyDayLog(date);
  if (r.chance(0.8)) d.weightLb = 180 + r.int(-30, 30) / 10;
  if (r.chance(0.8)) d.calories = r.int(1800, 3200);
  if (r.chance(0.6)) d.proteinG = r.int(120, 220);
  if (r.chance(0.7)) d.steps = r.int(4000, 20000);
  if (r.chance(0.5)) d.sleepMinutes = r.int(300, 540);
  d.zone2Done = r.chance(0.5);
  if (r.chance(0.4)) d.zone2Minutes = r.pick([20, 30, 45]);
  if (r.chance(0.2)) d.zone2Kcal = r.int(150, 450);
  d.metconDone = r.chance(0.5);
  if (r.chance(0.2)) {
    d.metconBenchmark = r.pick(["Fran", "Cindy", "Grace"]);
    d.metconScore = r.pick(["4:12", "3:58", "20 rounds", "5:01"]);
  }
  return d;
}

export interface World {
  settings: Settings;
  exercises: Exercise[];
  maxEntries: MaxEntry[];
  sessions: Session[];
  days: DayLog[];
}

export function randomWorld(seed: number): World {
  const r = rng(seed);
  setSeq = seed * 100_000;
  const settings: Settings = { ...defaultSettings(LIFTS, "2026-10-01"), onboarded: true };
  settings.program = { ...settings.program, cycleStartDate: WORLD_START, deloadAccessoryLoad: r.pick([0.8, 0.7, 1]) };
  if (r.chance(0.3))
    settings.program = {
      ...settings.program,
      days: { ...settings.program.days, "6": { label: "Pull", primaryExerciseId: 2, progression: false } },
    };
  const exercises = worldExercises(r);
  const maxEntries: MaxEntry[] = [1, 2, 3, 5]
    .filter(() => r.chance(0.9))
    .map((exerciseId, i) => ({
      id: i + 1,
      exerciseId,
      date: "2026-10-01",
      valueLb: r.pick([185, 225, 315, 405]),
      source: "initial",
      note: null,
      createdAt: `2026-10-01T0${i}:00:00Z`,
    }));
  let mid = 100;
  for (let w = 1; w <= 6; w++)
    if (r.chance(0.5))
      maxEntries.push({
        id: mid++,
        exerciseId: r.pick([1, 2, 3, 5]),
        date: addDays(WORLD_START, w * 7),
        valueLb: r.pick([190, 230, 320, 410]),
        source: r.pick(["amrap", "manual"] as const),
        note: null,
        createdAt: `${addDays(WORLD_START, w * 7)}T10:00:00Z`,
      });
  const sessions: Session[] = [];
  const days: DayLog[] = [];
  for (let i = -3; i < 56; i++) {
    const date = addDays(WORLD_START, i);
    if (r.chance(0.6)) sessions.push(randomSession(r, date, exercises, settings));
    if (r.chance(0.85)) days.push(randomDay(r, date));
  }
  return { settings, exercises, maxEntries, sessions, days };
}

/**
 * Every reading of a random world, as named cases: per session (counts, volume, structure, the
 * plan-changed check, swap, Recalculate), per day (pre-fill, added exercises, hints, checklist,
 * swap suggestion, next session) and the whole (closed days, streaks, achievements, AMRAP PRs,
 * the weekly check-in and insights).
 */
export function worldCases(seed: number, side: "old" | "new"): Array<{ name: string; out: unknown }> {
  const w = randomWorld(seed);
  const r = rng(seed ^ 0x5eed);
  const ctx = { settings: w.settings, exercises: w.exercises, maxEntries: w.maxEntries, sessions: w.sessions };
  const data = { ...ctx, days: w.days };
  const out: Array<{ name: string; out: unknown }> = [];
  const call = (name: string, fn: string, ...args: unknown[]) => out.push({ name: `${seed}/${name}/${fn}`, out: run(fn, args, side) });
  const derived = (name: string, v: () => unknown, args: unknown[]) => {
    let res: unknown;
    try {
      res = v();
    } catch (e) {
      res = { threw: String(e) };
    }
    out.push({ name: `${seed}/${name}`, out: normalize(res, args) });
  };
  const end = addDays(WORLD_START, 60);

  for (const s of w.sessions) {
    const at = s.date;
    call(at, "sessionCounts", s);
    call(at, "sessionVolume", s);
    call(at, "isSessionStarted", s);
    derived(`${at}/allLogged`, () => session.allLogged(session.sessionCounts(s)), [s]);
    s.blocks.forEach((b, i) => {
      call(`${at}#${i}`, "blockCounts", b);
      derived(`${at}#${i}/blockComplete`, () => session.blockComplete(b), [b]);
      call(`${at}#${i}`, "movableInto", s, b.id);
      call(`${at}#${i}`, "moveBlock", s, b.id, r.int(-1, 5));
      call(`${at}#${i}`, "reorderInBlock", s, b.id, r.int(0, 2), r.int(0, 3));
      call(`${at}#${i}`, "splitOut", s, { blockId: b.id, exIdx: r.int(0, 2) }, `split-${i}`);
      const to = s.blocks[r.int(0, s.blocks.length - 1)]!;
      call(`${at}#${i}`, "moveExerciseToBlock", s, { blockId: b.id, exIdx: r.int(0, 2) }, to.id, r.chance(0.5) ? r.int(0, 3) : undefined);
      call(`${at}#${i}`, "addStandings", s, b.id);
      const ex = b.exercises[0]!;
      call(`${at}#${i}`, "locateExercise", s, { ...ex });
      call(`${at}#${i}`, "rejoinSuperset", s, { blockId: to.id, exIdx: r.int(0, 2) }, b.id, ex.exerciseId, [ex]);
    });
    call(at, "effectiveSession", s, w.exercises);
    call(at, "supersetLetters", s);
    call(at, "normalizeMainLift", s);
    call(at, "mainLiftSwap", s);
    call(at, "mainLiftAdded", s, ctx);
    call(at, "planChanged", s, ctx);
    call(at, "planMatches", s, ctx);
    call(at, "swapBlocked", s);
    call(at, "addBlocked", s, ctx);
    const lift = r.int(1, 5);
    call(`${at}/${lift}`, "swapMainLift", s, lift, ctx);
    call(at, "removeMainLift", s, ctx);
    call(at, "swapChoices", s, ctx);
    const swapped = swap.swapMainLift(s, lift, ctx);
    if ("session" in swapped) call(`${at}/${lift}`, "undoSwap", swapped.session, swapped.session, s);
    // New: `swap.recalculateMainLift` (looked up by name: this module also runs on the code before it).
    const recalc = side === "new" ? ((swap as unknown as Record<string, Fn>).recalculateMainLift as typeof recalcBefore) : recalcBefore;
    derived(`${at}/recalculate`, () => recalc(s, ctx), [s, ctx]);
  }
  for (let i = -3; i < 63; i++) {
    const d = addDays(WORLD_START, i);
    call(d, "buildSession", d, ctx);
    call(d, "buildSessionFlagOff", d, ctx);
    const target = addDays(d, -r.int(0, 2));
    call(d, "buildSessionFrom", d, target, ctx);
    call(d, "buildSessionFromFlagOff", d, target, ctx);
    derived(`${d}/templateSource`, () => session.templateSource(d, ctx)?.date ?? null, []);
    call(d, "mainLiftBlock", d, ctx);
    call(d, "planSignature", d, ctx);
    call(d, "sessionDoneEarly", d, w.sessions);
    call(d, "nextSession", d, ctx);
    call(d, "swapSuggestion", d, ctx);
    call(d, "dayChecklist", d, data);
    const ex = w.exercises[r.int(5, w.exercises.length - 1)]!;
    call(
      `${d}/${ex.id}`,
      "setsForAddedExercise",
      ex,
      { date: d, plannedFor: r.chance(0.2) ? addDays(d, 1) : null, deload: r.chance(0.2) },
      ctx,
    );
    call(`${d}/${ex.id}`, "accessoryHint", ex.id, d, w.sessions, r.pick([0, 5, 2.5]), {
      weighted: session.isWeighted(ex),
      measure: r.chance(0.8) ? ex.measure : undefined,
    });
  }
  call("all", "closedDates", data, end);
  call("all", "streaks", data, end);
  call("all", "achievements", data, end);
  call("all", "amrapPrs", w.sessions);
  derived(
    "all/buildModel",
    () => {
      const m = insights.buildModel(data, end);
      return { checkin: m.checkin, insights: m.insights, targets: m.targets };
    },
    [data],
  );
  return out;
}

/** How many random worlds the golden check covers. */
export const WORLDS = 24;
