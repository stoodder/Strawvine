import { describe, expect, it } from "vitest";
import { liftSub, type LiftSummary } from "./Checklist";

// 2026-11-02 is a Monday; 2026-10-28 a Wednesday; 2026-11-01 a Sunday.
const base: LiftSummary = {
  href: "/train",
  label: "Legs",
  primaryName: "Back squat",
  setsDone: 0,
  setsTotal: 12,
  date: "2026-11-02",
  today: "2026-11-02",
};

describe("liftSub", () => {
  it("reads as planned", () => {
    expect(liftSub(base)).toBe("Legs · Back squat");
    expect(liftSub({ ...base, label: undefined, primaryName: null })).toBe("Session");
  });

  it("says a session moved here, lift first (so truncation keeps it), then done today once finished", () => {
    expect(liftSub({ ...base, plannedFor: "2026-10-28" })).toBe("Back squat · Wed's Legs, moved here");
    expect(liftSub({ ...base, plannedFor: "2026-10-28", completed: true })).toBe("Back squat · Wed's Legs, done today");
  });

  it("says when the main lift is skipped", () => {
    expect(liftSub({ ...base, mainSkipped: true })).toBe("Back squat skipped · Legs");
    expect(liftSub({ ...base, mainSkipped: true, plannedFor: "2026-10-28" })).toBe("Back squat skipped · Wed's Legs, moved here");
  });

  it("credits a plan done early on its own day", () => {
    expect(liftSub({ ...base, elsewhere: "2026-11-01", completed: true })).toBe("Done Sun · Legs · Back squat");
    expect(liftSub({ ...base, elsewhere: "2026-11-01" })).toBe("Moved to Sun · Legs · Back squat");
  });
});
