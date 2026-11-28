import { describe, expect, it } from "vitest";
import { emptyDayLog } from "./empty";
import type { DayLog } from "./schemas";
import {
  normalizeZone2Machine,
  sameZone2Machine,
  shownZone2Machine,
  withZone2Machine,
  zone2Activities,
  zone2Activity,
  zone2Caption,
  zone2Logged,
  zone2MachineFor,
  zone2MachineLabel,
  zone2Machines,
} from "./zone2";

const day = (date: string, p: Partial<DayLog> = {}): DayLog => ({ ...emptyDayLog(date), ...p });
const rode = (date: string, zone2Machine: string | null = null, p: Partial<DayLog> = {}) =>
  day(date, { zone2Done: true, zone2Minutes: 30, zone2Machine, ...p });
/** A day as an older build cached it: no machine (nor reading) at all. */
const legacy = (date: string) => {
  const { zone2Machine: _m, zone2Kcal: _k, ...d } = rode(date);
  return d as DayLog;
};

describe("machine names", () => {
  it("stores the common machines by key, whatever they're called, and the owner's own as typed", () => {
    expect(normalizeZone2Machine("Row")).toBe("row");
    expect(normalizeZone2Machine("  rowing ")).toBe("row");
    expect(normalizeZone2Machine("Cycling")).toBe("bike");
    expect(normalizeZone2Machine("SkiErg")).toBe("ski");
    expect(normalizeZone2Machine("ELLIPTICAL")).toBe("elliptical");
    expect(normalizeZone2Machine("  Assault   bike ")).toBe("Assault bike");
    expect(normalizeZone2Machine("   ")).toBeNull();
    expect(normalizeZone2Machine("\uD83D")).toBeNull(); // half an emoji: the server would refuse it
    // Cut to 40, never through a character.
    const long = normalizeZone2Machine(`${"x".repeat(39)}🚴 bike`)!;
    expect(long).toBe("x".repeat(39));
    expect(normalizeZone2Machine("y".repeat(60))).toHaveLength(40);
  });

  it("compares the owner's names loosely, and names the activity", () => {
    expect(sameZone2Machine("Assault bike", "assault  BIKE")).toBe(true);
    expect(sameZone2Machine("row", "Rowing")).toBe(true);
    expect(sameZone2Machine("row", "ski")).toBe(false);
    expect(zone2MachineLabel("row")).toBe("Row");
    expect(zone2MachineLabel("Assault bike")).toBe("Assault bike");
    expect([null, undefined, "bike", "row", "elliptical", "ski", "Assault bike"].map(zone2Activity)).toEqual([
      "Cycling",
      "Cycling",
      "Cycling",
      "Rowing",
      "Elliptical",
      "Ski erg",
      "Assault bike",
    ]);
  });
});

describe("zone2Logged", () => {
  it("is the check, a duration or a reading", () => {
    expect(zone2Logged(day("2026-11-03"))).toBe(false);
    expect(zone2Logged(day("2026-11-03", { zone2Done: true }))).toBe(true);
    expect(zone2Logged(day("2026-11-03", { zone2Minutes: 0 }))).toBe(true);
    expect(zone2Logged(day("2026-11-03", { zone2Kcal: 320 }))).toBe(true);
    // A machine alone is not Zone 2 logged.
    expect(zone2Logged(day("2026-11-03", { zone2Machine: "row" }))).toBe(false);
  });
});

describe("zone2MachineFor (the machine a day starts on)", () => {
  it("is the machine of the most recent earlier day with Zone 2 logged", () => {
    const days = [
      rode("2026-10-29", "row"),
      rode("2026-10-27", "ski"),
      day("2026-10-31", { zone2Machine: "elliptical" }),
      rode("2026-11-04", "bike"),
    ];
    expect(zone2MachineFor("2026-11-03", days)).toEqual({ machine: "row", from: "2026-10-29" });
    // Only earlier days: not the day itself, nor a later one.
    expect(zone2MachineFor("2026-10-29", days)).toEqual({ machine: "ski", from: "2026-10-27" });
  });

  it("reads a day logged before machines were (null, or no field at all) as the bike", () => {
    expect(zone2MachineFor("2026-11-03", [rode("2026-11-01")])).toEqual({ machine: "bike", from: "2026-11-01" });
    expect(zone2MachineFor("2026-11-03", [legacy("2026-11-02"), rode("2026-10-30", "row")])).toEqual({
      machine: "bike",
      from: "2026-11-02",
    });
  });

  it("is the bike when there is nothing earlier", () => {
    expect(zone2MachineFor("2026-11-03", [])).toEqual({ machine: "bike", from: null });
    expect(zone2MachineFor("2026-11-03", [day("2026-11-01", { zone2Machine: "row" })])).toEqual({ machine: "bike", from: null });
  });
});

