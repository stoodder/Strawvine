import { describe, expect, it } from "vitest";
import { defaultSettings } from "./defaults";
import { checklist, closedDates, type AppData } from "./gamify";
import {
  emptyDayLog,
  type Block,
  type BlockExercise,
  type DayLog,
  type Exercise,
  type MaxEntry,
  type RehabProgram,
  type Session,
  type SetEntry,
} from "./schemas";
import {
  bringBack,
  currentSection,
  dayComplete,
  daySections,
  EXTRA_SESSION_LABEL,
  holdsStrength,
  markRestNotToday,
  restoreSkips,
  scopeState,
  skipSection,
  strengthSkipped,
  subsectionState,
  type DaySection,
} from "./sections";
import { blankSet, buildSession, buildSessionFrom, resetStrength, sessionCounts, sessionVolume, strengthCounts } from "./session";

const ids = { bench: 1, deadlift: 2, backSquat: 3, frontSquat: 4, strictPress: 5 };
const MWF = [false, true, false, true, false, true, false];
const knee: RehabProgram = { id: "knee", name: "Knee rehab", start: "2026-11-02", weeks: 6, days: MWF, carry: "last" };
// Strength from Mon 2026-11-02; metcon Mon–Sat, Zone 2 Mon–Fri (the defaults); knee rehab Mon/Wed/Fri.
const settings = { ...defaultSettings(ids, "2026-11-01"), onboarded: true, rehab: { programs: [knee] } };
const exercises: Exercise[] = [
  { id: 1, name: "Bench press", category: "primary", tracksMax: true, measure: "reps", weighted: true, archived: false },
  { id: 2, name: "Deadlift", category: "primary", tracksMax: true, measure: "reps", weighted: true, archived: false },
  { id: 10, name: "Dumbbell fly", category: "accessory", tracksMax: false, measure: "reps", weighted: true, archived: false },
  { id: 12, name: "Hanging knee raise", category: "core", tracksMax: false, measure: "reps", weighted: false, archived: false },
  { id: 13, name: "Weighted plank", category: "core", tracksMax: false, measure: "seconds", weighted: true, archived: false },
  { id: 22, name: "Step-down", category: "accessory", tracksMax: false, measure: "reps", weighted: true, archived: false },
];
const maxEntries: MaxEntry[] = [
  { id: 1, exerciseId: 1, date: "2026-11-01", valueLb: 225, source: "initial", note: null, createdAt: "2026-11-01T00:00:00Z" },
];

const MON = "2026-11-09";
const TUE = "2026-11-10";
const WED = "2026-11-11";
const SUN = "2026-11-15";

const open = (id: string): SetEntry => blankSet({ id, targetReps: 10, targetWeight: 20 });
const done = (id: string): SetEntry => blankSet({ id, targetReps: 10, targetWeight: 20, reps: 10, weight: 20, done: true });
const ex = (exerciseId: number, sets: SetEntry[], o: Partial<BlockExercise> = {}): BlockExercise => ({
  exerciseId,
  measure: "reps",
  sets,
  ...o,
});
const mainBlock = (sets: SetEntry[], o: Partial<Block> = {}): Block => ({ id: "P", kind: "primary", exercises: [ex(1, sets)], ...o });
const acc = (id: string, exs: BlockExercise[], o: Partial<Block> = {}): Block => ({ id, kind: "accessory", exercises: exs, ...o });
const rehab = (id: string, exs: BlockExercise[]): Block => ({ id, kind: "rehab", exercises: exs, rehab: "knee" });
const session = (date: string, blocks: Block[], o: Partial<Session> = {}): Session => ({
  date,
  label: "Push",
  cycle: 1,
  week: 2,
  deload: false,
  primaryMaxLb: 225,
  blocks,
  notes: "",
  completedAt: null,
  ...o,
});
/** A Monday: main lift, an accessory, a core superset, knee rehab. */
const full = (o: { main?: SetEntry[]; acc?: SetEntry[]; core?: SetEntry[]; rehab?: SetEntry[] } = {}) =>
  session(MON, [
    mainBlock(o.main ?? [open("p1"), open("p2")]),
    acc("A", [ex(10, o.acc ?? [open("a1"), open("a2")])]),
    acc("C", [ex(12, o.core ?? [open("c1")]), ex(13, [open("c2")], { measure: "seconds" })], { section: "core" }),
    rehab("R", [ex(22, o.rehab ?? [open("r1"), open("r2")])]),
  ]);
