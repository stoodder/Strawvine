/**
 * The day's save (`useSaveDay`): the day's first Zone 2 value saved without a machine gets the one the day shows (the
 * last one used), on the device — so it shows at once, offline too (SPEC §3.5).
 */
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { emptyDayLog } from "../../shared/empty";
import type { DayLog } from "../../shared/schemas";

const sync = vi.hoisted(() => ({ days: [] as DayLog[], enqueue: vi.fn() }));
vi.mock("../components/Toast", () => ({ showToast: vi.fn(() => 0) }));
vi.mock("./sync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./sync")>()),
  currentData: () => ({ days: sync.days }),
  enqueue: sync.enqueue,
}));

const { useSaveDay } = await import("./store");

const rowed = (date: string, p: Partial<DayLog> = {}): DayLog => ({
  ...emptyDayLog(date),
  zone2Done: true,
  zone2Minutes: 30,
  zone2Machine: "row",
  ...p,
});

beforeEach(() => {
  sync.enqueue.mockClear();
  sync.days = [rowed("2026-11-02")];
});

describe("useSaveDay and the Zone 2 machine", () => {
  const save = () => renderHook(() => useSaveDay()).result.current;
  const sent = () => sync.enqueue.mock.calls.map(([op]) => op.patch);

  it("adds the last machine used to the day's first Zone 2 value", () => {
    save()("2026-11-03", { zone2Done: true, zone2Minutes: 30 });
    expect(sent()).toEqual([{ zone2Done: true, zone2Minutes: 30, zone2Machine: "row" }]);
  });

  it("keeps the day's own machine, chosen before anything was logged", () => {
    sync.days.push({ ...emptyDayLog("2026-11-03"), zone2Machine: "ski" });
    save()("2026-11-03", { zone2Kcal: 320 });
    expect(sent()).toEqual([{ zone2Kcal: 320 }]);
  });

  it("adds nothing to any other patch: a day logged before machines, a machine alone, another field", () => {
    sync.days.push(rowed("2026-11-01", { zone2Machine: null }));
    const s = save();
    s("2026-11-01", { zone2Kcal: 280 });
    s("2026-11-03", { zone2Machine: "elliptical" });
    s("2026-11-03", { steps: 9000 });
    expect(sent()).toEqual([{ zone2Kcal: 280 }, { zone2Machine: "elliptical" }, { steps: 9000 }]);
  });
});
