import { describe, expect, it } from "vitest";
import { defaultSettings } from "./defaults";
import { amrapPrs, checklist } from "./gamify";
import { currentMax, mainLiftSets, cyclePosition } from "./program";
import { sessionSchema, type Exercise, type MaxEntry, type Session } from "./schemas";
import { buildSession, buildSessionFrom, mainLiftSwap, planChanged, plannedLiftOf, planSignature, templateSource } from "./session";
import { swapBlocked, swapChoices, swapMainLift, swapSuggestion, undoSwap } from "./swap";

const ids = { bench: 1, deadlift: 2, backSquat: 3, frontSquat: 4, strictPress: 5 };
// The program starts Monday 2026-11-02 (week 1: 6/8/10/12, AMRAP last).
const settings = { ...defaultSettings(ids, "2026-11-01"), onboarded: true };
const exercises: Exercise[] = [
  { id: 1, name: "Bench press", category: "primary", tracksMax: true, measure: "reps", weighted: true, archived: false },
  { id: 2, name: "Deadlift", category: "primary", tracksMax: true, measure: "reps", weighted: true, archived: false },
  { id: 3, name: "Back squat", category: "primary", tracksMax: true, measure: "reps", weighted: true, archived: false },
  { id: 4, name: "Front squat", category: "primary", tracksMax: true, measure: "reps", weighted: true, archived: false },
  { id: 5, name: "Strict press", category: "primary", tracksMax: true, measure: "reps", weighted: true, archived: false },
  { id: 10, name: "Barbell row", category: "accessory", tracksMax: false, measure: "reps", weighted: true, archived: false },
  { id: 11, name: "Lunge", category: "accessory", tracksMax: false, measure: "reps", weighted: true, archived: false },
];
const max = (id: number, exerciseId: number, valueLb: number, date = "2026-11-01"): MaxEntry => ({
  id,
  exerciseId,
  date,
  valueLb,
  source: "initial",
  note: null,
  createdAt: `${date}T00:00:00Z`,
});
// No max for front squat.
const maxEntries: MaxEntry[] = [max(1, 1, 225), max(2, 2, 405), max(3, 3, 315), max(5, 5, 135)];
const ctx = { settings, exercises, maxEntries, sessions: [] as Session[] };

const TUE = "2026-11-03";
const WED = "2026-11-04";
const NEXT_TUE = "2026-11-10";

const set = (id: string, reps: number, weight: number) => ({
  id,
  targetReps: reps,
  targetWeight: weight,
  reps,
  weight,
  done: true,
  amrap: false,
  appliedProgressionLb: null,
});
/** A finished Pull (Tue) and Legs (Wed) session the week before the program: what pre-fill carries. */
const priorPull: Session = {
  ...buildSession("2026-10-27", ctx),
  blocks: [
    { id: "row", kind: "accessory", exercises: [{ exerciseId: 10, measure: "reps", sets: [set("r1", 10, 135), set("r2", 10, 135)] }] },
  ],
  completedAt: "2026-10-27T18:00:00Z",
};
const priorLegs: Session = {
  ...buildSession("2026-10-28", ctx),
  blocks: [{ id: "lunge", kind: "accessory", exercises: [{ exerciseId: 11, measure: "reps", sets: [set("l1", 12, 50)] }] }],
  completedAt: "2026-10-28T18:00:00Z",
};
const history = { ...ctx, sessions: [priorPull, priorLegs] };

const main = (s: Session) => s.blocks.find((b) => b.kind === "primary")!;
const swapped = (s: Session, id: number) => {
  const r = swapMainLift(s, id, ctx);
  if (!("session" in r)) throw new Error(`refused: ${r.refused}`);
  return r.session;
};
/** Log every main-lift set at its target, the AMRAP with `amrapReps`. */
const logMain = (s: Session, amrapReps: number): Session => ({
  ...s,
  blocks: s.blocks.map((b) =>
    b.kind !== "primary"
      ? b
      : {
          ...b,
          exercises: b.exercises.map((e) => ({
            ...e,
            sets: e.sets.map((x) => ({ ...x, done: true, reps: x.amrap ? amrapReps : x.targetReps, weight: x.targetWeight })),
          })),
        },
  ),
  completedAt: `${s.date}T19:00:00Z`,
});

