import { describe, expect, it } from "vitest";
import { defaultSettings } from "./defaults";
import {
  cancelRehab,
  editRehab,
  endRehab,
  extendRehab,
  newRehabStart,
  rehabBlocks,
  rehabCounts,
  rehabDay,
  rehabInForce,
  rehabLastDay,
  rehabPlanned,
  rehabPlannedDates,
  rehabPrograms,
  rehabProgramsAt,
  rehabSessions,
  rehabTemplate,
  rehabTemplateSource,
  rehabWeek,
  restoreRehabSpan,
  startRehab,
  withRehabDraft,
  type RehabFields,
} from "./rehab";
import {
  settingsSchema,
  type Block,
  type BlockExercise,
  type Exercise,
  type RehabProgram,
  type Session,
  type SetEntry,
  type Settings,
} from "./schemas";
import { blankSet, buildSession, setsForAddedExercise } from "./session";
import { MAX_BLOCKS } from "./sessionStructure";

const ids = { bench: 1, deadlift: 2, backSquat: 3, frontSquat: 4, strictPress: 5 };
// The strength program starts Monday 2026-11-02.
const base: Settings = { ...defaultSettings(ids, "2026-11-01"), onboarded: true };
const MWF = [false, true, false, true, false, true, false];
const knee: RehabProgram = { id: "knee", name: "Knee rehab", start: "2026-11-02", weeks: 6, days: MWF, carry: "last" };
const withKnee = (p: Partial<RehabProgram> = {}): Settings => ({ ...base, rehab: { programs: [{ ...knee, ...p }] } });
const settings = withKnee();

const exercises: Exercise[] = [
  { id: 1, name: "Bench press", category: "primary", tracksMax: true, measure: "reps", weighted: true, archived: false },
  { id: 20, name: "Spanish squat", category: "accessory", tracksMax: false, measure: "seconds", weighted: false, archived: false },
  { id: 21, name: "Leg extension", category: "accessory", tracksMax: false, measure: "reps", weighted: true, archived: false },
  { id: 22, name: "Step-down", category: "accessory", tracksMax: false, measure: "reps", weighted: true, archived: false },
  { id: 23, name: "Old drill", category: "accessory", tracksMax: false, measure: "reps", weighted: true, archived: true },
  { id: 30, name: "Barbell row", category: "accessory", tracksMax: false, measure: "reps", weighted: true, archived: false },
];

const MON = "2026-11-09";
const WED = "2026-11-11";
const FRI = "2026-11-13";

const done = (id: string, reps: number, weight: number | null, o: Partial<SetEntry> = {}): SetEntry =>
  blankSet({ id, targetReps: reps, targetWeight: weight, reps, weight, done: true, ...o });
const ex = (exerciseId: number, sets: SetEntry[], o: Partial<BlockExercise> = {}): BlockExercise => ({
  exerciseId,
  measure: exercises.find((e) => e.id === exerciseId)?.measure ?? "reps",
  sets,
  ...o,
});
const rehabBlock = (id: string, exs: BlockExercise[], rehab = "knee"): Block => ({ id, kind: "rehab", exercises: exs, rehab });
const session = (date: string, blocks: Block[], o: Partial<Session> = {}): Session => ({
  date,
  label: "Training",
  cycle: null,
  week: null,
  deload: false,
  primaryMaxLb: null,
  blocks,
  notes: "",
  completedAt: null,
  ...o,
});
/** Monday's knee session: a superset (Spanish squat + leg extension) and step-downs. */
const monday = session(MON, [
  rehabBlock("ss", [
    ex(20, [done("a1", 45, null), done("a2", 45, null)]),
    ex(21, [done("b1", 12, 40), done("b2", 10, 40, { targetReps: 12 })]),
  ]),
  rehabBlock("sd", [ex(22, [done("c1", 10, 20)])]),
]);
const ctx = (sessions: Session[]) => ({ settings, exercises, maxEntries: [], sessions });

