/**
 * Core and the Train without subsections (SPEC §6.5; the training day is behind the `trainDay`
 * flag, off by default). With the flag off, next Monday's pre-fill is exactly what it was before
 * Core existed: the accessories in the order they were done last Monday, the core couplet among
 * them, nothing filed anywhere — so the Reorder sheet moves every block one place, superset letters
 * follow the list. A document that does hold Core (saved by a device with the flag on) reads the
 * same way here: Core as accessories, listed, lettered and moved in stored order, its `section`
 * kept for the device that shows it.
 */
import type { Page } from "@playwright/test";
import { expect, expectSynced, MONDAY, MONDAY_ISO, onboardedOn, serverData, test } from "./helpers";

const NEXT_MONDAY = new Date(2026, 10, 2, 10, 0, 0);
const NEXT_MONDAY_ISO = "2026-11-02";

/** The accessories as the page lists them (each exercise's options button, in page order). */
const pageOrder = (page: Page) =>
  page.locator('[data-control="options"]').evaluateAll((els) => els.map((el) => el.getAttribute("aria-label")!.replace(/ options$/, "")));

const done = (id: string, reps: number) => ({
  id,
  targetReps: reps,
  targetWeight: null,
  reps,
  weight: null,
  done: true,
  amrap: false,
  appliedProgressionLb: null,
});
const open = (id: string, reps: number) => ({
  id,
  targetReps: reps,
  targetWeight: null,
  reps: null,
  weight: null,
  done: false,
  amrap: false,
  appliedProgressionLb: null,
});

async function api(page: Page) {
  const call = async (method: string, path: string, data?: unknown) => {
    const res = await page.request.fetch(path, {
      method,
      headers: { "cache-control": "no-cache" },
      ...(data !== undefined ? { data } : {}),
    });
    expect(res.ok(), `${method} ${path} → ${res.status()}`).toBe(true);
    return res.json();
  };
  const boot = await call("GET", "/api/bootstrap");
  const bench = boot.exercises.find((e: { name: string }) => e.name === "Bench press");
  const make = (name: string, category: string, measure: string) =>
    call("POST", "/api/exercises", { name, category, measure, weighted: false });
  const rows = await make("Rows", "accessory", "reps");
  const plank = await make("Plank", "core", "seconds");
  const hollow = await make("Hollow hold", "core", "seconds");
  const dips = await make("Dips", "accessory", "reps");
  const doc = (date: string, blocks: unknown[], completedAt: string | null) => ({
    date,
    label: "Push",
    cycle: 1,
    week: 1,
    deload: false,
    primaryMaxLb: 225,
    notes: "",
    planSig: null,
    completedAt,
    blocks,
  });
  const main = (sets: unknown[]) => ({
    id: `main-${sets.length}`,
    kind: "primary",
    exercises: [{ exerciseId: bench.id, measure: "reps", sets }],
  });
  return { call, ids: { rows: rows.id, plank: plank.id, hollow: hollow.id, dips: dips.id }, doc, main };
}