describe("swapping the main lift for one session", () => {
  const tue = buildSession(TUE, history);

  it("calculates the chosen lift from its own max with this week's scheme, the day's AMRAP and nothing else changed", () => {
    expect(tue.label).toBe("Pull");
    expect(main(tue).exercises[0]!.exerciseId).toBe(ids.deadlift);
    const s = swapped(tue, ids.backSquat);
    const sets = main(s).exercises[0]!.sets;
    const pos = cyclePosition(settings.program, TUE)!;
    const expected = mainLiftSets(settings.program, 315, pos.week, { progressionDay: true });
    expect(sets.map((x) => [x.targetReps, x.targetWeight, x.amrap])).toEqual(expected.map((p) => [p.reps, p.weightLb, p.amrap]));
    expect(main(s).exercises[0]!.exerciseId).toBe(ids.backSquat);
    expect(s.primaryMaxLb).toBe(315);
    // The day stays the day: label, week, deload, notes and Pull's accessories.
    expect([s.label, s.cycle, s.week, s.deload, s.notes]).toEqual([tue.label, tue.cycle, tue.week, tue.deload, tue.notes]);
    expect(s.blocks.filter((b) => b.kind === "accessory").map((b) => b.exercises[0]!.exerciseId)).toEqual([10]);
    expect(s.blocks.slice(1)).toEqual(tue.blocks.slice(1));
    // A new main block (fresh ids: another lift is another block); the plan signature stays the plan's.
    expect(main(s).id).not.toBe(main(tue).id);
    expect(s.planSig).toBe(tue.planSig);
    expect(mainLiftSwap(s)).toEqual({ from: ids.deadlift, to: ids.backSquat });
    expect(mainLiftSwap(tue)).toBeNull();
  });

  it("follows the day's AMRAP setting and the deload week", () => {
    const noAmrap = {
      ...settings,
      program: { ...settings.program, days: { ...settings.program.days, "2": { ...settings.program.days["2"]!, progression: false } } },
    };
    const c = { ...ctx, settings: noAmrap };
    const r = swapMainLift(buildSession(TUE, c), ids.backSquat, c);
    expect("session" in r && main(r.session).exercises[0]!.sets.some((x) => x.amrap)).toBe(false);
    // Week 5 is the deload: 4 × 10 at 90% of the 12-rep max, no AMRAP.
    const deloadTue = "2026-12-01";
    const d = swapped(buildSession(deloadTue, ctx), ids.backSquat);
    expect(d.deload).toBe(true);
    const pos = cyclePosition(settings.program, deloadTue)!;
    expect(main(d).exercises[0]!.sets.map((x) => x.targetWeight)).toEqual(
      mainLiftSets(settings.program, 315, pos.week, { progressionDay: true }).map((p) => p.weightLb),
    );
    expect(main(d).exercises[0]!.sets.some((x) => x.amrap)).toBe(false);
  });

  it("is refused once a main-lift set is logged, when skipped or finished, and for a lift without a max", () => {
    const logged = {
      ...tue,
      blocks: tue.blocks.map((b) =>
        b.kind === "primary"
          ? { ...b, exercises: [{ ...b.exercises[0]!, sets: b.exercises[0]!.sets.map((x, i) => (i === 0 ? { ...x, done: true } : x)) }] }
          : b,
      ),
    };
    expect(swapMainLift(logged, ids.backSquat, ctx)).toEqual({ refused: "logged" });
    expect(swapBlocked(logged)).toBe("logged");
    const skipped = { ...tue, blocks: tue.blocks.map((b) => (b.kind === "primary" ? { ...b, skipped: true } : b)) };
    expect(swapMainLift(skipped, ids.backSquat, ctx)).toEqual({ refused: "skipped" });
    expect(swapMainLift({ ...tue, completedAt: "x" }, ids.backSquat, ctx)).toEqual({ refused: "finished" });
    expect(swapMainLift(tue, ids.frontSquat, ctx)).toEqual({ refused: "no-max" });
    expect(swapMainLift(tue, 999, ctx)).toEqual({ refused: "unknown" });
    expect(swapMainLift(buildSession("2026-11-06", ctx), ids.backSquat, ctx)).toEqual({ refused: "no-main" });
  });

  it("goes back to the planned lift: the plan's own block and signature", () => {
    const s = swapped(swapped(tue, ids.backSquat), ids.deadlift);
    expect(mainLiftSwap(s)).toBeNull();
    const plan = main(tue).exercises[0]!.sets.map((x) => [x.targetReps, x.targetWeight, x.amrap]);
    expect(main(s).exercises[0]!.sets.map((x) => [x.targetReps, x.targetWeight, x.amrap])).toEqual(plan);
    expect(s.primaryMaxLb).toBe(405);
    expect(s.planSig).toBe(planSignature(TUE, ctx));
    expect(planChanged(s, ctx)).toBe(false);
  });

  it("undoes only its own fields on the session as it is, and declines once the swapped lift is logged", () => {
    const s = swapped(tue, ids.backSquat);
    // Another device wrote a note and logged an accessory set since.
    const later: Session = {
      ...s,
      notes: "gym closes at 2",
      blocks: s.blocks.map((b) =>
        b.kind === "accessory"
          ? { ...b, exercises: [{ ...b.exercises[0]!, sets: b.exercises[0]!.sets.map((x) => ({ ...x, done: true })) }] }
          : b,
      ),
    };
    const undone = undoSwap(later, s, tue);
    expect(typeof undone).toBe("object");
    const u = undone as Session;
    expect(main(u)).toBe(main(tue));
    expect(u.primaryMaxLb).toBe(tue.primaryMaxLb);
    expect(u.planSig).toBe(tue.planSig);
    expect(u.notes).toBe("gym closes at 2");
    expect(u.blocks.find((b) => b.kind === "accessory")!.exercises[0]!.sets.every((x) => x.done)).toBe(true);
    const squatLogged = logMain(s, 12);
    expect(undoSwap({ ...squatLogged, completedAt: null }, s, tue)).toBe("logged");
    expect(undoSwap(swapped(s, ids.bench), s, tue)).toBe("changed");
  });
});