describe("the rehab timeline", () => {
  it("is in force from its start for its weeks, planned on its days, week by week", () => {
    expect(rehabLastDay(knee)).toBe("2026-12-13");
    expect(rehabInForce(knee, "2026-11-01")).toBe(false);
    expect(rehabInForce(knee, "2026-11-02")).toBe(true);
    expect(rehabInForce(knee, "2026-12-13")).toBe(true);
    expect(rehabInForce(knee, "2026-12-14")).toBe(false);
    expect(rehabDay(knee, MON)).toBe(true);
    expect(rehabDay(knee, "2026-11-10")).toBe(false);
    expect(rehabWeek(knee, "2026-11-02")).toBe(1);
    expect(rehabWeek(knee, "2026-11-08")).toBe(1);
    expect(rehabWeek(knee, WED)).toBe(2);
    expect(rehabWeek(knee, "2026-12-13")).toBe(6);
    expect(rehabWeek(knee, "2026-12-14")).toBeNull();
    expect(rehabPlannedDates(knee)).toHaveLength(18);
    expect(rehabPlanned(settings, WED).map((p) => p.id)).toEqual(["knee"]);
    expect(rehabPlanned(settings, "2026-11-10")).toEqual([]);
    expect(rehabProgramsAt(settings, "2026-11-10").map((p) => p.id)).toEqual(["knee"]);
  });

  it("an early end (inclusive) cuts it short; a later one changes nothing", () => {
    const ended = { ...knee, end: "2026-11-20" };
    expect(rehabLastDay(ended)).toBe("2026-11-20");
    expect(rehabInForce(ended, "2026-11-20")).toBe(true);
    expect(rehabInForce(ended, "2026-11-23")).toBe(false);
    expect(rehabPlannedDates(ended)).toHaveLength(9);
    expect(rehabLastDay({ ...knee, end: "2027-01-31" })).toBe("2026-12-13");
  });

  it("reads nothing from settings without rehab (stored before it existed), and is independent of the strength plan", () => {
    expect(rehabPrograms(base)).toEqual([]);
    expect(rehabPlanned(base, MON)).toEqual([]);
    // A delayed strength program doesn't move rehab.
    const delayed = { ...settings, program: { ...settings.program, cycleStartDate: "2026-11-16" } };
    expect(rehabPlanned(delayed, MON).map((p) => p.id)).toEqual(["knee"]);
    expect(rehabWeek(rehabPrograms(delayed)[0]!, MON)).toBe(2);
  });

  it("orders blocks by start and counts the sessions logged in each", () => {
    const later: RehabProgram = { ...knee, id: "hip", name: "Hip", start: "2027-01-04", weeks: 2 };
    const s = { ...base, rehab: { programs: [later, knee] } };
    expect(rehabPrograms(s).map((p) => p.id)).toEqual(["knee", "hip"]);
    const open = session(WED, [rehabBlock("w", [ex(22, [blankSet({ id: "x" })])])]);
    expect(rehabSessions(knee, [open, monday]).map((x) => x.date)).toEqual([MON]);
    expect(rehabCounts(monday)).toEqual({ done: 5, total: 5 });
    expect(rehabCounts(monday, "hip")).toEqual({ done: 0, total: 0 });
  });
});