const data = (sessions: Session[] = [], days: DayLog[] = []) => ({ settings, exercises, maxEntries, sessions, days });
const keys = (xs: DaySection[]) => xs.map((s) => `${s.key}:${s.status}`);
const at = (xs: DaySection[], key: DaySection["key"]) => xs.find((s) => s.key === key)!;

describe("daySections", () => {
  it("a full Monday, in the day's order: Metcon, Strength, Rehab, Zone 2 — all to do, counted", () => {
    const s = full();
    const xs = daySections(MON, data([s]), { today: MON });
    expect(keys(xs)).toEqual(["metcon:todo", "strength:todo", "rehab:todo", "zone2:todo"]);
    expect(at(xs, "strength").counts).toEqual({ done: 0, total: 6 });
    expect(at(xs, "rehab")).toMatchObject({
      counts: { done: 0, total: 2 },
      planned: true,
      added: false,
      rehab: { id: "knee", program: knee },
    });
    expect(at(xs, "metcon")).toMatchObject({ counts: { done: 0, total: 1 }, planned: true });
    expect(currentSection(xs)?.key).toBe("metcon");
  });

  it("an unsaved day reads its draft: the strength plan and the rehab draft carried from the last session", () => {
    const monday = full({ rehab: [done("r1"), done("r2")] });
    const xs = daySections(WED, data([monday]), { today: WED });
    expect(keys(xs)).toEqual(["metcon:todo", "strength:todo", "rehab:todo", "zone2:todo"]);
    expect(at(xs, "rehab").counts).toEqual({ done: 0, total: 2 });
    expect(at(xs, "strength").counts.total).toBe(
      buildSession(WED, data([monday])).blocks.reduce((n, b) => n + b.exercises[0]!.sets.length, 0),
    );
    // The first rehab session (nothing to carry from) is not set up: it has no Not today and counts for nothing.
    const first = daySections("2026-11-02", data([]), { today: "2026-11-02" });
    expect(at(first, "rehab")).toMatchObject({ empty: true, status: "todo" });
  });

  it("rehab not set up yet (no exercises) on a past planned day reads Not set up — never Not done, never a miss", () => {
    const past = daySections("2026-11-02", data([]), { today: MON });
    expect(at(past, "rehab")).toMatchObject({ empty: true, status: "notSetUp" });
    // A saved rehab block emptied of exercises can't be (the schema needs one); a day it held with
    // exercises, nothing logged, is a real Not done.
    const held = session("2026-11-04", [rehab("R", [ex(22, [open("r1")])])], { label: "Training" });
    expect(at(daySections("2026-11-04", data([held]), { today: MON }), "rehab").status).toBe("notDone");
    // Left out of "day complete": the rest done is a complete day.
    const sections = daySections("2026-11-02", data([], [{ ...emptyDayLog("2026-11-02"), metconDone: true, zone2Done: true }]), {
      today: MON,
    });
    const others = sections.filter((s) => s.key !== "strength");
    expect(keys(others)).toEqual(["metcon:done", "rehab:notSetUp", "zone2:done"]);
    expect(dayComplete(others)).toBe(true);
    // A preview is still Planned.
    expect(at(daySections("2026-11-02", data([]), { today: "2026-11-01" }), "rehab").status).toBe("planned");
  });

  it("statuses: in progress, done (Strength finished; rehab all logged; checks), Not today, a past day's Not done, a preview's Planned", () => {
    const going = full({ main: [done("p1"), open("p2")], rehab: [done("r1"), open("r2")] });
    expect(keys(daySections(MON, data([going]), { today: MON }))).toEqual([
      "metcon:todo",
      "strength:progress",
      "rehab:progress",
      "zone2:todo",
    ]);
    expect(currentSection(daySections(MON, data([going]), { today: MON }))?.key).toBe("strength");

    const finished = { ...full({ main: [done("p1"), done("p2")], rehab: [done("r1"), done("r2")] }), completedAt: "2026-11-09T18:00:00Z" };
    const day = { ...emptyDayLog(MON), metconDone: true, zone2Skipped: true };
    const xs = daySections(MON, data([finished], [day]), { today: MON });
    expect(keys(xs)).toEqual(["metcon:done", "strength:done", "rehab:done", "zone2:skipped"]);
    expect(dayComplete(xs)).toBe(true);

    // Every strength set logged is not finished: only Finish (completedAt) is.
    const allLogged = full({ main: [done("p1"), done("p2")], acc: [done("a1"), done("a2")], core: [done("c1")] });
    expect(at(daySections(MON, data([allLogged]), { today: MON }), "strength").status).toBe("progress");

    expect(keys(daySections(MON, data([full()]), { today: TUE }))).toEqual([
      "metcon:notDone",
      "strength:notDone",
      "rehab:notDone",
      "zone2:notDone",
    ]);
    const preview = daySections(WED, data([]), { today: MON });
    expect(keys(preview)).toEqual(["metcon:planned", "strength:planned", "rehab:planned", "zone2:planned"]);
    expect(dayComplete(preview)).toBe(false);
  });

  it("metcon and Zone 2: something entered is in progress; a skip is Not today; a check beats a skip", () => {
    const d = (o: Partial<DayLog>) => [{ ...emptyDayLog(MON), ...o }];
    expect(at(daySections(MON, data([], d({ metconScore: "4:12" })), { today: MON }), "metcon").status).toBe("progress");
    expect(at(daySections(MON, data([], d({ zone2Minutes: 30 })), { today: MON }), "zone2").status).toBe("progress");
    expect(at(daySections(MON, data([], d({ metconSkipped: true })), { today: MON }), "metcon").status).toBe("skipped");
    expect(at(daySections(MON, data([], d({ metconSkipped: true, metconDone: true })), { today: MON }), "metcon").status).toBe("done");
    // A day cached by an older build lacks the new fields: they read as false / null.
    const old = { ...emptyDayLog(MON) } as Partial<DayLog>;
    delete old.metconSkipped;
    delete old.zone2Skipped;
    delete old.zone2Machine;
    expect(keys(daySections(MON, data([], [old as DayLog]), { today: MON })).slice(0, 1)).toEqual(["metcon:todo"]);
  });

  it("a rest day holds nothing — until something is added (view state) or logged (data wins)", () => {
    expect(daySections(SUN, data(), { today: SUN })).toEqual([]);
    const added = daySections(SUN, data(), { today: SUN, added: ["zone2", "metcon"] });
    expect(keys(added)).toEqual(["metcon:todo", "zone2:todo"]);
    expect(added.every((s) => s.added && !s.planned)).toBe(true);
    const logged = daySections(SUN, data([], [{ ...emptyDayLog(SUN), zone2Done: true, zone2Machine: "row" }]), { today: SUN });
    expect(keys(logged)).toEqual(["zone2:done"]);
    expect(at(logged, "zone2")).toMatchObject({ added: true, planned: false });
    // Add to the day → Strength saves an extra session; Rehab on a non-rehab day while a block is in force.
    const extra = session(SUN, [], { label: EXTRA_SESSION_LABEL });
    expect(keys(daySections(SUN, data([extra]), { today: SUN }))).toEqual(["strength:todo"]);
    expect(keys(daySections(SUN, data([]), { today: SUN, added: ["rehab"] }))).toEqual(["rehab:todo"]);
  });

  it("a rehab-only session: Rehab and no Strength on a rest day; on a lifting day Strength is the plan's, still to do", () => {
    const sat = "2026-11-14";
    const onlyRehab = session(sat, [rehab("R", [ex(22, [done("r1")])])], {
      label: "Training",
      cycle: null,
      week: null,
      primaryMaxLb: null,
    });
    expect(holdsStrength(onlyRehab)).toBe(false);
    // Saturday: metcon only by plan; the logged rehab shows though not planned.
    expect(keys(daySections(sat, data([onlyRehab]), { today: sat }))).toEqual(["metcon:todo", "rehab:done"]);
    const tueRehab = { ...onlyRehab, date: TUE };
    expect(at(daySections(TUE, data([tueRehab]), { today: TUE }), "strength")).toMatchObject({
      status: "todo",
      planned: true,
      counts: { done: 0, total: 0 },
    });
    // Every session saved before rehab existed holds strength — as long as it holds anything of it
    // (a block, finished, moved, an extra session). A document with no block at all and none of
    // those (notes only: what Reset to plan keeps on a day whose plan has no strength) holds none:
    // a Strength section there would have nothing in it and could never be done.
    expect(holdsStrength(session(SUN, [mainBlock([])]))).toBe(true);
    expect(holdsStrength(session(SUN, [acc("A", [ex(10, [open("a1")])])]))).toBe(true);
    expect(holdsStrength(session(SUN, [], { label: EXTRA_SESSION_LABEL }))).toBe(true);
    expect(holdsStrength(session(SUN, [], { completedAt: "2026-11-15T18:00:00Z" }))).toBe(true);
    expect(holdsStrength(session(SUN, [], { plannedFor: "2026-11-16" }))).toBe(true);
    expect(holdsStrength(session(SUN, []))).toBe(false);
  });

  it("a rest day holding a notes-only document (Reset to plan kept the notes): no Strength section", () => {
    // An extra session on Sunday, reset with nothing logged: the notes stay, and nothing else.
    const extra = session(SUN, [acc("A", [ex(10, [open("a1")])])], { label: EXTRA_SESSION_LABEL, notes: "knee sore" });
    const notesOnly = resetStrength(extra, data())!;
    expect(notesOnly).toMatchObject({ blocks: [], notes: "knee sore" });
    expect(holdsStrength(notesOnly)).toBe(false);
    expect(daySections(SUN, data([notesOnly]), { today: SUN }).map((s) => s.key)).not.toContain("strength");
    expect(daySections(SUN, data([notesOnly]), { today: "2026-11-16" })).toEqual([]);
    // On a lifting day Strength is there anyway: the plan's.
    const mon = { ...notesOnly, date: MON };
    expect(at(daySections(MON, data([mon]), { today: MON }), "strength")).toMatchObject({ planned: true, status: "todo" });
  });

  it("an ended rehab block leaves the day when nothing of it was logged; logged rehab stays (data wins)", () => {
    const ended = { ...settings, rehab: { programs: [{ ...knee, end: "2026-11-08" }] } };
    const draftSaved = full();
    expect(daySections(MON, { ...data([draftSaved]), settings: ended }, { today: MON }).map((s) => s.key)).not.toContain("rehab");
    const logged = full({ rehab: [done("r1"), open("r2")] });
    expect(keys(daySections(MON, { ...data([logged]), settings: ended }, { today: MON }))).toContain("rehab:progress");
    // A block settings no longer hold: shown only with something logged.
    const gone = { ...settings, rehab: { programs: [] } };
    expect(daySections(MON, { ...data([logged]), settings: gone }, { today: MON }).find((s) => s.key === "rehab")).toMatchObject({
      rehab: { id: "knee", program: null },
      added: true,
    });
  });

  it("a plan finished early is done on its own day (Done Sun), as its checklist says", () => {
    const moved = { ...buildSessionFrom(MON, "2026-11-08", data()), completedAt: "2026-11-08T12:00:00Z" };
    const xs = daySections(MON, data([moved]), { today: MON });
    expect(at(xs, "strength")).toMatchObject({ status: "done", doneOn: "2026-11-08" });
    const item = checklist(MON, undefined, undefined, settings, { doneEarly: moved }).find((i) => i.key === "lift")!;
    expect(item.done).toBe(true);
    // The day holding the moved session expects a lift (planned), even on a rest day.
    expect(at(daySections("2026-11-08", data([moved]), { today: MON }), "strength")).toMatchObject({ planned: true, status: "done" });
  });
});