describe("how a swapped session reads", () => {
  const tue = buildSession(TUE, history);
  const s = swapped(tue, ids.backSquat);

  it("is no plan change; a change of the plan's week still is; the planned lift's max isn't", () => {
    expect(planChanged(s, ctx)).toBe(false);
    // Deadlift's max moves: irrelevant to a squat session.
    expect(planChanged(s, { ...ctx, maxEntries: [...maxEntries, max(9, 2, 425, "2026-11-02")] })).toBe(false);
    // …but it is a plan change for the unswapped session.
    expect(planChanged(tue, { ...ctx, maxEntries: [...maxEntries, max(9, 2, 425, "2026-11-02")] })).toBe(true);
    // The week's reps change: flagged.
    const weeks = settings.program.weeks.map((w, i) => (i === 0 ? { ...w, reps: [5, 5, 5, 5] } : w));
    expect(planChanged(s, { ...ctx, settings: { ...settings, program: { ...settings.program, weeks } } })).toBe(true);
    // Tuesday's lift changes in the plan: flagged too (the day's plan is another one).
    const days = { ...settings.program.days, "2": { ...settings.program.days["2"]!, primaryExerciseId: ids.bench } };
    expect(planChanged(s, { ...ctx, settings: { ...settings, program: { ...settings.program, days } } })).toBe(true);
  });

  it("feeds the swapped lift's AMRAP history; the checklist's lift is done as usual", () => {
    // A squat AMRAP the week before at the same load, 12 reps: the baseline.
    const baseline: Session = logMain(
      {
        ...priorLegs,
        blocks: [
          {
            ...main(s),
            id: "m0",
            exercises: [{ ...main(s).exercises[0]!, sets: main(s).exercises[0]!.sets.map((x) => ({ ...x, id: `b${x.id}` })) }],
          },
        ],
      },
      12,
    );
    const done = logMain(s, 16);
    expect(amrapPrs([baseline, done]).map((p) => [p.exerciseId, p.date, p.reps, p.previousReps])).toEqual([[ids.backSquat, TUE, 16, 12]]);
    const items = checklist(TUE, undefined, done, settings);
    expect(items.find((i) => i.key === "lift")?.done).toBe(true);
  });

  it("next week's same day pre-fills the planned lift and Tuesday's accessories, not the swap", () => {
    const done = logMain(s, 12);
    const next = buildSession(NEXT_TUE, { ...history, sessions: [...history.sessions, done] });
    expect(next.label).toBe("Pull");
    expect(main(next).exercises[0]!.exerciseId).toBe(ids.deadlift);
    expect(next.blocks.filter((b) => b.kind === "accessory").map((b) => b.exercises.map((e) => e.exerciseId))).toEqual([[10]]);
    expect(templateSource(NEXT_TUE, { ...history, sessions: [...history.sessions, done] })).toBe(done);
    expect(mainLiftSwap(next)).toBeNull();
  });

  it("stores nothing new: it parses and round-trips as any session", () => {
    expect(sessionSchema.parse(s)).toEqual(s);
    expect(Object.keys(s).sort()).toEqual(Object.keys(tue).sort());
  });

  it("an old session (no signature) or one built before a lift had a max is never read as swapped", () => {
    const { planSig: _, ...old } = s;
    expect(sessionSchema.parse(old)).toEqual(old);
    expect(mainLiftSwap(old as Session)).toBeNull();
    expect(plannedLiftOf({ planSig: null })).toBeNull();
    expect(plannedLiftOf({ planSig: "not json" })).toBeNull();
    // Seeded / imported history with a null signature.
    expect(mainLiftSwap({ ...s, planSig: null })).toBeNull();
  });

  it("a moved session ('do this session today') swaps within its own program day", () => {
    const moved = buildSessionFrom(WED, TUE, ctx); // Wednesday's Legs done on Tuesday
    const r = swapped(moved, ids.deadlift);
    expect(r.plannedFor).toBe(WED);
    expect(r.label).toBe("Legs");
    expect(mainLiftSwap(r)).toEqual({ from: ids.backSquat, to: ids.deadlift });
    expect(planChanged(r, ctx)).toBe(false);
  });
});

