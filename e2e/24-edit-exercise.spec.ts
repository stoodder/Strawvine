/**
 * Editing an exercise (§6.5): its measure, category and load change from the Edit exercise sheet —
 * opened from a session's exercise options or Settings' exercise library. History keeps the
 * measure it was done in; next week's pre-fill uses the new one (set count and loads carried,
 * targets reset); a session in progress that hasn't logged the exercise yet follows at once.
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

/** Create an accessory counted in reps, weighted (the create card's defaults for reps). */
async function create(page: Page, name: string) {
  await page.getByRole("button", { name: "Exercise", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Add exercise" });
  await sheet.getByRole("textbox", { name: "Search or create exercise" }).fill(name);
  await expect(sheet.getByRole("group", { name: "Load" }).getByRole("button", { name: "Weighted", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
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

  // From the session: the options sheet → Edit exercise. Distance, as a carry, still weighted.
  await page.getByRole("button", { name: "Sled push options" }).click();
  await page.getByRole("button", { name: /^Edit exercise/ }).click();
  const sheet = page.getByRole("dialog", { name: "Edit exercise" });
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
  // The session in progress: the logged exercise keeps reps, the one not started follows.
  expect(await serverBlock(page, MONDAY_ISO, "Sled push")).toMatchObject({ measure: "reps" });
  const wall = await serverBlock(page, MONDAY_ISO, "Wall sit");
  expect(wall.measure).toBe("seconds");
  expect(wall.sets.map((s) => s.targetReps)).toEqual([30, 30, 30]);
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

test("a program's main lift keeps its category, measure and max", async ({ page }) => {
  const sheet = await openExerciseEditor(page, "Bench press");
  await expect(sheet.getByText(/^Mon’s main lift/)).toBeVisible();
  for (const group of ["Category", "Measured in", "Max"])
    for (const b of await sheet.getByRole("group", { name: group }).getByRole("button").all()) await expect(b).toBeDisabled();
  await expect(sheet.getByRole("group", { name: "Load" })).toHaveCount(0);
  await expect(sheet.getByRole("button", { name: "Archive" })).toBeDisabled();
  await sheet.getByRole("textbox", { name: "Name" }).fill("Comp bench");
  await sheet.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("button", { name: "Edit Comp bench" })).toBeVisible();
  await expectSynced(page);
  expect((await serverData(page)).exercises.find((e) => e.name === "Comp bench")).toMatchObject({
    category: "primary",
    tracksMax: true,
    measure: "reps",
    archived: false,
  });
});