describe("zone2Machines (the chips)", () => {
  it("offers the common machines, then the owner's own names used on other days, the most recent first", () => {
    const days = [
      rode("2026-10-20", "Assault bike"),
      rode("2026-10-22", "Stair climber"),
      rode("2026-10-25", "assault BIKE"),
      rode("2026-10-26", "row"),
      day("2026-10-27", { zone2Machine: "Not logged" }), // picked, never logged
      rode("2026-11-03", "Today's own"),
    ];
    expect(zone2Machines(days, "2026-11-03")).toEqual(["bike", "row", "elliptical", "ski", "assault BIKE", "Stair climber"]);
    // The day's own name is not a chip on that day — on any other it is.
    expect(zone2Machines(days, "2026-11-04")).toContain("Today's own");
  });

  it("offers at most three names of the owner's own", () => {
    const days = ["A", "B", "C", "D"].map((n, i) => rode(`2026-10-2${i}`, n));
    expect(zone2Machines(days, "2026-11-03").slice(4)).toEqual(["D", "C", "B"]);
  });
});

describe("shownZone2Machine", () => {
  const last = { machine: "row", from: "2026-11-01" };
  it("is the day's own once logged (none recorded: the bike), else the pick, else the last one", () => {
    expect(shownZone2Machine(rode("2026-11-03", "ski"), "elliptical", last)).toBe("ski");
    expect(shownZone2Machine(rode("2026-11-03"), "elliptical", last)).toBe("bike");
    expect(shownZone2Machine(legacy("2026-11-03"), null, last)).toBe("bike");
    expect(shownZone2Machine(day("2026-11-03"), "elliptical", last)).toBe("elliptical");
    expect(shownZone2Machine(day("2026-11-03"), null, last)).toBe("row");
    // Recorded, then its Zone 2 cleared: still the one it recorded.
    expect(shownZone2Machine(day("2026-11-03", { zone2Machine: "ski" }), null, last)).toBe("ski");
  });
});

describe("withZone2Machine (written with the first Zone 2 value)", () => {
  const empty = day("2026-11-03");
  it("adds the machine to the patch that logs the day's first Zone 2 value: the check, a duration or a reading", () => {
    expect(withZone2Machine(empty, { zone2Done: true, zone2Minutes: 30 }, "row")).toEqual({
      zone2Done: true,
      zone2Minutes: 30,
      zone2Machine: "row",
    });
    expect(withZone2Machine(empty, { zone2Minutes: 25, zone2Done: true }, "Assault bike")).toMatchObject({ zone2Machine: "Assault bike" });
    expect(withZone2Machine(empty, { zone2Kcal: 320 }, "ski")).toEqual({ zone2Kcal: 320, zone2Machine: "ski" });
  });

  it("leaves every other patch alone", () => {
    const p = { zone2Kcal: 300 };
    // Already logged: the machine stays as it is (an older build's day stays the bike).
    expect(withZone2Machine(rode("2026-11-03"), p, "row")).toBe(p);
    // Nothing logged by it (a cleared field, an unchecked dot).
    const cleared = { zone2Minutes: null };
    expect(withZone2Machine(empty, cleared, "row")).toBe(cleared);
    expect(withZone2Machine(empty, { zone2Done: false }, "row")).toEqual({ zone2Done: false });
    // Not about Zone 2 at all.
    expect(withZone2Machine(empty, { steps: 9000 }, "row")).toEqual({ steps: 9000 });
    // A machine of its own.
    expect(withZone2Machine(empty, { zone2Done: true, zone2Machine: "ski" }, "row")).toEqual({ zone2Done: true, zone2Machine: "ski" });
  });
});

describe("zone2Caption", () => {
  const base = { date: "2026-11-03", today: "2026-11-03" };
  it("says the machine is the last one, and when", () => {
    expect(zone2Caption({ ...base, machine: "row", last: { machine: "row", from: "2026-10-29" } })).toBe("Same as last time · Thu");
    expect(zone2Caption({ ...base, machine: "row", last: { machine: "row", from: "2026-10-27" } })).toBe("Same as last time · Oct 27");
    expect(zone2Caption({ ...base, date: "2027-01-04", machine: "row", last: { machine: "row", from: "2026-12-20" } })).toBe(
      "Same as last time · Dec 20, 2026",
    );
  });

  it("says another one is a choice, and the default without a history", () => {
    expect(zone2Caption({ ...base, machine: "ski", last: { machine: "row", from: "2026-10-29" } })).toBe("Your choice today");
    expect(zone2Caption({ ...base, date: "2026-11-02", machine: "ski", last: { machine: "row", from: "2026-10-29" } })).toBe(
      "Your choice that day",
    );
    expect(zone2Caption({ ...base, machine: "bike", last: { machine: "bike", from: null } })).toBe("Bike unless you pick another");
    expect(zone2Caption({ ...base, machine: "row", last: { machine: "bike", from: null } })).toBe("Your choice today");
    expect(zone2Caption({ ...base, machine: "row", last: { machine: "row", from: "2026-10-29" }, naming: true })).toBe("Name it below");
  });
});

describe("zone2Activities (the check-in)", () => {
  it("names each activity once, the most days first, then the most recent; no machine recorded is cycling", () => {
    const days = [
      rode("2026-10-27", "row"),
      legacy("2026-10-28"),
      rode("2026-10-29", "Row"),
      rode("2026-10-30", "ski"),
      rode("2026-10-31", "row"),
    ];
    expect(zone2Activities(days)).toEqual(["Rowing", "Ski erg", "Cycling"]);
    expect(zone2Activities([rode("2026-10-27", "ski"), rode("2026-10-28", "Assault bike")])).toEqual(["Assault bike", "Ski erg"]);
    expect(zone2Activities([])).toEqual([]);
  });
});
