/**
 * Editing an exercise (§6.5): its measure, category and load change from the Edit exercise sheet —
 * opened from a session's exercise options or Settings' exercise library. History keeps the
 * measure it was done in; next week's pre-fill uses the new one (set count and loads carried,
 * targets reset); a session not finished shows an exercise with nothing logged in the new measure
 * without rewriting it — logging a set writes it — and changing back restores its own targets.
 */
import type { Page } from "@playwright/test";
import { expect, expectSynced, MONDAY, MONDAY_ISO, onboardedOn, openExerciseEditor, serverData, test } from "./helpers";

/** The Monday after the suite's first one: week 2, Push again. */
const NEXT_MONDAY = new Date(2026, 10, 2, 10, 0, 0);

test.beforeEach(async ({ page }) => {
  await onboardedOn(page, MONDAY);
  await page.getByRole("link", { name: "Train" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Push/);
});

/** Create an accessory counted in reps: weighted (the create card's default for reps), or not. */
async function create(page: Page, name: string, load: "Weighted" | "Unweighted" = "Weighted") {
  await page.getByRole("button", { name: "Exercise", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Add exercise" });
  await sheet.getByRole("textbox", { name: "Search or create exercise" }).fill(name);
  const loadGroup = sheet.getByRole("group", { name: "Load" });
  await expect(loadGroup.getByRole("button", { name: "Weighted", exact: true })).toHaveAttribute("aria-pressed", "true");
  if (load === "Unweighted") await loadGroup.getByRole("button", { name: "Unweighted", exact: true }).click();
  await sheet.getByRole("button", { name: /Create & add/ }).click();
  await expect(sheet).toHaveCount(0);
}

const chip = (page: Page, name: string, n: number) => page.getByRole("button", { name: new RegExp(`^${name} set ${n}:`) });
const pick = (sheet: ReturnType<Page["getByRole"]>, group: string, choice: string) =>
  sheet.getByRole("group", { name: group }).getByRole("button", { name: choice, exact: true }).click();

/** The exercise's block in the server's session for `date`. */
async function serverBlock(page: Page, date: string, name: string) {
  const { sessions, exercises } = await serverData(page);
  const id = exercises.find((e) => e.name === name)!.id;
  return sessions
    .find((s) => s.date === date)!
    .blocks.flatMap((b) => b.exercises)
    .find((e) => e.exerciseId === id)!;
}

/** Change an exercise's measure in the library, then come back to today's session. */
async function setMeasure(page: Page, name: string, measure: "Reps" | "Time" | "Distance") {
  const sheet = await openExerciseEditor(page, name);
  await pick(sheet, "Measured in", measure);
  await sheet.getByRole("button", { name: "Save" }).click();
  await expect(sheet).toHaveCount(0);
  await page.goto("/train");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Push/);
}

test("a new measure applies from now on; the logged session keeps the old one", async ({ page }) => {
  await create(page, "Sled push");
  // A weighted set without a load opens the editor: log the first at 90 lb, the rest carry it.
  await chip(page, "Sled push", 1).click();
  const editor = page.getByRole("dialog", { name: "Sled push · set 1" });
  for (let i = 0; i < 18; i++) await editor.getByRole("button", { name: "Increase load" }).click();
  await editor.getByRole("button", { name: "Log set" }).click();
  await expect(editor).toHaveCount(0);
  for (const n of [2, 3]) {
    await expect(chip(page, "Sled push", n)).toHaveAccessibleName(/10\s?reps\s+at\s+90\s+lb$/);
    await chip(page, "Sled push", n).click();
    await expect(chip(page, "Sled push", n)).toHaveAttribute("aria-pressed", "true");
  }
  // Added but not started yet: it follows an edit at once.
  await create(page, "Wall sit");
  await expect(chip(page, "Wall sit", 1)).toHaveAccessibleName(/10\s?reps\s*\(no load\)$/);

  // From the session: the options sheet (Edit exercise first) → Edit exercise. Distance, as a carry, still weighted.
  await page.getByRole("button", { name: "Sled push options" }).click();
  const options = page.getByRole("dialog", { name: "Sled push" });
  await expect(options.getByRole("button").nth(1)).toHaveAccessibleName(/^Edit exercise/); // after the sheet's Close
  await options.getByRole("button", { name: /^Edit exercise/ }).click();
  const sheet = page.getByRole("dialog", { name: "Edit Sled push" });
  await expect(sheet.getByRole("textbox", { name: "Name" })).toHaveValue("Sled push");
  await expect(sheet.getByRole("group", { name: "Measured in" }).getByRole("button", { name: "Reps" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await pick(sheet, "Measured in", "Distance");
  await expect(sheet.getByText("Past sessions stay in reps · new sets start at 40 meters")).toBeVisible();
  await pick(sheet, "Category", "Carry");
  await sheet.getByRole("button", { name: "Save" }).click();
  await expect(sheet).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Sled push options" })).toBeFocused();
  // Logged in reps today: today's sets stay as they were done.
  await expect(chip(page, "Sled push", 1)).toHaveAccessibleName(/10\s?reps\s+at\s+90\s+lb$/);

  // From the library: the wall sit becomes an unweighted hold.
  const wallSit = await openExerciseEditor(page, "Wall sit");
  await pick(wallSit, "Measured in", "Time");
  await pick(wallSit, "Category", "Core");
  await pick(wallSit, "Load", "Unweighted");
  await wallSit.getByRole("button", { name: "Save" }).click();
  await expect(wallSit).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Edit Wall sit" })).toHaveAccessibleDescription("Core · time");
  await expect(page.getByRole("button", { name: "Edit Sled push" })).toHaveAccessibleDescription("Carry · distance · weighted");

  await expectSynced(page);
  const { exercises } = await serverData(page);
  expect(exercises.find((e) => e.name === "Sled push")).toMatchObject({ category: "carry", measure: "meters", weighted: true });
  expect(exercises.find((e) => e.name === "Wall sit")).toMatchObject({ category: "core", measure: "seconds", weighted: false });
  // No session was rewritten: both blocks are saved as they were...
  expect(await serverBlock(page, MONDAY_ISO, "Sled push")).toMatchObject({ measure: "reps" });
  expect(await serverBlock(page, MONDAY_ISO, "Wall sit")).toMatchObject({ measure: "reps" });
  // ...but the one with nothing logged shows (and would log) in the new measure.
  await page.goto("/train");
  await expect(chip(page, "Wall sit", 1)).toHaveAccessibleName(/^Wall sit set 1: 30\s?s$/);

  // Next week: pre-filled in meters — three sets, the 90 lb carried, the targets reset — with no
  // hint from the reps done last week.
  await page.clock.setSystemTime(NEXT_MONDAY);
  await page.goto("/train");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Push/);
  for (const n of [1, 2, 3]) await expect(chip(page, "Sled push", n)).toHaveAccessibleName(/40\s?m\s+at\s+90\s+lb$/);
  await expect(chip(page, "Sled push", 4)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Apply .* Sled push sets$/ })).toHaveCount(0);
  await expect(chip(page, "Wall sit", 1)).toHaveAccessibleName(/^Wall sit set 1: 30\s?s$/);

  // Last week's session still shows what was done.
  await page.goto(`/train/${MONDAY_ISO}`);
  for (const n of [1, 2, 3]) await expect(chip(page, "Sled push", n)).toHaveAccessibleName(/10\s?reps\s+at\s+90\s+lb$/);
});

test("today's unlogged exercise shows a new measure; logging writes it; changing back first restores its targets", async ({ page }) => {
  await create(page, "Ring row", "Unweighted");
  // Its own targets: 8 reps (set 1's target, carried to the sets after it).
  await page.getByRole("button", { name: "Ring row options" }).click();
  await page.getByRole("button", { name: /^Edit set 1: 10 reps/ }).click();
  const editor = page.getByRole("dialog", { name: "Ring row · set 1" });
  for (let i = 0; i < 2; i++) await editor.getByRole("button", { name: "Decrease reps" }).click();
  await editor.getByRole("button", { name: "Save target" }).click();
  await expect(editor).toHaveCount(0);
  for (const n of [1, 2, 3]) await expect(chip(page, "Ring row", n)).toHaveAccessibleName(/^Ring row set \d: 8 reps$/);
  await expectSynced(page);
  const targets = async () => (await serverBlock(page, MONDAY_ISO, "Ring row")).sets.map((s) => [s.targetReps, s.done]);
  expect(await targets()).toEqual([
    [8, false],
    [8, false],
    [8, false],
  ]);

  // Timed now: shown at the default 30 seconds — the saved block isn't touched.
  await setMeasure(page, "Ring row", "Time");
  for (const n of [1, 2, 3]) await expect(chip(page, "Ring row", n)).toHaveAccessibleName(/^Ring row set \d: 30\s?s$/);
  await expectSynced(page);
  expect(await serverBlock(page, MONDAY_ISO, "Ring row")).toMatchObject({ measure: "reps" });
  expect(await targets()).toEqual([
    [8, false],
    [8, false],
    [8, false],
  ]);

  // Back to reps before logging: its own 8s are back.
  await setMeasure(page, "Ring row", "Reps");
  for (const n of [1, 2, 3]) await expect(chip(page, "Ring row", n)).toHaveAccessibleName(/^Ring row set \d: 8 reps$/);

  // Timed again, and the first set logged: the block now holds the measure and targets it was logged at.
  await setMeasure(page, "Ring row", "Time");
  await chip(page, "Ring row", 1).click();
  await expect(chip(page, "Ring row", 1)).toHaveAttribute("aria-pressed", "true");
  await expectSynced(page);
  const block = await serverBlock(page, MONDAY_ISO, "Ring row");
  expect(block.measure).toBe("seconds");
  expect(block.sets.map((s) => [s.targetReps, s.reps, s.done])).toEqual([
    [30, 30, true],
    [30, null, false],
    [30, null, false],
  ]);
  // Logged in seconds: it keeps that measure whatever the exercise says next.
  await setMeasure(page, "Ring row", "Reps");
  await expect(chip(page, "Ring row", 2)).toHaveAccessibleName(/^Ring row set 2: 30\s?s$/);
});

test("a program's main lift keeps its category, measure and max", async ({ page }) => {
  const sheet = await openExerciseEditor(page, "Bench press");
  await expect(sheet.getByText(/^Mon’s main lift.*can’t be archived/)).toBeVisible();
  await expect(sheet.getByRole("link", { name: "weekly layout" })).toHaveAttribute("href", "/program#layout");
  // Locked, but reachable: Tab lands on them (and their note is announced); a press does nothing.
  for (const group of ["Category", "Measured in", "Max"])
    for (const b of await sheet.getByRole("group", { name: group }).getByRole("button").all()) {
      await expect(b).toHaveAttribute("aria-disabled", "true");
      await expect(b).toHaveJSProperty("disabled", false); // aria-disabled only: still focusable
    }
  await sheet.getByRole("group", { name: "Category" }).getByRole("button", { name: "Core" }).click({ force: true }); // Playwright waits for "enabled" otherwise
  await expect(sheet.getByRole("group", { name: "Category" }).getByRole("button", { name: "Barbell" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(sheet.getByRole("group", { name: "Load" })).toHaveCount(0);
  const archive = sheet.getByRole("button", { name: "Archive" });
  await expect(archive).toHaveAttribute("aria-disabled", "true");
  await expect(archive).toHaveAccessibleDescription(/can’t be archived/);
  await archive.focus();
  await expect(archive).toBeFocused();

  // Unsaved changes: Escape asks first; Keep editing keeps them.
  await sheet.getByRole("textbox", { name: "Name" }).fill("Comp bench");
  await page.keyboard.press("Escape");
  await expect(sheet.getByText("Discard changes?")).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Keep editing" })).toBeFocused();
  await sheet.getByRole("button", { name: "Keep editing" }).click();
  await expect(sheet.getByRole("textbox", { name: "Name" })).toHaveValue("Comp bench");
  await sheet.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("button", { name: "Edit Comp bench" })).toBeVisible();
  await expectSynced(page);
  expect((await serverData(page)).exercises.find((e) => e.name === "Comp bench")).toMatchObject({
    category: "primary",
    tracksMax: true,
    measure: "reps",
    archived: false,
  });

  // The server holds the same line for any client: archiving a program's main lift is refused.
  const id = (await serverData(page)).exercises.find((e) => e.name === "Comp bench")!.id;
  const res = await page.evaluate(async (exerciseId) => {
    const r = await fetch(`/api/exercises/${exerciseId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ archived: true }),
    });
    return { status: r.status, body: (await r.json()) as { error: string } };
  }, id);
  expect(res.status).toBe(409);
  expect(res.body.error).toMatch(/^Comp bench is Mon's main lift: .*can't be archived/);
  expect((await serverData(page)).exercises.find((e) => e.id === id)?.archived).toBe(false);
});
