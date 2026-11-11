/**
 * Program (`/program`): the training program's own screen. The cycle is delayed a week in one tap
 * (the server's cycle start, and what Train prescribes, move with it) and Undo puts it back — a
 * double-tap moves one week, taps in a row fold into one Undo, and an Undo tapped from another
 * screen takes back only the move — also while the move's save is still in flight, slow, or was
 * saved without the answer ever arriving; the weekly layout is edited here (a day switched off comes
 * back as it was); old Settings anchors of the sections that moved land here; and Train's tab
 * stays lit.
 */
import type { Page, Route } from "@playwright/test";
import {
  expect,
  expectFocusNotOnBody,
  expectSynced,
  fillNumber,
  MONDAY,
  MONDAY_ISO,
  notifications,
  onboardedOn,
  serverData,
  test,
  toastMessage,
  unsentEdits,
} from "./helpers";

/** The Monday after the suite's first one. */
const NEXT_MONDAY = new Date(2026, 10, 2, 10, 0, 0);
const NEXT_MONDAY_ISO = "2026-11-02";

const cycleStart = async (page: Page) => (await serverData(page)).settings.program.cycleStartDate;
const benchSets = (page: Page) => page.getByRole("button", { name: /^Bench press set \d+:/ });
const now = (page: Page) => page.locator("[data-cycle-now]");
const delayAWeek = (page: Page) => page.getByRole("button", { name: "Delay a week" });
const undoButtons = (page: Page) => notifications(page).getByRole("button", { name: "Undo" });

/** Routes this page's settings saves (PUT /api/settings) through `handle(route, n)`, n = 1 for the first. */
async function onSettingsSave(page: Page, handle: (route: Route, n: number) => Promise<void>) {
  let n = 0;
  await page.route("**/api/settings", (route) => (route.request().method() === "PUT" ? handle(route, ++n) : route.fallback()));
}

test.beforeEach(async ({ page }) => {
  await onboardedOn(page, MONDAY);
});