describe("rehab drafts (B.3)", () => {
  it("carry 'last': Wednesday starts from Monday — supersets, reps as targets, loads as logged, fresh ids, its rehab block", () => {
    const blocks = rehabTemplate(WED, knee, ctx([monday]));
    expect(blocks.map((b) => [b.kind, b.rehab, b.exercises.map((e) => e.exerciseId)])).toEqual([
      ["rehab", "knee", [20, 21]],
      ["rehab", "knee", [22]],
    ]);
    const ext = blocks[0]!.exercises[1]!;
    expect(ext.sets.map((s) => [s.targetReps, s.targetWeight, s.done, s.reps])).toEqual([
      [12, 40, false, null],
      [12, 40, false, null],
    ]);
    // Unweighted Spanish squat: its seconds carry, no load.
    expect(blocks[0]!.exercises[0]!.sets.map((s) => [s.targetReps, s.targetWeight])).toEqual([
      [45, null],
      [45, null],
    ]);
    const before = new Set(monday.blocks.flatMap((b) => [b.id, ...b.exercises.flatMap((e) => e.sets.map((s) => s.id))]));
    for (const b of blocks) {
      expect(before.has(b.id)).toBe(false);
      for (const e of b.exercises) for (const s of e.sets) expect(before.has(s.id)).toBe(false);
    }
  });

  it("carry 'last' prefers the latest session with a logged set, else the latest", () => {
    const wedUnlogged = session(WED, [rehabBlock("w", [ex(22, [blankSet({ id: "w1", targetReps: 8, targetWeight: 10 })])])]);
    expect(rehabTemplateSource(FRI, knee, [monday, wedUnlogged])?.date).toBe(MON);
    expect(rehabTemplateSource(FRI, knee, [wedUnlogged])?.date).toBe(WED);
    expect(rehabTemplateSource(MON, knee, [monday])).toBeNull();
    expect(rehabTemplate("2026-11-04", knee, ctx([monday]))).toEqual([]);
  });

  it("carry 'weekday': the same weekday first, then the last", () => {
    const weekday = { ...knee, carry: "weekday" as const };
    const lastWed = session("2026-11-04", [rehabBlock("lw", [ex(21, [done("lw1", 15, 25)])])]);
    expect(rehabTemplateSource(WED, weekday, [lastWed, monday])?.date).toBe("2026-11-04");
    expect(rehabTemplate(WED, weekday, ctx([lastWed, monday]))[0]!.exercises.map((e) => e.exerciseId)).toEqual([21]);
    // No Friday yet: from the last session (Wednesday's).
    expect(rehabTemplateSource(FRI, weekday, [lastWed, monday])?.date).toBe(MON);
    // 'last' on the same data: Monday.
    expect(rehabTemplateSource(WED, knee, [lastWed, monday])?.date).toBe(MON);
  });

  it("only from its own rehab block, never from accessories; no deload scaling or hints", () => {
    const strength = session("2026-11-10", [{ id: "row", kind: "accessory", exercises: [ex(30, [done("r1", 10, 135)])] }], {
      deload: true,
    });
    const otherBlock = session("2026-11-10", [rehabBlock("h", [ex(30, [done("h1", 10, 100)])], "hip")]);
    expect(rehabTemplate(WED, knee, ctx([strength, otherBlock]))).toEqual([]);
    // A deload week's draft carries the loads as logged.
    const deloadWeek = rehabTemplate("2026-12-02", knee, ctx([{ ...monday, deload: true }]));
    expect(deloadWeek[1]!.exercises[0]!.sets[0]!.targetWeight).toBe(20);
  });

  it("a skipped exercise carries from its last real performance; an archived one is dropped; a changed measure resets targets", () => {
    const wed = session(WED, [
      rehabBlock("w", [ex(22, [blankSet({ id: "w1", targetReps: 10, targetWeight: 25 })], { skipped: true }), ex(23, [done("o1", 5, 5)])]),
      rehabBlock("w2", [ex(21, [done("e1", 12, 40)], { measure: "seconds" })]),
    ]);
    const blocks = rehabTemplate(FRI, knee, ctx([monday, wed]));
    expect(blocks[0]!.exercises.map((e) => e.exerciseId)).toEqual([22]);
    expect(blocks[0]!.exercises[0]!.sets.map((s) => [s.targetReps, s.targetWeight])).toEqual([[10, 20]]);
    expect(blocks[0]!.exercises[0]!.skipped).toBeUndefined();
    // Done in seconds, now counted in reps: the set count and load carry, the target resets.
    expect(blocks[1]!.exercises[0]!.measure).toBe("reps");
    expect(blocks[1]!.exercises[0]!.sets.map((s) => [s.targetReps, s.targetWeight])).toEqual([[10, 40]]);
  });

  it("a new block can start from another block's last session", () => {
    const next: RehabProgram = { ...knee, id: "knee-2", start: "2026-12-14" };
    expect(rehabTemplate("2026-12-14", next, ctx([monday]))).toEqual([]);
    const from = rehabTemplate("2026-12-14", next, ctx([monday]), { from: "knee" });
    expect(from.map((b) => b.rehab)).toEqual(["knee-2", "knee-2"]);
  });

  it("withRehabDraft: the day's view gets the draft of each planned block it holds none of — else the same object", () => {
    const c = ctx([monday]);
    const wedPlan = buildSession(WED, c);
    const view = withRehabDraft(wedPlan, c);
    expect(view.blocks.slice(0, wedPlan.blocks.length)).toEqual(wedPlan.blocks);
    expect(rehabBlocks(view, "knee")).toHaveLength(2);
    // Saved already, not planned, not in force, nothing to carry: unchanged.
    expect(withRehabDraft(view, c)).toBe(view);
    const tue = buildSession("2026-11-10", c);
    expect(withRehabDraft(tue, c)).toBe(tue);
    const first = session("2026-11-02", []);
    expect(withRehabDraft(first, c)).toBe(first);
    expect(withRehabDraft(wedPlan, { ...c, settings: base })).toBe(wedPlan);
    // Never past the 30 blocks a session holds.
    const full = session(
      WED,
      Array.from({ length: MAX_BLOCKS - 1 }, (_, i) => ({ id: `a${i}`, kind: "accessory" as const, exercises: [ex(30, [])] })),
    );
    expect(withRehabDraft(full, c).blocks).toHaveLength(MAX_BLOCKS);
  });

  it("an exercise added to rehab by hand: its last rehab performance, else its last accessory one, else 3 × default — never scaled", () => {
    const into = { date: FRI, plannedFor: null, deload: true };
    const leg = exercises.find((e) => e.id === 21)!;
    expect(setsForAddedExercise(leg, into, ctx([monday]), { rehab: true }).map((s) => [s.targetReps, s.targetWeight])).toEqual([
      [12, 40],
      [12, 40],
    ]);
    const row = exercises.find((e) => e.id === 30)!;
    const strength = session("2026-11-10", [{ id: "row", kind: "accessory", exercises: [ex(30, [done("r1", 10, 135)])] }]);
    expect(setsForAddedExercise(row, into, ctx([strength]), { rehab: true }).map((s) => s.targetWeight)).toEqual([135]);
    // The strength pre-fill of the same exercise scales into the deload week, and never reads rehab.
    expect(setsForAddedExercise(row, into, ctx([strength])).map((s) => s.targetWeight)).toEqual([110]);
    expect(setsForAddedExercise(leg, into, ctx([monday])).map((s) => s.targetReps)).toEqual([10, 10, 10]);
    expect(setsForAddedExercise(leg, into, ctx([]), { rehab: true })).toHaveLength(3);
  });
});