describe("dayComplete", () => {
  const s = (key: DaySection["key"], status: DaySection["status"], empty = false): DaySection => ({
    key,
    status,
    counts: { done: 0, total: 0 },
    planned: true,
    added: false,
    empty,
  });
  it("every section done or Not today, at least one done; rehab not set up is left out", () => {
    expect(dayComplete([s("metcon", "done"), s("zone2", "skipped")])).toBe(true);
    expect(dayComplete([s("metcon", "skipped"), s("zone2", "skipped")])).toBe(false);
    expect(dayComplete([s("metcon", "done"), s("strength", "progress")])).toBe(false);
    expect(dayComplete([s("metcon", "done"), s("rehab", "todo", true)])).toBe(true);
    expect(dayComplete([s("rehab", "todo", true)])).toBe(false);
    expect(dayComplete([])).toBe(false);
    expect(dayComplete([s("metcon", "done"), s("zone2", "notDone")])).toBe(false);
  });
});

describe("subsections, Not today and Bring back (stored as the existing skip flags)", () => {
  it("counts each subsection and says what it can do", () => {
    const s = full({ acc: [done("a1"), open("a2")] });
    expect(subsectionState(s, "main")).toMatchObject({ status: "todo", counts: { done: 0, total: 2 }, canSkip: true });
    expect(subsectionState(s, "accessories")).toMatchObject({ status: "progress", counts: { done: 1, total: 2 }, canSkip: false });
    expect(subsectionState(s, "core")).toMatchObject({ status: "todo", exercises: 2, counts: { done: 0, total: 2 }, canSkip: true });
    expect(scopeState(s, { rehab: "knee" })).toMatchObject({ status: "todo", canSkip: true });
    expect(scopeState(s, "strength")).toMatchObject({ status: "progress", canSkip: false });
    expect(subsectionState(session(MON, [mainBlock([])]), "core")).toMatchObject({ status: "empty", canSkip: false });
  });

  it("Core: not today — every core exercise skipped; the old reading of the flags (counts, volume) holds; Bring back clears them", () => {
    const s = full();
    const skipped = skipSection(s, "core");
    expect(skipped.blocks[2]!.exercises.every((e) => e.skipped === true)).toBe(true);
    expect(skipped.blocks[0]).toBe(s.blocks[0]);
    expect(skipped.blocks[1]).toBe(s.blocks[1]);
    expect(subsectionState(skipped, "core")).toMatchObject({ status: "skipped", canSkip: false, anySkipped: true });
    expect(sessionCounts(skipped)).toEqual({ done: 0, total: 6 });
    expect(strengthCounts(skipped)).toEqual({ done: 0, total: 4 });
    const back = bringBack(skipped, "core");
    expect(back).toEqual(s);
    expect(JSON.stringify(back)).toBe(JSON.stringify(s));
    expect(bringBack(s, "core")).toBe(s);
  });

  it("is refused once something in it is logged, and for Strength once finished", () => {
    const s = full({ core: [done("c1")] });
    expect(skipSection(s, "core")).toBe(s);
    expect(skipSection(s, "strength")).toBe(s);
    const finished = { ...full(), completedAt: "2026-11-09T18:00:00Z" };
    expect(skipSection(finished, "accessories")).toBe(finished);
    expect(skipSection(finished, { rehab: "knee" })).not.toBe(finished);
  });

  it("Strength: not today skips the main lift's block and every accessory and core exercise — not rehab", () => {
    const s = full();
    const skipped = skipSection(s, "strength");
    expect(skipped.blocks[0]!.skipped).toBe(true);
    expect(skipped.blocks.slice(1, 3).every((b) => b.exercises.every((e) => e.skipped))).toBe(true);
    expect(skipped.blocks[3]).toBe(s.blocks[3]);
    expect(strengthSkipped(skipped)).toBe(true);
    expect(at(daySections(MON, data([skipped]), { today: MON }), "strength").status).toBe("skipped");
    expect(sessionVolume(skipped)).toBe(0);
    // Next week's pre-fill carries them un-skipped, as an older build would.
    const next = buildSession("2026-11-16", data([skipped]));
    expect(next.blocks.filter((b) => b.kind === "accessory").flatMap((b) => b.exercises.map((e) => e.skipped))).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(next.blocks.some((b) => b.kind === "rehab")).toBe(false);
  });

  it("Rehab: not today, then Bring back; Undo restores exactly the flags there were (an exercise skipped on its own stays skipped)", () => {
    const s = session(MON, [rehab("R", [ex(22, [open("r1")]), ex(10, [open("r2")], { skipped: true })])]);
    const skipped = skipSection(s, { rehab: "knee" });
    expect(skipped.blocks[0]!.exercises.map((e) => e.skipped)).toEqual([true, true]);
    expect(bringBack(skipped, { rehab: "knee" }).blocks[0]!.exercises.map((e) => e.skipped)).toEqual([undefined, undefined]);
    // Undo, on the session as it is now (another device logged elsewhere meanwhile).
    const later = { ...skipped, notes: "from the other phone" };
    const undone = restoreSkips(later, s, { rehab: "knee" });
    expect(undone.blocks[0]!.exercises.map((e) => e.skipped)).toEqual([undefined, true]);
    expect(undone.notes).toBe("from the other phone");
    // Undo of a Bring back puts the skips back.
    expect(restoreSkips(bringBack(skipped, { rehab: "knee" }), skipped, { rehab: "knee" })).toEqual(skipped);
  });

  it("Undo of Strength's Not today restores the main block's flag and the exercises', by block id", () => {
    const s = full();
    const undone = restoreSkips(skipSection(s, "strength"), s, "strength");
    expect(undone).toEqual(s);
  });

  it("Finish — mark the rest not today: every strength exercise with nothing logged; partly logged ones stay", () => {
    const s = full({ main: [done("p1"), open("p2")], acc: [open("a1")] });
    const marked = markRestNotToday(s);
    expect(marked.blocks[0]).toBe(s.blocks[0]);
    expect(marked.blocks[1]!.exercises[0]!.skipped).toBe(true);
    expect(marked.blocks[2]!.exercises.map((e) => e.skipped)).toEqual([true, true]);
    expect(marked.blocks[3]).toBe(s.blocks[3]);
    expect(strengthCounts(marked)).toEqual({ done: 1, total: 2 });
    const untouched = markRestNotToday(full());
    expect(untouched.blocks[0]!.skipped).toBe(true);
    expect(markRestNotToday(marked)).toBe(marked);
  });
});

describe("rehab outside the lift, the streak and closed days", () => {
  it("a rehab-only session neither plans nor completes the lift; a closed day stays closed only by its checklist", () => {
    const sun: DayLog = { ...emptyDayLog(SUN), weightLb: 200, calories: 2500, steps: 16000 };
    const onlyRehab = session(SUN, [rehab("R", [ex(22, [done("r1")])])], { label: "Training" });
    expect(checklist(SUN, sun, onlyRehab, settings).map((i) => i.key)).not.toContain("lift");
    const all: AppData = { settings, exercises, maxEntries, days: [sun], sessions: [onlyRehab] };
    expect([...closedDates(all, SUN)]).toEqual([SUN]);
    const tue: DayLog = { ...emptyDayLog(TUE), weightLb: 200, calories: 2500, steps: 16000, zone2Done: true, metconDone: true };
    const tueRehab = { ...onlyRehab, date: TUE };
    const lift = checklist(TUE, tue, tueRehab, settings).find((i) => i.key === "lift")!;
    expect(lift.done).toBe(false);
    expect([...closedDates({ ...all, days: [tue], sessions: [tueRehab] }, TUE)]).toEqual([]);
  });
});