test.describe("with the training day off (every device until it launches)", () => {
  test("last Monday's order carries into next Monday: the core couplet stays where it was, and the Reorder sheet moves it", async ({
    page,
  }) => {
    await onboardedOn(page, MONDAY);
    const { call, ids, doc, main } = await api(page);
    // The owner's Monday as it is: a core superset between two accessories.
    await call(
      "PUT",
      `/api/sessions/${MONDAY_ISO}`,
      doc(
        MONDAY_ISO,
        [
          main([done("m1", 6)]),
          { id: "r", kind: "accessory", exercises: [{ exerciseId: ids.rows, measure: "reps", sets: [done("r1", 10)] }] },
          {
            id: "c",
            kind: "accessory",
            exercises: [
              { exerciseId: ids.plank, measure: "seconds", sets: [done("p1", 30)] },
              { exerciseId: ids.hollow, measure: "seconds", sets: [done("h1", 20)] },
            ],
          },
          { id: "d", kind: "accessory", exercises: [{ exerciseId: ids.dips, measure: "reps", sets: [done("d1", 10)] }] },
        ],
        `${MONDAY_ISO}T18:30:00.000Z`,
      ),
    );

    await page.clock.setSystemTime(NEXT_MONDAY);
    await page.goto("/train");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Push/);
    await expectSynced(page);
    expect(await pageOrder(page)).toEqual(["Rows", "Plank", "Hollow hold", "Dips"]);
    await expect(page.getByRole("button", { name: "Manage Superset A" })).toBeVisible();

    await page.getByRole("button", { name: "Reorder workout" }).click();
    const order = page.getByRole("dialog", { name: "Workout order" });
    await order.getByRole("button", { name: "Move Superset A up in workout" }).click();
    await expect(order.getByRole("status")).toHaveText("Superset A moved up · 1 of 3");
    await order.getByRole("button", { name: "Move Dips up in workout" }).click();
    await expect(order.getByRole("status")).toHaveText("Dips moved up · 2 of 3");
    await page.keyboard.press("Escape");
    expect(await pageOrder(page)).toEqual(["Plank", "Hollow hold", "Dips", "Rows"]);
    await expectSynced(page);
    // Saved as this Train shows it, nothing filed under Core.
    const saved = (await serverData(page)).sessions.find((s) => s.date === NEXT_MONDAY_ISO)!;
    expect(saved.blocks.filter((b) => b.kind === "accessory").map((b) => b.exercises.length)).toEqual([2, 1, 1]);
    expect(saved.blocks.some((b) => "section" in b)).toBe(false);
  });

  test("a day holding Core from a device with the flag on: Core reads as accessories, every move one place, letters as listed", async ({
    page,
  }) => {
    await onboardedOn(page, MONDAY);
    const { call, ids, doc, main } = await api(page);
    // That device's pre-fill stored Core last; an exercise was added by hand after it.
    await call(
      "PUT",
      `/api/sessions/${NEXT_MONDAY_ISO}`,
      doc(
        NEXT_MONDAY_ISO,
        [
          main([open("m1", 6)]),
          { id: "r", kind: "accessory", exercises: [{ exerciseId: ids.rows, measure: "reps", sets: [open("r1", 10)] }] },
          { id: "d", kind: "accessory", exercises: [{ exerciseId: ids.dips, measure: "reps", sets: [open("d1", 10)] }] },
          {
            id: "c",
            kind: "accessory",
            section: "core",
            exercises: [
              { exerciseId: ids.plank, measure: "seconds", sets: [open("p1", 30)] },
              { exerciseId: ids.hollow, measure: "seconds", sets: [open("h1", 20)] },
            ],
          },
          { id: "n", kind: "accessory", exercises: [{ exerciseId: ids.rows, measure: "reps", sets: [open("n1", 12)] }] },
        ],
        null,
      ),
    );
    await page.clock.setSystemTime(NEXT_MONDAY);
    await page.goto("/train");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Push/);
    expect(await pageOrder(page)).toEqual(["Rows", "Dips", "Plank", "Hollow hold", "Rows"]);

    await page.getByRole("button", { name: "Reorder workout" }).click();
    const order = page.getByRole("dialog", { name: "Workout order" });
    await expect(order.getByRole("listitem")).toHaveText([/^Main lift/, /^Rows$/, /^Dips$/, /^Superset A: Plank.*Hollow hold/, /^Rows$/]);
    await order.getByRole("button", { name: "Move Superset A up in workout" }).click();
    await expect(order.getByRole("status")).toHaveText("Superset A moved up · 2 of 4");
    await expect(order.getByRole("listitem")).toHaveText([/^Main lift/, /^Rows$/, /^Superset A: Plank.*Hollow hold/, /^Dips$/, /^Rows$/]);
    // The exercise added after Core moves up past it, one place.
    await order.getByRole("button", { name: "Move Rows up in workout" }).last().click();
    await expect(order.getByRole("status")).toHaveText("Rows moved up · 3 of 4");
    await page.keyboard.press("Escape");
    expect(await pageOrder(page)).toEqual(["Rows", "Plank", "Hollow hold", "Rows", "Dips"]);
    await expectSynced(page);
    // The block keeps its `section` for the device that shows Core.
    const saved = (await serverData(page)).sessions.find((s) => s.date === NEXT_MONDAY_ISO)!;
    expect(saved.blocks.map((b) => [b.id, b.section ?? null])).toEqual([
      ["main-1", null],
      ["r", null],
      ["c", "core"],
      ["n", null],
      ["d", null],
    ]);

    // The superset sheet offers every accessory, Core's too, and moves one in rather than adding it twice.
    await page.getByRole("button", { name: "Manage Superset A" }).click();
    const sheet = page.getByRole("dialog", { name: "Superset A" });
    await sheet.getByRole("button", { name: "Add Dips to Superset A" }).click();
    await expect(sheet.getByRole("status")).toHaveText("Dips added to Superset A as A3");
    await page.keyboard.press("Escape");
    expect(await pageOrder(page)).toEqual(["Rows", "Plank", "Hollow hold", "Dips", "Rows"]);
  });
});

test("with the training day on, pre-fill files the old core couplet under Core (stored after the accessories)", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("strawvine:flags", "trainDay"));
  await onboardedOn(page, MONDAY);
  const { call, ids, doc, main } = await api(page);
  await call(
    "PUT",
    `/api/sessions/${MONDAY_ISO}`,
    doc(
      MONDAY_ISO,
      [
        main([done("m1", 6)]),
        { id: "r", kind: "accessory", exercises: [{ exerciseId: ids.rows, measure: "reps", sets: [done("r1", 10)] }] },
        { id: "p", kind: "accessory", exercises: [{ exerciseId: ids.plank, measure: "seconds", sets: [done("p1", 30)] }] },
        { id: "d", kind: "accessory", exercises: [{ exerciseId: ids.dips, measure: "reps", sets: [done("d1", 10)] }] },
      ],
      `${MONDAY_ISO}T18:30:00.000Z`,
    ),
  );
  await page.clock.setSystemTime(NEXT_MONDAY);
  await page.goto("/train");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Push/);
  expect(await pageOrder(page)).toEqual(["Rows", "Dips", "Plank"]);
  // Logging a set saves the draft: the Core block goes with its section.
  await page.getByRole("button", { name: /^Rows set 1: / }).click();
  await expectSynced(page);
  const saved = (await serverData(page)).sessions.find((s) => s.date === NEXT_MONDAY_ISO)!;
  expect(saved.blocks.map((b) => b.section ?? null)).toEqual([null, null, null, "core"]);
});