describe("swapChoices", () => {
  const tue = buildSession(TUE, ctx);
  it("lists the program's other main lifts with their days first, then other max-tracked lifts", () => {
    const { back, choices } = swapChoices(tue, ctx);
    expect(back).toBeNull();
    expect(choices).toEqual([
      { exerciseId: ids.bench, days: [1], hasMax: true },
      { exerciseId: ids.backSquat, days: [3], hasMax: true },
      { exerciseId: ids.strictPress, days: [4], hasMax: true },
      { exerciseId: ids.frontSquat, days: [], hasMax: false },
    ]);
  });
  it("offers the planned lift back once swapped, and not the lift done now", () => {
    const { back, choices } = swapChoices(swapped(tue, ids.backSquat), ctx);
    expect(back).toBe(ids.deadlift);
    expect(choices.map((c) => c.exerciseId)).toEqual([ids.bench, ids.strictPress, ids.frontSquat]);
  });
  it("leaves archived lifts out", () => {
    const xs = exercises.map((e) => (e.id === ids.frontSquat ? { ...e, archived: true } : e));
    expect(swapChoices(tue, { ...ctx, exercises: xs }).choices.map((c) => c.exerciseId)).not.toContain(ids.frontSquat);
  });
});

describe("swapSuggestion (between days, derived)", () => {
  const tue = logMain(swapped(buildSession(TUE, history), ids.backSquat), 12);

  it("Wednesday: Back squat was done Tue → do Deadlift", () => {
    expect(swapSuggestion(WED, { ...history, sessions: [...history.sessions, tue] })).toEqual({
      done: ids.backSquat,
      doneOn: TUE,
      suggest: ids.deadlift,
    });
  });

  it("the suggested swap builds Wednesday's own day with Deadlift", () => {
    const c = { ...history, sessions: [...history.sessions, tue] };
    const wed = swapped(buildSession(WED, c), ids.deadlift);
    expect(wed.label).toBe("Legs");
    expect(main(wed).exercises[0]!.exerciseId).toBe(ids.deadlift);
    expect(wed.primaryMaxLb).toBe(405);
    expect(wed.blocks.filter((b) => b.kind === "accessory").map((b) => b.exercises[0]!.exerciseId)).toEqual([11]);
    expect(mainLiftSwap(wed)).toEqual({ from: ids.backSquat, to: ids.deadlift });
  });

  it("goes once Wednesday has a session, outside the cycle week, or once Deadlift is done this week", () => {
    const sessions = [...history.sessions, tue];
    expect(swapSuggestion(WED, { ...history, sessions: [...sessions, buildSession(WED, ctx)] })).toBeNull();
    expect(swapSuggestion("2026-11-11", { ...history, sessions })).toBeNull();
    const thuDeadlift = logMain(swapped(buildSession("2026-11-05", ctx), ids.deadlift), 12);
    expect(swapSuggestion("2026-11-06", { ...history, sessions: [...sessions, thuDeadlift] })).toBeNull(); // Fri: no main lift anyway
    expect(swapSuggestion(WED, { ...history, sessions: [...sessions, { ...thuDeadlift, date: "2026-11-02" }] })).toBeNull();
  });

  it("needs the swapped lift actually done: a swap with nothing logged, or skipped, says nothing", () => {
    const unlogged = swapped(buildSession(TUE, history), ids.backSquat);
    expect(swapSuggestion(WED, { ...history, sessions: [unlogged] })).toBeNull();
    const skipped = { ...tue, blocks: tue.blocks.map((b) => (b.kind === "primary" ? { ...b, skipped: true } : b)) };
    expect(swapSuggestion(WED, { ...history, sessions: [skipped] })).toBeNull();
  });

  it("only for the day whose planned lift was done", () => {
    expect(swapSuggestion("2026-11-05", { ...history, sessions: [tue] })).toBeNull(); // Thu: strict press
  });

  it("a swapped AMRAP raises that lift's max; Wednesday's swap computes from the deadlift as it is", () => {
    // The squat bump (applied from Tuesday) is the squat's: Wednesday's deadlift sets don't move.
    const bumped = [...maxEntries, { ...max(9, ids.backSquat, 318, TUE), source: "amrap" as const }];
    expect(currentMax(bumped, ids.backSquat)!.valueLb).toBe(318);
    const wed = swapMainLift(buildSession(WED, { ...ctx, maxEntries: bumped }), ids.deadlift, { ...ctx, maxEntries: bumped });
    expect("session" in wed && wed.session.primaryMaxLb).toBe(405);
  });
});
