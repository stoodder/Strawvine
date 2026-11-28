import { describe, expect, it } from "vitest";
import { emptyDayLog } from "./empty";
import type { DayLog } from "./schemas";
import {
  normalizeZone2Machine,
  sameZone2Machine,
  fillZone2Machine,
  shownZone2Machine,
  zone2Activities,
  zone2Activity,
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

describe("zone2Machines (the options)", () => {
  it("offers the common machines, then the owner's own names: the most days used first, then the most recent", () => {
    const days = [
      rode("2026-10-20", "Assault bike"),
      rode("2026-10-22", "Stair climber"),
      rode("2026-10-25", "assault-BIKE"),
      rode("2026-10-26", "row"),
      rode("2026-10-28", "Rowing machine"), // a common one by another name
      day("2026-10-27", { zone2Machine: "Not logged" }), // chosen, never logged
      rode("2026-11-03", "Today's own"),
    ];
    expect(zone2Machines(days, "2026-11-03")).toEqual(["bike", "row", "elliptical", "ski", "assault-BIKE", "Today's own", "Stair climber"]);
  });

  it("folds spellings by case, spacing and punctuation, keeping the most recent one", () => {
    const days = [rode("2026-10-20", "Assault bike"), rode("2026-10-21", "ASSAULT  BIKE"), rode("2026-10-22", "Assault-Bike.")];
    expect(zone2Machines(days, "2026-11-03").slice(4)).toEqual(["Assault-Bike."]);
    expect(sameZone2Machine("AssaultBike", "assault bike")).toBe(true);
    expect(sameZone2Machine("Ski-Erg", "ski")).toBe(true);
  });

  it("offers every name used in the last 180 days, even once; not older ones", () => {
    const days = ["A", "B", "C", "D", "E"].map((n, i) => rode(`2026-10-2${i}`, n));
    expect(zone2Machines(days, "2026-11-03").slice(4)).toEqual(["E", "D", "C", "B", "A"]);
    const old = [rode("2026-05-07", "Old"), rode("2026-05-08", "Recent enough")];
    // The last 180 days are 2026-11-03 and the 179 before it.
    expect(zone2Machines(old, "2026-11-03").slice(4)).toEqual(["Recent enough"]);
    expect(zone2Machines(old, "2026-11-02").slice(4)).toEqual(["Recent enough", "Old"]);
  });
});

describe("shownZone2Machine", () => {
  const last = { machine: "row", from: "2026-11-01" };
  it("is the day's own; with Zone 2 logged and none recorded, the bike; else the last one", () => {
    expect(shownZone2Machine(rode("2026-11-03", "ski"), last)).toBe("ski");
    expect(shownZone2Machine(rode("2026-11-03"), last)).toBe("bike");
    expect(shownZone2Machine(legacy("2026-11-03"), last)).toBe("bike");
    expect(shownZone2Machine(day("2026-11-03"), last)).toBe("row");
    // Chosen with nothing logged, or recorded and its Zone 2 cleared: the one it recorded.
    expect(shownZone2Machine(day("2026-11-03", { zone2Machine: "ski" }), last)).toBe("ski");
  });
});

describe("fillZone2Machine (the day's first Zone 2 value carries a machine)", () => {
  const empty = day("2026-11-03");
  it("adds the machine to the patch that logs the day's first Zone 2 value: the check, a duration or a reading", () => {
    expect(fillZone2Machine(empty, { zone2Done: true, zone2Minutes: 30 }, "row")).toEqual({
      zone2Done: true,
      zone2Minutes: 30,
      zone2Machine: "row",
    });
    expect(fillZone2Machine(empty, { zone2Minutes: 25, zone2Done: true }, "Assault bike")).toMatchObject({ zone2Machine: "Assault bike" });
    expect(fillZone2Machine(empty, { zone2Kcal: 320 }, "ski")).toEqual({ zone2Kcal: 320, zone2Machine: "ski" });
    // No day yet (nothing logged on it at all), or one cached by an older build.
    expect(fillZone2Machine(undefined, { zone2Done: true }, "row")).toEqual({ zone2Done: true, zone2Machine: "row" });
    const { zone2Machine: _m, zone2Kcal: _k, ...old } = empty;
    expect(fillZone2Machine(old as DayLog, { zone2Minutes: 30 }, "row")).toEqual({ zone2Minutes: 30, zone2Machine: "row" });
  });

  it("leaves every other patch alone", () => {
    const p = { zone2Kcal: 300 };
    // Already logged without a machine: logged before machines were, it stays the bike.
    expect(fillZone2Machine(rode("2026-11-03"), p, "row")).toBe(p);
    // The day has its own (chosen with nothing logged yet): that one stands.
    const minutes = { zone2Minutes: 30, zone2Done: true };
    expect(fillZone2Machine(day("2026-11-03", { zone2Machine: "ski" }), minutes, "row")).toBe(minutes);
    // Nothing logged by it (a cleared field, an unchecked dot).
    const cleared = { zone2Minutes: null };
    expect(fillZone2Machine(empty, cleared, "row")).toBe(cleared);
    expect(fillZone2Machine(empty, { zone2Done: false }, "row")).toEqual({ zone2Done: false });
    // Not about Zone 2 at all; a skip is not Zone 2 logged.
    expect(fillZone2Machine(empty, { steps: 9000 }, "row")).toEqual({ steps: 9000 });
    expect(fillZone2Machine(empty, { zone2Skipped: true }, "row")).toEqual({ zone2Skipped: true });
    // A machine of its own (or one cleared on purpose).
    expect(fillZone2Machine(empty, { zone2Done: true, zone2Machine: "ski" }, "row")).toEqual({ zone2Done: true, zone2Machine: "ski" });
    expect(fillZone2Machine(empty, { zone2Done: true, zone2Machine: null }, "row")).toEqual({ zone2Done: true, zone2Machine: null });
  });
});

describe("zone2Activities (the check-in)", () => {
  it("names each activity once, the most days first, then the most recent", () => {
    const days = [
      rode("2026-10-27", "row"),
      rode("2026-10-29", "Row"),
      rode("2026-10-30", "ski"),
      rode("2026-10-31", "row"),
      rode("2026-11-01", "bike"),
    ];
    expect(zone2Activities(days)).toEqual(["Rowing", "Cycling", "Ski erg"]);
    expect(zone2Activities([rode("2026-10-27", "ski"), rode("2026-10-28", "Assault bike")])).toEqual(["Assault bike", "Ski erg"]);
    expect(zone2Activities([rode("2026-10-27", "Assault bike"), rode("2026-10-28", "assault-bike")])).toEqual(["assault-bike"]);
    expect(zone2Activities([])).toEqual([]);
  });

  it("names nothing for a day with no machine recorded (logged before machines were)", () => {
    expect(zone2Activities([rode("2026-10-27", "row"), legacy("2026-10-28"), rode("2026-10-29")])).toEqual(["Rowing"]);
    // A week of such days names no activity at all.
    expect(zone2Activities([legacy("2026-10-28"), rode("2026-10-29")])).toEqual([]);
  });
});
