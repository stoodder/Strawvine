import { describe, expect, it } from "vitest";
import { defaultSettings } from "./defaults";
import { amrapPrs, checklist } from "./gamify";
import { currentMax, mainLiftSets, cyclePosition } from "./program";
import { sessionSchema, type Block, type Exercise, type MaxEntry, type Session } from "./schemas";
import { buildSession, buildSessionFrom, mainLiftAdded, mainLiftSwap, planChanged, plannedLiftOf, planSignature, templateSource } from "./session";
import { addBlocked, recalculateMainLift, removeMainLift, swapBlocked, swapChoices, swapMainLift, swapSuggestion, undoSwap } from "./swap";

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
const THU = "2026-11-05";
const FRI = "2026-11-06";
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
    // Tuesday's plan has a main lift: a session without one (its main lift missing) is the plan's to rebuild, not to add to.
    expect(swapMainLift({ ...tue, blocks: tue.blocks.filter((b) => b.kind !== "primary") }, ids.backSquat, ctx)).toEqual({
      refused: "no-main",
    });
    // Saturday isn't a lifting day.
    expect(swapMainLift(buildSession("2026-11-07", ctx), ids.backSquat, ctx)).toEqual({ refused: "not-planned" });
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
    // What a build that doesn't know swaps checks: the signature is still the plan's (no plan change),
    // and the max the session was built from is the swapped lift's own (no "new max" either).
    expect(planSignature(TUE, ctx)).toBe(s.planSig);
    expect(s.primaryMaxLb).toBe(currentMax(maxEntries, ids.backSquat)!.valueLb);
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
      // Nothing saved this week: Monday's bench is still to do.
      { exerciseId: ids.bench, days: [1], hasMax: true, missed: true },
      { exerciseId: ids.backSquat, days: [3], hasMax: true, missed: false },
      { exerciseId: ids.strictPress, days: [4], hasMax: true, missed: false },
      { exerciseId: ids.frontSquat, days: [], hasMax: false, missed: false },
    ]);
  });
  it("lists first the lifts still to do this week whose day has passed (latest first), given the saved sessions", () => {
    const fri = buildSession(FRI, ctx);
    // Mon bench done, Tue deadlift swapped for squat (done), Wed's squat day did the deadlift, Thu skipped entirely.
    const done = (date: string, lift?: number) => {
      const b = buildSession(date, ctx);
      return logMain(lift === undefined ? b : swapped(b, lift), 6);
    };
    const week = [done("2026-11-02"), done(TUE, ids.backSquat), done(WED, ids.deadlift)];
    expect(swapChoices(fri, { ...ctx, sessions: week }).choices.map((c) => [c.exerciseId, c.missed])).toEqual([
      [ids.strictPress, true],
      [ids.bench, false],
      [ids.deadlift, false],
      [ids.backSquat, false],
      [ids.frontSquat, false],
    ]);
    // Thursday's press skipped (a session, its main lift skipped): still to do. Wednesday not done at all: both, latest first.
    const thuSkipped = { ...buildSession(THU, ctx), blocks: buildSession(THU, ctx).blocks.map((b) => ({ ...b, skipped: true })) };
    expect(
      swapChoices(fri, { ...ctx, sessions: [done("2026-11-02"), done(TUE), thuSkipped] })
        .choices.filter((c) => c.missed)
        .map((c) => c.exerciseId),
    ).toEqual([ids.strictPress, ids.backSquat]);
    // Without the saved sessions nothing is known to be missed (the order is the plan's).
    const { sessions: _none, ...unknown } = ctx;
    expect(swapChoices(fri, unknown).choices.some((c) => c.missed)).toBe(false);
    // Before the program (no cycle week) neither.
    expect(swapChoices(buildSession("2026-10-30", ctx), { ...ctx, sessions: [] }).choices.some((c) => c.missed)).toBe(false);
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

describe("adding a main lift to a day whose plan has none (Friday's Carries & pull)", () => {
  const fri = buildSession(FRI, history);
  const added = (s: Session, id: number) => {
    const r = swapMainLift(s, id, ctx);
    if (!("session" in r)) throw new Error(`refused: ${r.refused}`);
    return r.session;
  };

  it("adds the lift first, calculated from its max with this week's scheme and the day's AMRAP setting (Friday's is off)", () => {
    expect(fri.label).toBe("Carries & pull");
    expect(fri.blocks.some((b) => b.kind === "primary")).toBe(false);
    expect(addBlocked(fri, ctx)).toBeNull();
    const s = added(fri, ids.strictPress);
    expect(s.blocks[0]!.kind).toBe("primary");
    expect(s.blocks.slice(1)).toEqual(fri.blocks);
    const pos = cyclePosition(settings.program, FRI)!;
    expect(main(s).exercises[0]!.sets.map((x) => [x.targetReps, x.targetWeight, x.amrap])).toEqual(
      mainLiftSets(settings.program, 135, pos.week, { progressionDay: false }).map((p) => [p.reps, p.weightLb, p.amrap]),
    );
    expect(main(s).exercises[0]!.sets.some((x) => x.amrap)).toBe(false);
    expect(s.primaryMaxLb).toBe(135);
    expect([s.label, s.week, s.deload, s.planSig]).toEqual([fri.label, fri.week, fri.deload, null]);
    // Read as added (never as swapped), and no plan change.
    expect(mainLiftAdded(s, ctx)).toBe(ids.strictPress);
    expect(mainLiftSwap(s)).toBeNull();
    expect(planChanged(s, ctx)).toBe(false);
    // Friday's AMRAP switch on: the added lift's last set is an AMRAP.
    const amrapFri = {
      ...settings,
      program: { ...settings.program, days: { ...settings.program.days, "5": { ...settings.program.days["5"]!, progression: true } } },
    };
    const c = { ...ctx, settings: amrapFri };
    const r = swapMainLift(buildSession(FRI, c), ids.strictPress, c);
    expect("session" in r && main(r.session).exercises[0]!.sets.at(-1)!.amrap).toBe(true);
  });

  it("in the deload week: 4 × 10 from the lift's 12-rep max, no AMRAP", () => {
    const deloadFri = "2026-12-04";
    const s = added(buildSession(deloadFri, ctx), ids.strictPress);
    expect(s.deload).toBe(true);
    const pos = cyclePosition(settings.program, deloadFri)!;
    expect(main(s).exercises[0]!.sets.map((x) => [x.targetReps, x.targetWeight, x.amrap])).toEqual(
      mainLiftSets(settings.program, 135, pos.week, { progressionDay: false }).map((p) => [p.reps, p.weightLb, false]),
    );
    expect(main(s).exercises[0]!.sets.every((x) => x.targetReps === 10)).toBe(true);
  });

  it("is decided by the day's plan, not by a missing signature: seeded and imported sessions aren't 'added'", () => {
    const seededTue = { ...buildSession(TUE, ctx), planSig: null };
    expect(mainLiftAdded(seededTue, ctx)).toBeNull();
    // A Friday session built when Friday had a main lift (its signature names it): a plan change, not an addition.
    const days = { ...settings.program.days, "5": { ...settings.program.days["5"]!, primaryExerciseId: ids.bench } };
    const c = { ...ctx, settings: { ...settings, program: { ...settings.program, days } } };
    const benchFri = buildSession(FRI, c);
    expect(mainLiftAdded(benchFri, ctx)).toBeNull();
    expect(planChanged(benchFri, ctx)).toBe(true);
    // An old session without a signature gets the plan's (none) when a lift is added: no plan change either.
    const { planSig: _, ...old } = fri;
    const s = added(old as Session, ids.strictPress);
    expect(s.planSig).toBeNull();
    expect(planChanged(s, ctx)).toBe(false);
    expect(mainLiftAdded(s, ctx)).toBe(ids.strictPress);
  });

  it("is refused before the program, once finished, for a lift without a max; then it's a swap like any", () => {
    expect(addBlocked(buildSession("2026-10-30", ctx), ctx)).toBe("not-planned");
    expect(swapMainLift({ ...fri, completedAt: "x" }, ids.strictPress, ctx)).toEqual({ refused: "finished" });
    expect(swapMainLift(fri, ids.frontSquat, ctx)).toEqual({ refused: "no-max" });
    const s = added(fri, ids.strictPress);
    const b = added(s, ids.bench);
    expect(main(b).exercises[0]!.exerciseId).toBe(ids.bench);
    expect(mainLiftAdded(b, ctx)).toBe(ids.bench);
    expect(swapChoices(b, ctx).back).toBeNull();
  });

  it("is removed again (nothing logged), and the Undo of the add or the removal puts back only the main lift", () => {
    const s = added(fri, ids.strictPress);
    const r = removeMainLift(s, ctx);
    expect("session" in r && r.session).toEqual({ ...fri, primaryMaxLb: null });
    // A planned main lift isn't removable; a logged one isn't either.
    expect(removeMainLift(buildSession(TUE, ctx), ctx)).toEqual({ refused: "no-main" });
    expect(removeMainLift(logMain(s, 6), ctx)).toEqual({ refused: "finished" });
    expect(removeMainLift({ ...logMain(s, 6), completedAt: null }, ctx)).toEqual({ refused: "logged" });
    // Undo of the add, on the session as it is (a note written since): the note stays, the lift goes.
    const later = { ...s, notes: "hotel gym" };
    const undone = undoSwap(later, s, fri) as Session;
    expect(undone.blocks).toEqual(fri.blocks);
    expect([undone.primaryMaxLb, undone.planSig, undone.notes]).toEqual([fri.primaryMaxLb, fri.planSig, "hotel gym"]);
    expect(undoSwap({ ...logMain(s, 6), completedAt: null }, s, fri)).toBe("logged");
    // Undo of a removal: the lift comes back first, unless a main lift is there again.
    const removed = (r as { session: Session }).session;
    const back = undoSwap({ ...removed, notes: "x" }, removed, s) as Session;
    expect(back.blocks).toEqual(s.blocks);
    expect([back.primaryMaxLb, back.notes]).toEqual([135, "x"]);
    expect(undoSwap(added(removed, ids.bench), removed, s)).toBe("changed");
  });

  it("checklist and history: Friday's lift item is the day's as always; the lift's sets are that lift's", () => {
    const s = logMain(added(fri, ids.strictPress), 6);
    const lift = (x: Session | undefined) => checklist(FRI, undefined, x, settings).find((i) => i.key === "lift");
    expect(lift(s)?.done).toBe(true);
    expect(lift({ ...s, completedAt: null })?.done).toBe(false);
    expect(lift({ ...fri, completedAt: "x" })?.done).toBe(true);
    // No AMRAP on Friday: nothing for the press's rep PRs or max.
    expect(amrapPrs([s])).toEqual([]);
    // Next Friday pre-fills the day's accessories, not the added lift.
    const next = buildSession("2026-11-13", { ...history, sessions: [...history.sessions, s] });
    expect(next.blocks.some((b) => b.kind === "primary")).toBe(false);
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

describe("swap and Recalculate keep Core and rehab (SPEC §6.8)", () => {
  const coreBlock: Block = { id: "core", kind: "accessory", section: "core", exercises: [{ exerciseId: 11, measure: "reps", sets: [set("k1", 10, 0)] }] };
  const rehabBlock: Block = { id: "knee", kind: "rehab", rehab: "knee", exercises: [{ exerciseId: 10, measure: "reps", sets: [set("q1", 12, 20)] }] };
  /** Tuesday with its accessories, a Core block and logged rehab. */
  const full = (s: Session): Session => ({ ...s, blocks: [...s.blocks, coreBlock, rehabBlock] });
  const others = (s: Session) => s.blocks.filter((b) => b.kind !== "primary");

  it("a swap replaces only the main block; a removal and the Undo keep the rest in place", () => {
    const tue = full(buildSession(TUE, history));
    expect(swapBlocked(tue)).toBeNull(); // a logged rehab set is no logged main-lift set
    const s = swapped(tue, ids.backSquat);
    expect(others(s)).toEqual(others(tue));
    expect(s.blocks.at(-1)).toBe(rehabBlock);
    expect(undoSwap(s, s, tue)).toEqual(tue);
    const fri = full(buildSession(FRI, history));
    const added = swapped(fri, ids.strictPress);
    expect(added.blocks[0]!.kind).toBe("primary");
    expect(added.blocks.slice(1)).toEqual(fri.blocks);
    const removed = removeMainLift(added, ctx);
    expect("session" in removed && removed.session.blocks).toEqual(fri.blocks);
  });

  it("Recalculate replaces only the main block (plan changed, new max): Core, rehab and notes stay; a skipped main lift stays skipped", () => {
    const tue = { ...full(buildSession(TUE, history)), notes: "knee ok" };
    const newMax = { ...history, maxEntries: [...maxEntries, max(9, ids.deadlift, 425, "2026-11-02")] };
    const r = recalculateMainLift(tue, newMax);
    expect(r.primaryMaxLb).toBe(425);
    expect(main(r).id).not.toBe(main(tue).id);
    expect(others(r)).toEqual(others(tue));
    expect(r.notes).toBe("knee ok");
    expect(planChanged(r, newMax)).toBe(false);
    const skipped = { ...tue, blocks: tue.blocks.map((b) => (b.kind === "primary" ? { ...b, skipped: true } : b)) };
    expect(main(recalculateMainLift(skipped, newMax)).skipped).toBe(true);
    // A swapped session recalculates its swapped lift; a moved one follows its own program day.
    const swap = swapped(tue, ids.backSquat);
    expect(main(recalculateMainLift(swap, newMax)).exercises[0]!.exerciseId).toBe(ids.backSquat);
    const moved = full(buildSessionFrom(WED, TUE, history));
    expect(main(recalculateMainLift(moved, newMax)).exercises[0]!.exerciseId).toBe(ids.backSquat);
    expect(others(recalculateMainLift(moved, newMax))).toEqual(others(moved));
  });

  it("the swap sheet's 'still to do this week' and the suggestion read main lifts only, never rehab", () => {
    const tue = full(swapped(buildSession(TUE, history), ids.backSquat));
    const logged = { ...tue, blocks: tue.blocks.map((b) => (b.kind === "primary" ? { ...b, exercises: [{ ...b.exercises[0]!, sets: b.exercises[0]!.sets.map((x) => ({ ...x, done: true })) }] } : b)) };
    expect(swapSuggestion(WED, { ...history, sessions: [logged] })?.suggest).toBe(ids.deadlift);
    const rehabOnly: Session = { ...buildSession(TUE, history), blocks: [rehabBlock] };
    expect(swapSuggestion(WED, { ...history, sessions: [rehabOnly] })).toBeNull();
    expect(swapChoices(buildSession(THU, history), { ...ctx, sessions: [rehabOnly] }).choices.find((c) => c.exerciseId === ids.deadlift)?.missed).toBe(true);
  });
});