describe("editing rehab blocks (Program › Rehab)", () => {
  const fields: RehabFields = { name: " Knee rehab ", start: "2026-11-02", weeks: 6, days: MWF, carry: "last" };

  it("starts one; the settings still validate", () => {
    const r = startRehab(base, fields, "knee");
    if ("refused" in r) throw new Error(r.refused);
    expect(r.program).toEqual(knee);
    expect(settingsSchema.parse(r.settings).rehab?.programs).toEqual([knee]);
    expect(base.rehab).toBeUndefined();
  });

  it("refuses an overlap, saying why, and invalid fields", () => {
    expect(startRehab(settings, { ...fields, start: "2026-12-07" }, "b")).toEqual({
      refused: "Knee rehab runs until Dec 13: end it or start this one after.",
    });
    expect(startRehab(settings, { ...fields, start: "2026-10-26", weeks: 2 }, "b")).toEqual({
      refused: "Knee rehab starts Nov 2: end this one before it.",
    });
    expect(startRehab(settings, { ...fields, start: "2026-12-14" }, "b")).not.toHaveProperty("refused");
    expect(startRehab(settings, { ...fields, start: "2026-10-19", weeks: 2 }, "b")).not.toHaveProperty("refused");
    expect(startRehab(settings, { ...fields, start: "2027-01-04" }, "knee")).toEqual({ refused: "That rehab block already exists." });
    expect(startRehab(base, { ...fields, weeks: 0 }, "b")).toEqual({ refused: "A rehab block lasts 1 to 52 weeks." });
    expect(startRehab(base, { ...fields, weeks: 53 }, "b")).toEqual({ refused: "A rehab block lasts 1 to 52 weeks." });
    expect(startRehab(base, { ...fields, days: Array(7).fill(false) }, "b")).toEqual({ refused: "Pick at least one day." });
    expect(startRehab(base, { ...fields, start: "2026-02-30" }, "b")).toEqual({ refused: "Pick the day it starts." });
  });

  it("an ended block leaves room for the next one from the day after", () => {
    const ended = withKnee({ end: "2026-11-20" });
    expect(newRehabStart(ended, "2026-11-25")).toBe("2026-11-25");
    expect(newRehabStart(settings, "2026-11-25")).toBe("2026-12-14");
    expect(newRehabStart(base, "2026-11-25")).toBe("2026-11-25");
    expect(startRehab(ended, { ...fields, start: "2026-11-21" }, "b")).not.toHaveProperty("refused");
  });

  it("edits its fields, refusing what would overlap another", () => {
    const two = startRehab(settings, { ...fields, name: "Hip", start: "2026-12-14", weeks: 2 }, "hip");
    if ("refused" in two) throw new Error(two.refused);
    const days = editRehab(two.settings, "knee", { days: [false, true, false, false, true, false, false], carry: "weekday" }, []);
    if ("refused" in days) throw new Error(days.refused);
    expect(days.program).toMatchObject({ days: [false, true, false, false, true, false, false], carry: "weekday", weeks: 6 });
    expect(editRehab(two.settings, "knee", { weeks: 7 }, [])).toEqual({ refused: "Hip starts Dec 14: end this one before it." });
    expect(editRehab(two.settings, "nope", { weeks: 7 }, [])).toEqual({ refused: "That rehab block is gone." });
    const renamed = editRehab(two.settings, "knee", { name: "  Left knee " }, []);
    expect("program" in renamed && renamed.program.name).toBe("Left knee");
  });

  it("after two devices' blocks merged into an overlap: edits that add no shared day go through, the rest are refused", () => {
    // Each device started one; the merge kept both (a "rehab blocks" conflict): Dec 7–13 is shared.
    const hip: RehabProgram = { ...knee, id: "hip", name: "Hip", start: "2026-12-07", weeks: 2 };
    const merged: Settings = { ...base, rehab: { programs: [knee, hip] } };
    const ok = (r: ReturnType<typeof editRehab>) => ("refused" in r ? r.refused : "ok");
    expect(ok(editRehab(merged, "knee", { name: "Knee" }, []))).toBe("ok");
    expect(ok(editRehab(merged, "hip", { days: [false, false, true, false, true, false, false], carry: "weekday" }, []))).toBe("ok");
    // Shorter: less shared. Fine.
    expect(ok(editRehab(merged, "knee", { weeks: 5 }, []))).toBe("ok");
    // Longer, or the later one starting earlier: more shared days. Refused.
    expect(editRehab(merged, "knee", { weeks: 7 }, [])).toEqual({ refused: "Hip starts Dec 7: end this one before it." });
    expect(editRehab(merged, "hip", { start: "2026-12-01" }, [])).toEqual({
      refused: "Knee rehab runs until Dec 13: end it or start this one after.",
    });
    expect(extendRehab(merged, "knee")).toEqual({ refused: "Hip starts Dec 7: end this one before it." });
    // A new block over either is still refused.
    expect(startRehab(merged, { ...fields, name: "Back", start: "2026-12-10", weeks: 1 }, "back")).toHaveProperty("refused");
  });

  it("refuses an edit that would leave a logged session outside the block; one inside it, or a session not logged, doesn't hold it", () => {
    const logged = [monday]; // Nov 9, week 2
    expect(editRehab(settings, "knee", { start: "2026-11-10" }, logged)).toEqual({
      refused: "Knee rehab has a session logged Nov 9: start it on or before then.",
    });
    expect(editRehab(withKnee({ start: "2026-11-09", weeks: 2 }), "knee", { start: "2026-11-10" }, logged)).toHaveProperty("refused");
    const unlogged = session(MON, [rehabBlock("m", [ex(22, [blankSet({ id: "u1" })])])]);
    expect(editRehab(settings, "knee", { start: "2026-11-16" }, [unlogged])).not.toHaveProperty("refused");
    // Ending it earlier than a logged session (a shorter block) is refused the same way.
    expect(editRehab(settings, "knee", { weeks: 1 }, logged)).toEqual({
      refused: "Knee rehab has a session logged Nov 9: end it on or after then.",
    });
    // Still inside: a later start up to the session, another length.
    expect(editRehab(settings, "knee", { start: "2026-11-09", weeks: 3 }, logged)).not.toHaveProperty("refused");
    // A session of another block doesn't count.
    const hipDay = session(MON, [rehabBlock("h", [ex(22, [done("h1", 10, null)])], "hip")]);
    expect(editRehab(settings, "knee", { start: "2026-11-16" }, [hipDay])).not.toHaveProperty("refused");
  });

  it("+ A week: the last day a week later (the preview's two dates); an early end moves too; refused into the next block", () => {
    const r = extendRehab(settings, "knee");
    if ("refused" in r) throw new Error(r.refused);
    expect([r.was, r.lastDay]).toEqual(["2026-12-13", "2026-12-20"]);
    expect(r.program).toEqual({ ...knee, weeks: 7 });
    const early = extendRehab(withKnee({ end: "2026-11-20" }), "knee");
    if ("refused" in early) throw new Error(early.refused);
    expect([early.was, early.lastDay, early.program.weeks, early.program.end]).toEqual(["2026-11-20", "2026-11-27", 6, "2026-11-27"]);
    // An end within a week of the natural end: a week longer, still ended early a week later.
    const nearly = extendRehab(withKnee({ end: "2026-12-11" }), "knee");
    expect("program" in nearly && [nearly.program.weeks, nearly.program.end]).toEqual([7, "2026-12-18"]);
    const next = startRehab(settings, { ...fields, name: "Hip", start: "2026-12-16" }, "hip");
    if ("refused" in next) throw new Error(next.refused);
    expect(extendRehab(next.settings, "knee")).toEqual({ refused: "Hip starts Dec 16: end this one before it." });
    expect(extendRehab(withKnee({ weeks: 52 }), "knee")).toEqual({ refused: "A rehab block lasts 1 to 52 weeks." });
  });

  it("End today: today stays in with rehab logged today, else the last day is yesterday", () => {
    const loggedToday = endRehab(settings, "knee", MON, [monday]);
    if ("refused" in loggedToday) throw new Error(loggedToday.refused);
    expect(loggedToday.lastDay).toBe(MON);
    expect(rehabInForce(rehabPrograms(loggedToday.settings)[0]!, MON)).toBe(true);
    expect(rehabPlanned(loggedToday.settings, WED)).toEqual([]);

    // Only a saved draft today (nothing logged), or another day logged: yesterday.
    const draftToday = session(WED, [rehabBlock("w", [ex(22, [blankSet({ id: "w1" })])])]);
    const nothing = endRehab(settings, "knee", WED, [monday, draftToday]);
    if ("refused" in nothing) throw new Error(nothing.refused);
    expect(nothing.lastDay).toBe("2026-11-10");
    expect(rehabProgramsAt(nothing.settings, WED)).toEqual([]);
    expect(rehabProgramsAt(nothing.settings, "2026-11-10").map((p) => p.id)).toEqual(["knee"]);
  });

  it("End today drops today's unlogged rehab blocks of it from today's session; logged ones (and other blocks) stay", () => {
    const strength: Block = { id: "p", kind: "primary", exercises: [ex(1, [blankSet({ id: "p1" })])] };
    const draft = rehabBlock("w", [ex(22, [blankSet({ id: "w1" })])]);
    const hip = rehabBlock("h", [ex(20, [blankSet({ id: "h1" })])], "hip");
    const today = session(WED, [strength, draft, hip], { notes: "sore" });
    const r = endRehab(settings, "knee", WED, [monday, today]);
    if ("refused" in r) throw new Error(r.refused);
    expect(r.today).toEqual({ ...today, blocks: [strength, hip] });
    // Nothing else in it: today's session goes (the day reads its plan's draft again).
    const onlyRehab = endRehab(settings, "knee", WED, [monday, session(WED, [draft])]);
    expect("today" in onlyRehab && onlyRehab.today).toBeNull();
    // Logged today: it stays in today, and so do its blocks.
    expect(endRehab(settings, "knee", MON, [monday])).not.toHaveProperty("today");
    // No rehab of it saved today: today's session is left alone.
    expect(endRehab(settings, "knee", WED, [monday, session(WED, [strength])])).not.toHaveProperty("today");
    expect(endRehab(settings, "knee", WED, [monday])).not.toHaveProperty("today");
  });

  it("End today on its first day: removed when nothing of it is logged, else ended before its first day (its sessions keep their block)", () => {
    const r = endRehab(settings, "knee", "2026-11-02", []);
    expect(r).toMatchObject({ lastDay: null, program: null });
    expect("settings" in r && rehabPrograms(r.settings)).toEqual([]);
    // A session logged in it before its start (two devices: one moved the start, one logged).
    const early = session("2026-11-01", [rehabBlock("e", [ex(22, [done("e1", 10, null)])])]);
    const kept = endRehab(withKnee({ start: "2026-11-02" }), "knee", "2026-11-02", [early]);
    if ("refused" in kept) throw new Error(kept.refused);
    expect(kept.program).toEqual({ ...knee, end: "2026-11-01" });
    expect(rehabPrograms(kept.settings).map((p) => p.id)).toEqual(["knee"]);
    expect(rehabProgramsAt(kept.settings, "2026-11-02")).toEqual([]);
    expect(rehabSessions(kept.program!, [early])).toHaveLength(1);
    expect(settingsSchema.parse(kept.settings).rehab?.programs).toEqual([{ ...knee, end: "2026-11-01" }]);
    expect(endRehab(withKnee({ start: "2026-11-16" }), "knee", MON, [])).toEqual({
      refused: "Knee rehab hasn't started yet: cancel it instead.",
    });
    expect(endRehab(withKnee({ end: "2026-11-06" }), "knee", MON, [])).toEqual({ refused: "Knee rehab ended Nov 6." });
  });

  it("restoreRehabSpan sets the stored length (weeks, and an early end or none): the Undo of End today and of length changes", () => {
    const ended = endRehab(settings, "knee", WED, [monday]);
    if ("refused" in ended) throw new Error(ended.refused);
    // End today's Undo: back to 6 weeks, not ended early.
    const back = restoreRehabSpan(ended.settings, "knee", { weeks: 6, end: undefined }, [monday]);
    if ("refused" in back) throw new Error(back.refused);
    expect(back.program).toEqual(knee);
    expect(back.program).not.toHaveProperty("end");
    expect(settingsSchema.parse(back.settings).rehab?.programs).toEqual([knee]);
    // An early end is set as given; only the block's span changes.
    const early = restoreRehabSpan(withKnee({ name: "Knee", carry: "weekday" }), "knee", { weeks: 4, end: "2026-11-20" }, []);
    expect("program" in early && early.program).toEqual({ ...knee, name: "Knee", carry: "weekday", weeks: 4, end: "2026-11-20" });
    // "+ A week"'s Undo: shorter again.
    const longer = extendRehab(settings, "knee");
    if ("refused" in longer) throw new Error(longer.refused);
    expect(restoreRehabSpan(longer.settings, "knee", { weeks: 6 }, [monday])).toMatchObject({ program: knee });
  });

  it("restoreRehabSpan is refused like an edit: gone, out of range, an added overlap, a logged session left outside", () => {
    expect(restoreRehabSpan(settings, "nope", { weeks: 6 }, [])).toEqual({ refused: "That rehab block is gone." });
    expect(restoreRehabSpan(settings, "knee", { weeks: 53 }, [])).toEqual({ refused: "A rehab block lasts 1 to 52 weeks." });
    expect(restoreRehabSpan(settings, "knee", { weeks: 6, end: "2026-11-01" }, [])).toEqual({ refused: "It would end before it starts." });
    // Ended, then the next block set up from today: putting the length back would overlap it.
    const ended = endRehab(settings, "knee", WED, [monday]);
    if ("refused" in ended) throw new Error(ended.refused);
    const next = startRehab(ended.settings, { name: "Hip", start: WED, weeks: 2, days: MWF, carry: "last" }, "hip");
    if ("refused" in next) throw new Error(next.refused);
    expect(restoreRehabSpan(next.settings, "knee", { weeks: 6 }, [monday])).toEqual({
      refused: "Hip starts Nov 11: end this one before it.",
    });
    // "+ A week", then a session logged in the added week: its Undo would leave that session outside.
    const longer = extendRehab(settings, "knee");
    if ("refused" in longer) throw new Error(longer.refused);
    const added = session("2026-12-14", [rehabBlock("x", [ex(22, [done("x1", 10, null)])])]);
    expect(restoreRehabSpan(longer.settings, "knee", { weeks: 6 }, [monday, added])).toEqual({
      refused: "Knee rehab has a session logged Dec 14: end it on or after then.",
    });
    // An overlap it doesn't add (two devices' blocks merged) doesn't hold it.
    const hip: RehabProgram = { ...knee, id: "hip", name: "Hip", start: "2026-12-07", weeks: 2 };
    const merged: Settings = { ...base, rehab: { programs: [{ ...knee, end: "2026-12-08" }, hip] } };
    expect(restoreRehabSpan(merged, "knee", { weeks: 6, end: "2026-12-07" }, [])).not.toHaveProperty("refused");
    expect(restoreRehabSpan(merged, "knee", { weeks: 6 }, [])).toEqual({ refused: "Hip starts Dec 7: end this one before it." });
  });

  it("cancel removes a block only while nothing of it is logged", () => {
    expect(cancelRehab(settings, "knee", [monday])).toEqual({ refused: "Knee rehab has logged sessions: end it instead." });
    const r = cancelRehab(settings, "knee", []);
    expect("settings" in r && r.settings.rehab).toEqual({ programs: [] });
  });
});
