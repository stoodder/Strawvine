/**
 * Program (`/program`): the training plan's own screen. The cycle moves a week later in one tap
 * (the server's cycle start, and what Train prescribes, move with it) and Undo puts it back; the
 * weekly layout is edited here; old Settings anchors of the sections that moved land here; and
 * Train's tab stays lit.
 */
import type { Page } from "@playwright/test";
import { expect, expectSynced, MONDAY, MONDAY_ISO, notifications, onboardedOn, serverData, test, toastMessage } from "./helpers";

/** The Monday after the suite's first one. */
const NEXT_MONDAY = new Date(2026, 10, 2, 10, 0, 0);
const NEXT_MONDAY_ISO = "2026-11-02";

const cycleStart = async (page: Page) => (await serverData(page)).settings.program.cycleStartDate;
const benchSets = (page: Page) => page.getByRole("button", { name: /^Bench press set \d+:/ });
const now = (page: Page) => page.locator("[data-cycle-now]");

test.beforeEach(async ({ page }) => {
  await onboardedOn(page, MONDAY);
});

test("a week later: the server's cycle start moves 7 days, Train follows, and Undo restores it", async ({ page }) => {
  // Monday of week 1: Train prescribes the bench sets.
  expect(await cycleStart(page)).toBe(MONDAY_ISO);
  await page.goto("/train");
  await expect(benchSets(page)).toHaveCount(4);

  await page.goto("/program");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Program");
  await expect(page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Train" })).toHaveAttribute("aria-current", "page");
  await expect(now(page)).toContainText("Cycle 1 · Week 1 of 5");
  const later = page.getByRole("button", { name: "Start a week later" });
  // What it will do, before it's tapped.
  await expect(later).toHaveAccessibleDescription("Pushes the whole plan back a week: next Monday becomes Week 1 · Push.");

  await later.click();
  await expect(toastMessage(page, "Plan moved a week later")).toBeVisible();
  await expect(now(page)).toContainText("Starts next Monday");
  await expect(page.getByLabel("Cycle start date")).toHaveValue(NEXT_MONDAY_ISO);
  await expect.poll(() => cycleStart(page)).toBe(NEXT_MONDAY_ISO);
  await expectSynced(page);

  // Undo: back where it was, on the server too.
  await notifications(page).getByRole("button", { name: "Undo" }).click();
  await expect(now(page)).toContainText("Cycle 1 · Week 1 of 5");
  await expect.poll(() => cycleStart(page)).toBe(MONDAY_ISO);

  // Again, for good: today has no prescribed lift any more, and next Monday is week 1's (6/8/10/12+).
  await later.click();
  await expect.poll(() => cycleStart(page)).toBe(NEXT_MONDAY_ISO);
  await expectSynced(page);
  await page.goto("/train");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(benchSets(page)).toHaveCount(0);
  await page.clock.setSystemTime(NEXT_MONDAY);
  await page.goto("/train");
  await expect(benchSets(page)).toHaveCount(4);
  await expect(benchSets(page).last()).toHaveAccessibleName(/\b12\b.*AMRAP/);
  // The link back from Program leads to Train.
  await page.goto("/program");
  await expect(now(page)).toContainText("Cycle 1 · Week 1 of 5");
  await page.getByRole("link", { name: "Back to Train" }).click();
  await expect(page).toHaveURL(/\/train$/);
});

test("edit a weekly-layout day: Monday's main lift and name change, on the server and on Train", async ({ page }) => {
  await page.goto("/program#layout");
  const before = (await serverData(page)).settings;
  const deadlift = (await serverData(page)).exercises.find((e) => e.name === "Deadlift")!;

  await page.getByRole("combobox", { name: "Mon main lift" }).selectOption({ label: "Deadlift" });
  const name = page.getByRole("textbox", { name: "Mon session name" });
  await name.fill("Hinge");
  await name.press("Enter");
  await expect.poll(async () => (await serverData(page)).settings.program.days["1"]).toEqual({
    ...before.program.days["1"]!,
    label: "Hinge",
    primaryExerciseId: deadlift.id,
  });
  // Nothing else in the settings document moved.
  const after = (await serverData(page)).settings;
  expect({ ...after, program: { ...after.program, days: before.program.days } }).toEqual(before);

  await page.reload();
  await expect(page.getByRole("textbox", { name: "Mon session name" })).toHaveValue("Hinge");
  await page.goto("/train");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Hinge/);
  // The day's main lift is the deadlift now (it has no max yet, so no calculated sets), not the bench.
  await expect(page.getByText("Deadlift").first()).toBeVisible();
  await expect(benchSets(page)).toHaveCount(0);
});

test("old Settings links land on Program; Settings keeps a link to it", async ({ page }) => {
  await page.goto("/settings#program");
  await expect(page).toHaveURL(/\/program$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Program");
  await expect(page.getByRole("textbox", { name: "Program name" })).toBeVisible();

  // What was Settings → Training is Program → Rules: the section is brought into view.
  await page.goto("/settings#training");
  await expect(page).toHaveURL(/\/program#rules$/);
  await expect(page.getByRole("heading", { level: 2, name: "Rules" })).toBeInViewport();
  await expect(page.getByRole("textbox", { name: "Main lift rest" })).toBeVisible();

  // Settings itself: no plan, a link to it.
  await page.goto("/settings");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Settings");
  await expect(page.getByRole("textbox", { name: "Program name" })).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 2, name: "Exercise library" })).toHaveCount(0);
  await page.getByRole("link", { name: /Training program/ }).click();
  await expect(page).toHaveURL(/\/program$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Program");
});

test("a main lift's lock note links to Program's weekly layout", async ({ page }) => {
  await page.goto("/program");
  await page.getByRole("button", { name: "Edit Bench press", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Edit Bench press" });
  await sheet.getByRole("link", { name: "weekly layout" }).click();
  await expect(sheet).toHaveCount(0);
  await expect(page).toHaveURL(/\/program#layout$/);
  await expect(page.getByRole("heading", { level: 2, name: "Weekly layout" })).toBeInViewport();
});
