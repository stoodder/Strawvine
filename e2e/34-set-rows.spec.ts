/**
 * One set-row grammar on Train, by touch and with no hidden gesture: every set — main lift and
 * accessory — is a row whose check (right) logs / unlogs it and whose values (left) open the set
 * editor. Finish is within reach in the dock once a set is logged, and the exercise options list
 * their actions by how often they're used. Monday of week 1 (bench press, AMRAP last set).
 */
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, expectSynced, MONDAY, MONDAY_ISO, notifications, onboardedOn, serverData, test, toastMessage } from "./helpers";

test.beforeEach(async ({ page }) => {
  await onboardedOn(page, MONDAY);
  await page.getByRole("link", { name: "Train" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Push/);
});

/** Add Pull-up (in the library, unweighted: three sets of 10 reps) to today's session. */
async function addPullUp(page: Page) {
  await page.getByRole("button", { name: "Exercise", exact: true }).tap();
  const sheet = page.getByRole("dialog", { name: "Add exercise" });
  await sheet.getByRole("button", { name: /^Pull-up/ }).tap();
  await expect(sheet).toHaveCount(0);
}

/** A set's check, by its name ("Pull-up set 1: 10 reps"); its values control is the same name led by "Edit". */
const check = (page: Page, name: string, n: number) => page.getByRole("button", { name: new RegExp(`^${name} set ${n}:`) });
const values = (page: Page, name: string, n: number) => page.getByRole("button", { name: new RegExp(`^Edit ${name} set ${n}:`) });

/** The sets of an exercise in the server's session for Monday: [target, done amount, logged]. */
async function serverSets(page: Page, name: string) {
  const { sessions, exercises } = await serverData(page);
  const id = exercises.find((e) => e.name === name)!.id;
  return sessions
    .find((s) => s.date === MONDAY_ISO)!
    .blocks.flatMap((b) => b.exercises)
    .find((e) => e.exerciseId === id)!
    .sets.map((s) => [s.targetReps, s.reps, s.done]);
}

/** The names of a sheet's buttons, top to bottom (without its Close). */
const buttonNames = (sheet: ReturnType<Page["getByRole"]>) =>
  sheet
    .getByRole("button")
    .evaluateAll((els) => els.map((el) => (el.getAttribute("aria-label") ?? el.textContent ?? "").trim()).filter((n) => n !== "Close"));

test("the check logs and unlogs a set, the values edit it — main lift and accessory alike", async ({ page }) => {
  await addPullUp(page);
  // Nothing on the page explains a gesture: the two controls are what there is.
  await expect(page.getByText(/hold to edit/i)).toHaveCount(0);
  await expect(page.getByRole("list", { name: "Pull-up sets" }).getByRole("listitem")).toHaveCount(3);
  await expect(page.getByRole("list", { name: "Bench press sets" }).getByRole("listitem")).toHaveCount(4);

  // Main lift: the check logs at the targets; again unlogs.
  await expect(check(page, "Bench press", 1)).toHaveAccessibleName("Bench press set 1: 170 × 6");
  await check(page, "Bench press", 1).tap();
  await expect(check(page, "Bench press", 1)).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await check(page, "Bench press", 1).tap();
  await expect(check(page, "Bench press", 1)).toHaveAttribute("aria-pressed", "false");
  await check(page, "Bench press", 1).tap();
  await expect(check(page, "Bench press", 1)).toHaveAttribute("aria-pressed", "true");

  // The values open the editor instead: set 2's 160 → 165, saved as its target (nothing is logged by it).
  await values(page, "Bench press", 2).tap();
  let editor = page.getByRole("dialog", { name: "Bench press · set 2" });
  await editor.getByRole("button", { name: "Increase load" }).tap();
  await editor.getByRole("button", { name: "Save target" }).tap();
  await expect(editor).toHaveCount(0);
  await expect(check(page, "Bench press", 2)).toHaveAccessibleName("Bench press set 2: 165 × 8");
  await expect(check(page, "Bench press", 2)).toHaveAttribute("aria-pressed", "false");

  // Accessory: the same two controls, compact.
  await expect(check(page, "Pull-up", 1)).toHaveAccessibleName("Pull-up set 1: 10 reps");
  await check(page, "Pull-up", 1).tap();
  await expect(check(page, "Pull-up", 1)).toHaveAttribute("aria-pressed", "true");
  await expect(toastMessage(page, "Pull-up · set 1 logged")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // Edit an open set through its values: 10 → 8 reps as the target (carried to the set after it).
  await values(page, "Pull-up", 2).tap();
  editor = page.getByRole("dialog", { name: "Pull-up · set 2" });
  for (let i = 0; i < 2; i++) await editor.getByRole("button", { name: "Decrease reps" }).tap();
  await editor.getByRole("button", { name: "Save target" }).tap();
  await expect(editor).toHaveCount(0);
  await expect(check(page, "Pull-up", 2)).toHaveAccessibleName("Pull-up set 2: 8 reps");
  await expect(check(page, "Pull-up", 3)).toHaveAccessibleName("Pull-up set 3: 8 reps");
  await expect(check(page, "Pull-up", 2)).toHaveAttribute("aria-pressed", "false");

  // Edit the logged set through its values: it was 11, not 10.
  await values(page, "Pull-up", 1).tap();
  editor = page.getByRole("dialog", { name: "Pull-up · set 1" });
  await editor.getByRole("button", { name: "Increase reps" }).tap();
  await editor.getByRole("button", { name: "Update" }).tap();
  await expect(editor).toHaveCount(0);
  await expect(check(page, "Pull-up", 1)).toHaveAccessibleName("Pull-up set 1: 11 reps");
  await expect(check(page, "Pull-up", 1)).toHaveAttribute("aria-pressed", "true");

  // "+ Set" ends the exercise's rows.
  await page.getByRole("button", { name: "Add Pull-up set" }).tap();
  await expect(check(page, "Pull-up", 4)).toHaveAccessibleName("Pull-up set 4: 8 reps");

  await expectSynced(page);
  expect(await serverSets(page, "Pull-up")).toEqual([
    [10, 11, true],
    [8, null, false],
    [8, null, false],
    [8, null, false],
  ]);
  const bench = await serverSets(page, "Bench press");
  expect(bench.map((s) => s[2])).toEqual([true, false, false, false]);
  const { sessions } = await serverData(page);
  const main = sessions.find((s) => s.date === MONDAY_ISO)!.blocks.find((b) => b.kind === "primary")!.exercises[0]!.sets;
  expect(main.slice(0, 2).map((s) => [s.targetWeight, s.weight])).toEqual([
    [170, 170],
    [165, null],
  ]);
});

test("rows of every kind keep their visible text in their names (axe), open and logged", async ({ page }) => {
  /** Create a weighted accessory measured in `measure` and add it to today's session. */
  const create = async (name: string, measure: "Reps" | "Time" | "Distance") => {
    await page.getByRole("button", { name: "Exercise", exact: true }).tap();
    const sheet = page.getByRole("dialog", { name: "Add exercise" });
    await sheet.getByRole("textbox", { name: "Search or create exercise" }).fill(name);
    await sheet.getByRole("button", { name: measure, exact: true }).tap();
    await sheet.getByRole("group", { name: "Load" }).getByRole("button", { name: "Weighted", exact: true }).tap();
    await sheet.getByRole("button", { name: /Create & add/ }).tap();
    await expect(sheet).toHaveCount(0);
  };
  await addPullUp(page);
  await create("Hang", "Time");
  await create("Sled", "Distance");
  await create("Curl", "Reps");
  // A weighted set with no load yet: the check opens the editor instead of logging. Give Hang 25 lb there.
  await expect(check(page, "Hang", 1)).toHaveAccessibleName("Hang set 1: 30s (no load)");
  await expect(values(page, "Hang", 1)).toHaveAccessibleName("Edit Hang set 1: 30 s · – lb (no load)");
  await check(page, "Hang", 1).tap();
  const editor = page.getByRole("dialog", { name: "Hang · set 1" });
  await expect(check(page, "Hang", 1)).toHaveAttribute("aria-pressed", "false");
  for (let i = 0; i < 5; i++) await editor.getByRole("button", { name: "Increase load" }).tap();
  await editor.getByRole("button", { name: "Log set" }).tap();
  await expect(editor).toHaveCount(0);
  await expect(check(page, "Hang", 1)).toHaveAccessibleName("Hang set 1: 30s at 25 lb");
  await expect(check(page, "Hang", 1)).toHaveAttribute("aria-pressed", "true");
  // The load carried to the next set, which the check now logs in one tap.
  await expect(values(page, "Hang", 2)).toHaveAccessibleName("Edit Hang set 2: 30 s · 25 lb");
  await check(page, "Hang", 2).tap();
  await expect(check(page, "Hang", 2)).toHaveAttribute("aria-pressed", "true");
  await expect(values(page, "Sled", 1)).toHaveAccessibleName("Edit Sled set 1: 40 m · – lb (no load)");
  await expect(values(page, "Curl", 1)).toHaveAccessibleName("Edit Curl set 1: 10 × – lb (no load)");
  await expect(values(page, "Pull-up", 1)).toHaveAccessibleName("Edit Pull-up set 1: 10 reps");
  await check(page, "Bench press", 1).tap();
  await expect(check(page, "Bench press", 1)).toHaveAttribute("aria-pressed", "true");
  await expect(notifications(page).getByRole("button", { name: /^Finish · / })).toBeVisible();

  await page.waitForTimeout(600); // entrances
  const results = await new AxeBuilder({ page }).withRules(["label-content-name-mismatch", "nested-interactive", "aria-allowed-attr", "list", "listitem"]).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
});

test("the header says the week in plain words and links to the program", async ({ page }) => {
  const link = page.getByRole("link", { name: "Program: Week 1 of 5" });
  await expect(link).toBeVisible();
  await expect(link).toHaveText("Week 1 of 5");
  await expect(link).toHaveAttribute("href", "/program");
});

test("Finish from the dock asks about unlogged sets, then completes the session", async ({ page }) => {
  const finish = notifications(page).getByRole("button", { name: /^Finish · / });
  await expect(finish).toHaveCount(0); // nothing logged yet
  await check(page, "Bench press", 1).tap();
  await expect(finish).toHaveAccessibleName("Finish · 1/4 sets");
  await expect(finish).toBeInViewport({ ratio: 1 });
  // The page's own button is still at the end of the page.
  await expect(page.getByRole("button", { name: "Finish session" })).toBeEnabled();

  await finish.tap();
  const question = page.getByRole("group", { name: /Finish with 3 sets unlogged\?/ });
  await expect(question).toBeInViewport({ ratio: 1 });
  await expect(finish).toHaveCount(0); // it steps aside while the question is asked
  await question.getByRole("button", { name: "Keep logging" }).tap();
  await expect(finish).toBeVisible();

  await finish.tap();
  await page
    .getByRole("group", { name: /unlogged\?/ })
    .getByRole("button", { name: "Finish" })
    .tap();
  await expect(page.getByRole("heading", { name: "Session complete" })).toBeInViewport();
  await expect(finish).toHaveCount(0);
  await expectSynced(page);
  await expect.poll(async () => !!(await serverData(page)).sessions.find((s) => s.date === MONDAY_ISO)?.completedAt).toBe(true);
});

test("exercise options list actions by frequency: log, sets, superset, skip, edit exercise, remove", async ({ page }) => {
  await addPullUp(page);
  await page.getByRole("button", { name: "Pull-up options" }).tap();
  let sheet = page.getByRole("dialog", { name: "Pull-up" });
  await expect(sheet.getByRole("button", { name: /^Remove —/ })).toBeVisible();
  expect((await buttonNames(sheet)).map((n) => n.replace(/\s+/g, " "))).toEqual([
    expect.stringMatching(/^Log remaining sets/),
    "Edit set 1: 10 reps",
    "Delete set 1",
    "Edit set 2: 10 reps",
    "Delete set 2",
    "Edit set 3: 10 reps",
    "Delete set 3",
    expect.stringMatching(/^Superset with another exercise/),
    expect.stringMatching(/^Skip today/),
    expect.stringMatching(/^Edit exercise/),
    expect.stringMatching(/^Remove — also from future Mondays/),
  ]);

  // In a superset: the superset's own actions sit between the sets and Skip.
  await sheet.getByRole("button", { name: /^Superset with another exercise/ }).tap();
  const pair = page.getByRole("dialog", { name: "New superset" });
  await pair.getByRole("button", { name: "Add another exercise" }).tap();
  const add = page.getByRole("dialog", { name: /^Add to/ });
  await add.getByRole("textbox", { name: "Search or create exercise" }).fill("Dips");
  await add.getByRole("group", { name: "Load" }).getByRole("button", { name: "Unweighted", exact: true }).tap();
  await add.getByRole("button", { name: /Create & add/ }).tap();
  const superset = page.getByRole("dialog", { name: "Superset A" });
  await expect(superset).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(superset).toHaveCount(0);
  // Rows inside a superset follow the same grammar.
  await check(page, "Dips", 1).tap();
  await expect(check(page, "Dips", 1)).toHaveAttribute("aria-pressed", "true");

  await page.getByRole("button", { name: "Pull-up options" }).tap();
  sheet = page.getByRole("dialog", { name: "Pull-up" });
  await expect(sheet.getByRole("button", { name: /^Remove —/ })).toBeVisible();
  const names = (await buttonNames(sheet)).map((n) => n.replace(/\s+/g, " ")).filter((n) => !/^(Edit|Delete) set \d/.test(n));
  expect(names).toEqual([
    expect.stringMatching(/^Log remaining sets/),
    expect.stringMatching(/^Log next round of Superset A/),
    expect.stringMatching(/^Log all of Superset A/),
    expect.stringMatching(/^Manage Superset A/),
    expect.stringMatching(/^Remove from superset/),
    expect.stringMatching(/^Skip today/),
    expect.stringMatching(/^Edit exercise/),
    expect.stringMatching(/^Remove — also from future Mondays/),
  ]);
});