test("Delay a week: the server's cycle start moves 7 days, Train follows, and Undo restores it", async ({ page }) => {
  // Monday of week 1: Train prescribes the bench sets.
  expect(await cycleStart(page)).toBe(MONDAY_ISO);
  await page.goto("/train");
  await expect(benchSets(page)).toHaveCount(4);

  await page.goto("/program");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Program");
  await expect(page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Train" })).toHaveAttribute("aria-current", "page");
  await expect(now(page)).toContainText("Cycle 1 · Week 1 of 5");
  const later = delayAWeek(page);
  // What each move will do — to this week and the next — before it's tapped.
  await expect(later).toHaveAccessibleDescription(
    "Starts Mon Nov 2 instead of Oct 26: this week is before the program; next Monday is Week 1 · Push.",
  );
  await expect(page.getByRole("button", { name: "Skip ahead a week" })).toHaveAccessibleDescription(
    "This week becomes Week 2; next Monday is Week 3 · Push.",
  );

  await later.click();
  await expect(toastMessage(page, "Program delayed a week")).toBeVisible();
  await expect(now(page)).toContainText("Starts next Monday");
  await expect(page.getByLabel("Cycle start date")).toHaveValue(NEXT_MONDAY_ISO);
  await expect.poll(() => cycleStart(page)).toBe(NEXT_MONDAY_ISO);
  await expectSynced(page);

  // Undo: back where it was, on the server too — and focus is back on the button, not lost.
  await undoButtons(page).click();
  await expect(now(page)).toContainText("Cycle 1 · Week 1 of 5");
  await expect.poll(() => cycleStart(page)).toBe(MONDAY_ISO);
  await expect(later).toBeFocused();

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

test("a double-tap delays one week; taps in a row fold into one Undo that goes back to the start", async ({ page }) => {
  await page.goto("/program");
  const later = delayAWeek(page);
  await later.dblclick();
  await expect(page.getByLabel("Cycle start date")).toHaveValue(NEXT_MONDAY_ISO);
  await expect(toastMessage(page, "Program delayed a week")).toBeVisible();
  await expect(undoButtons(page)).toHaveCount(1);
  await expect.poll(() => cycleStart(page)).toBe(NEXT_MONDAY_ISO);

  // A second, deliberate tap: another week, still one toast — which now names the whole move.
  await page.waitForTimeout(700);
  await later.click();
  await expect(page.getByLabel("Cycle start date")).toHaveValue("2026-11-09");
  await expect(toastMessage(page, "Program delayed 2 weeks")).toBeVisible();
  await expect(toastMessage(page, "Program delayed a week")).toHaveCount(0);
  await expect(undoButtons(page)).toHaveCount(1);
  await expect.poll(() => cycleStart(page)).toBe("2026-11-09");

  await undoButtons(page).click();
  await expect(now(page)).toContainText("Cycle 1 · Week 1 of 5");
  await expect.poll(() => cycleStart(page)).toBe(MONDAY_ISO);
  await expectSynced(page);
  expect(await cycleStart(page)).toBe(MONDAY_ISO);
});

test("Undo tapped on another screen takes back only the move: a steps target changed since stays", async ({ page }) => {
  // Program, opened from Settings: its back control leads back there.
  await page.goto("/settings");
  await page.getByRole("link", { name: /Training program/ }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Program");
  const before = (await serverData(page)).settings;
  expect(before.targets.steps).not.toBe(12000);

  await delayAWeek(page).click();
  await expect(toastMessage(page, "Program delayed a week")).toBeVisible();
  // Off to Settings while the Undo is still on offer, and change something else there.
  await page.getByRole("link", { name: "Back to Settings" }).click();
  await expect(page).toHaveURL(/\/settings#schedule$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Settings");
  await fillNumber(page, "Steps", "12000");
  await undoButtons(page).click();

  // The cycle start is back; the steps target is the new one — here and on the server.
  await expect(page.getByRole("textbox", { name: "Steps", exact: true })).toHaveValue("12,000");
  await expectSynced(page);
  await expect.poll(async () => (await serverData(page)).settings.targets.steps).toBe(12000);
  const after = (await serverData(page)).settings;
  expect(after.program.cycleStartDate).toBe(MONDAY_ISO);
  expect(after).toEqual({ ...before, targets: { ...before.targets, steps: 12000 } });
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Steps", exact: true })).toHaveValue("12,000");
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
for (const [latency, handle] of [
  // The server saves at once; each answer takes 700 ms to arrive, so the later edits queue behind a save in flight.
  [
    "every answer is slow",
    async (route: Route) => {
      const response = await route.fetch();
      await wait(700);
      await route.fulfill({ response });
    },
  ],
  // The steps target is on the server (and can be read there) well before the Undo that follows it.
  [
    "the Undo's own save is slow",
    async (route: Route, n: number) => {
      if (n === 3) await wait(1500);
      await route.fallback();
    },
  ],
] as const) {
  test(`the same on a slow connection (${latency}): the Undo still takes back only the move`, async ({ page }) => {
    await page.goto("/settings");
    await page.getByRole("link", { name: /Training program/ }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Program");
    const before = (await serverData(page)).settings;
    await onSettingsSave(page, handle);

    await delayAWeek(page).click();
    await expect(toastMessage(page, "Program delayed a week")).toBeVisible();
    await page.getByRole("link", { name: "Back to Settings" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Settings");
    await fillNumber(page, "Steps", "12000");
    await undoButtons(page).click();

    await expect(page.getByRole("textbox", { name: "Steps", exact: true })).toHaveValue("12,000");
    await expectSynced(page);
    expect((await serverData(page)).settings).toEqual({ ...before, targets: { ...before.targets, steps: 12000 } });
    await expect(toastMessage(page, /Merged changes/)).toHaveCount(0);
  });
}

test("Undo while the delay's save is still in flight: the server ends on the original date", async ({ page }) => {
  await page.goto("/program");
  const before = (await serverData(page)).settings;
  // The first save reaches the server; its answer is held back until the Undo has been tapped.
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await onSettingsSave(page, async (route, n) => {
    if (n > 1) return route.fallback();
    const response = await route.fetch();
    await held;
    await route.fulfill({ response });
  });

  await delayAWeek(page).click();
  await expect.poll(() => cycleStart(page)).toBe(NEXT_MONDAY_ISO);
  await undoButtons(page).click();
  await expect(page.getByLabel("Cycle start date")).toHaveValue(MONDAY_ISO);
  expect(await unsentEdits(page)).toBe(2); // the save in flight, and the Undo behind it
  release();

  await expectSynced(page);
  expect((await serverData(page)).settings).toEqual(before);
  await expect(page.getByLabel("Cycle start date")).toHaveValue(MONDAY_ISO);
  await expect(now(page)).toContainText("Cycle 1 · Week 1 of 5");
  await expect(toastMessage(page, /Merged changes/)).toHaveCount(0);
});

test("the delay is saved but its answer never arrives (the connection drops): Undo still takes it back", async ({ page, context }) => {
  await page.goto("/program");
  const before = (await serverData(page)).settings;
  // The server saves the first one; then the connection is gone, before the answer.
  await onSettingsSave(page, async (route, n) => {
    if (n > 1) return route.fallback();
    await route.fetch();
    await context.setOffline(true);
    await route.abort("failed");
  });

  await delayAWeek(page).click();
  await expect(page.getByRole("button", { name: "Offline · 1 pending" })).toBeVisible();
  // To this device the delay is unsent; the server has it.
  // Undo, offline: it must not replace the save that may have landed (it queues behind it).
  await undoButtons(page).click();
  await expect(page.getByLabel("Cycle start date")).toHaveValue(MONDAY_ISO);
  await expect(page.getByRole("button", { name: "Offline · 2 pending" })).toBeVisible();

  await context.setOffline(false);
  expect(await cycleStart(page)).toBe(NEXT_MONDAY_ISO);
  await expectSynced(page);
  expect((await serverData(page)).settings).toEqual(before);
  // This device's own save coming back is not "another device": nothing was merged, and the date stays put.
  await expect(toastMessage(page, /Merged changes/)).toHaveCount(0);
  await expect(page.getByLabel("Cycle start date")).toHaveValue(MONDAY_ISO);
  await page.reload();
  await expect(page.getByLabel("Cycle start date")).toHaveValue(MONDAY_ISO);
});

test("the cycle start date field leaves the same Undo", async ({ page }) => {
  await page.goto("/program");
  const field = page.getByLabel("Cycle start date");
  // A Thursday three weeks on: the start snaps to that week's Monday.
  await field.fill("2026-11-19");
  await expect(field).toHaveValue("2026-11-16");
  await expect(toastMessage(page, "Program starts Mon Nov 16")).toBeVisible();
  await expect.poll(() => cycleStart(page)).toBe("2026-11-16");
  await undoButtons(page).click();
  await expect(field).toHaveValue(MONDAY_ISO);
  await expect.poll(() => cycleStart(page)).toBe(MONDAY_ISO);
  await expect(field).toBeFocused();
});

test("a lifting day switched off and on again keeps its name, main lift and AMRAP setting", async ({ page }) => {
  await page.goto("/program#layout");
  const monday = (await serverData(page)).settings.program.days["1"]!;
  const lift = page.getByRole("switch", { name: "Mon lifting day" });
  await expect(page.getByRole("textbox", { name: "Mon session name" })).toHaveValue("Push");

  await lift.click();
  await expect(toastMessage(page, "Monday lifting switched off")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Mon session name" })).toHaveCount(0);
  await expect.poll(async () => (await serverData(page)).settings.program.days["1"]).toBeUndefined();
  await lift.click();
  await expect(page.getByRole("textbox", { name: "Mon session name" })).toHaveValue("Push");
  await expect(page.getByRole("combobox", { name: "Mon main lift" })).toHaveValue(String(monday.primaryExerciseId));
  await expect.poll(async () => (await serverData(page)).settings.program.days["1"]).toEqual(monday);

  // Off again, then Undo from the toast: the same, and focus returns to the switch.
  await lift.click();
  await expect(page.getByRole("textbox", { name: "Mon session name" })).toHaveCount(0);
  await undoButtons(page).last().click();
  await expect(page.getByRole("textbox", { name: "Mon session name" })).toHaveValue("Push");
  await expect.poll(async () => (await serverData(page)).settings.program.days["1"]).toEqual(monday);
  expect(await expectFocusNotOnBody(page, "undoing a lifting day switched off")).toContain("Mon lifting day");
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

  // Settings itself: no program, a link to it.
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
