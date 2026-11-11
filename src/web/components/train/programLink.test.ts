/**
 * What Train says about the program around a session: the header link's label in every cycle
 * state (it is never missing), and what stands in for a main lift the day has no sets for.
 */
import { describe, expect, it } from "vitest";
import { defaultSettings } from "../../../shared/defaults";
import type { MaxEntry, Program } from "../../../shared/schemas";
import { mainLiftNotice, programLinkLabel, programStartSentence } from "./programLink";

const BENCH = 1;
const DEADLIFT = 2;
/** The default five-week program (week 5 is the deload), starting Monday 2026-11-02. */
const program: Program = defaultSettings(
  { bench: BENCH, deadlift: DEADLIFT, backSquat: 3, frontSquat: 4, strictPress: 5 },
  "2026-11-02",
).program;
const max = (exerciseId: number): MaxEntry => ({
  id: exerciseId,
  exerciseId,
  date: "2026-10-01",
  valueLb: 225,
  source: "manual",
  note: null,
  createdAt: "2026-10-01T10:00:00.000Z",
});

describe("programLinkLabel", () => {
  it("says the week in words, with a short form that drops the cycle's length", () => {
    expect(programLinkLabel(program, "2026-11-16", "2026-11-16")).toEqual({
      text: "Week 3 of 5",
      short: "Week 3",
      name: "Program: Week 3 of 5",
      deload: false,
    });
  });

  it("names the deload week (short: Deload) and flags it", () => {
    expect(programLinkLabel(program, "2026-12-02", "2026-12-02")).toEqual({
      text: "Deload week",
      short: "Deload",
      name: "Program: Deload week",
      deload: true,
    });
  });

  it("leads with the cycle from the second one on, in both forms", () => {
    expect(programLinkLabel(program, "2026-12-07", "2026-12-07")).toMatchObject({
      text: "Cycle 2 · Week 1 of 5",
      short: "Cycle 2 · Week 1",
      name: "Program: Cycle 2 · Week 1 of 5",
    });
    expect(programLinkLabel(program, "2027-01-06", "2027-01-06")).toMatchObject({
      text: "Cycle 2 · Deload week",
      short: "Cycle 2 · Deload",
    });
  });

  it("before the first cycle it says when the program starts — never nothing", () => {
    // The day before, a day of the week before, and a preview of a day that is still before it.
    for (const [date, today] of [
      ["2026-11-01", "2026-11-01"],
      ["2026-10-27", "2026-10-27"],
      ["2026-10-30", "2026-10-27"],
    ] as const)
      expect(programLinkLabel(program, date, today)).toEqual({
        text: "Starts Mon Nov 2",
        short: "Starts Mon",
        name: "Program: starts Mon Nov 2",
        deload: false,
      });
  });

  it("a day from before a program that has since started says when it started", () => {
    expect(programLinkLabel(program, "2026-10-20", "2026-11-10")).toMatchObject({
      text: "Started Mon Nov 2",
      short: "Started Mon",
      name: "Program: started Mon Nov 2",
    });
    // The start day itself counts as started.
    expect(programLinkLabel(program, "2026-11-01", "2026-11-02").text).toBe("Started Mon Nov 2");
  });

  it("adds the year when the start isn't in today's", () => {
    const later = { ...program, cycleStartDate: "2027-01-04" };
    expect(programLinkLabel(later, "2026-12-28", "2026-12-28")).toMatchObject({
      text: "Starts Mon Jan 4, 2027",
      short: "Starts Mon",
      name: "Program: starts Mon Jan 4, 2027",
    });
  });

  it("every short form is part of the accessible name, word for word (WCAG 2.5.3)", () => {
    const days = ["2026-10-27", "2026-11-02", "2026-11-16", "2026-12-02", "2026-12-07", "2027-01-06"];
    for (const date of days)
      for (const today of [date, "2027-02-01"]) {
        const label = programLinkLabel(program, date, today);
        expect(label.name.toLowerCase()).toContain(label.short.toLowerCase());
        expect(label.name.toLowerCase()).toContain(label.text.toLowerCase());
      }
  });

  it("a program without weeks still gets a link", () => {
    expect(programLinkLabel({ ...program, weeks: [] }, "2026-11-16", "2026-11-16")).toEqual({
      text: "Program",
      short: "Program",
      name: "Program",
      deload: false,
    });
  });
});

describe("mainLiftNotice", () => {
  const TUE = "2026-11-03"; // Pull: deadlift
  const at = (o: Partial<Parameters<typeof mainLiftNotice>[0]> = {}) =>
    mainLiftNotice({ program, date: TUE, maxEntries: [], hasMainLift: false, ...o });

  it("says nothing while the session has (or the plan would build) its main lift", () => {
    expect(at({ hasMainLift: true })).toBeNull();
    expect(at({ hasMainLift: true, date: "2026-10-27" })).toBeNull();
  });

  it("before the first cycle: the program hasn't started — whether or not the lift has a max", () => {
    const before = "2026-10-27"; // the Tuesday before the start
    expect(at({ date: before, maxEntries: [max(DEADLIFT)] })).toEqual({ kind: "not-started", start: "2026-11-02" });
    expect(at({ date: before })).toEqual({ kind: "not-started", start: "2026-11-02" });
  });

  it("once the cycle runs: the program day's lift needs a max — looked up by the day's lift, not a block", () => {
    expect(at()).toEqual({ kind: "needs-max", exerciseId: DEADLIFT });
    // Another lift's max doesn't count.
    expect(at({ maxEntries: [max(BENCH)] })).toEqual({ kind: "needs-max", exerciseId: DEADLIFT });
    // Monday's lift is the bench press.
    expect(at({ date: "2026-11-02" })).toEqual({ kind: "needs-max", exerciseId: BENCH });
  });

  it("says nothing when the lift has its max (the session lost its main lift: a recalculation is offered instead)", () => {
    expect(at({ maxEntries: [max(DEADLIFT)] })).toBeNull();
  });

  it("says nothing on a day without a main lift (the carry day, a rest day)", () => {
    expect(at({ date: "2026-11-06" })).toBeNull(); // Friday: carries
    expect(at({ date: "2026-11-07" })).toBeNull(); // Saturday
    expect(at({ date: "2026-10-31" })).toBeNull(); // a rest day before the start
  });
});

describe("programStartSentence", () => {
  it("says the weekday and date in full", () => {
    expect(programStartSentence("2026-11-02", "2026-10-27")).toBe("Your program starts Monday, Nov 2.");
    expect(programStartSentence("2027-01-04", "2026-12-28")).toBe("Your program starts Monday, Jan 4, 2027.");
  });

  it("a program that has started since is in the past tense", () => {
    expect(programStartSentence("2026-11-02", "2026-11-10")).toBe("Your program started Monday, Nov 2 — after this day.");
  });
});
