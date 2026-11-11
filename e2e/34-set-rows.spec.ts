/**
 * One set-row grammar on Train, by touch and with no hidden gesture: every set — main lift and
 * accessory — is a row whose check (right) logs / unlogs it (no toast: the check undoes itself;
 * unlogging the set that started the rest stops the rest) and whose values (left) open the set
 * editor. Finish joins the dock once every set is logged and the page's own button is off screen,
 * and the exercise options list their actions by how often they're used. Monday of week 1 (bench
 * press, AMRAP last set).
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

  // Accessory: the same two controls, compact. A check leaves no toast (it is its own undo):
  // the dock holds the rest pill and nothing else.
  await expect(check(page, "Pull-up", 1)).toHaveAccessibleName("Pull-up set 1: 10 reps");
  await check(page, "Pull-up", 1).tap();
  await expect(check(page, "Pull-up", 1)).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("group", { name: "Rest timer" })).toBeVisible();
  await expect(notifications(page).getByRole("button", { name: "Undo" })).toHaveCount(0);
  await expect(toastMessage(page, /logged/)).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // Unlogging the set that started the rest stops it; logging it again starts a new one.
  await check(page, "Pull-up", 1).tap();
  await expect(check(page, "Pull-up", 1)).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("group", { name: "Rest timer" })).toHaveCount(0);
  await expect(toastMessage(page, /unlogged/)).toHaveCount(0);
  await check(page, "Pull-up", 1).tap();
  await expect(check(page, "Pull-up", 1)).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("group", { name: "Rest timer" })).toBeVisible();

  // Edit an open set through its values: 10 → 8 reps as the target (carried to the set after it).
  await values(page, "Pull-up", 2).tap();
  editor = page.getByRole("dialog", { name: "Pull-up · set 2" });
  for (let i = 0; i < 2; i++) await editor.getByRole("button", { name: "Decrease reps" }).tap();
  await editor.getByRole("button", { name: "Save target" }).tap();
  await expect(editor).toHaveCount(0);
  // A changed value has no other undo: that save keeps its toast.
  await expect(toastMessage(page, "Pull-up · set 2 updated")).toBeVisible();
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
  // The sheet says why it opened instead of logging.
  await expect(editor.getByText("No load yet — set it to log this set")).toBeVisible();
  await expect(editor.getByRole("button", { name: "Log set" })).toHaveAccessibleDescription("No load yet — set it to log this set");
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
  // Sets are still open: Finish isn't in the dock.
  await expect(notifications(page).getByRole("button", { name: /^Finish · / })).toHaveCount(0);

  await page.waitForTimeout(600); // entrances
  const results = await new AxeBuilder({ page }).withRules(["label-content-name-mismatch", "nested-interactive", "aria-allowed-attr", "list", "listitem"]).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
});

test("the header says the week in plain words and links to the program — the short form beside the dates at 320 px", async ({ page }) => {
  const link = page.getByRole("link", { name: "Program: Week 1 of 5" });
  await expect(link).toBeVisible();
  await expect(link).toHaveText("Week 1 of 5", { useInnerText: true });
  await expect(link).toHaveAttribute("href", "/program");

  await page.setViewportSize({ width: 320, height: 568 });
  await expect(link).toHaveText("Week 1", { useInnerText: true });
  // One row: the link sits beside the date controls, not under them.
  const sameRow = async () => {
    const a = (await link.boundingBox())!;
    const b = (await page.getByRole("button", { name: "Next day" }).boundingBox())!;
    return Math.abs(a.y - b.y) < 2 && a.x >= b.x + b.width - 0.5;
  };
  expect(await sameRow()).toBe(true);
});

test("320 px: the AMRAP row keeps its values and pencil on one line, 16 px clear of the check; “+ set” stays beside the plates", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  const amrap = page.getByRole("button", { name: /^Edit Bench press set 4: .*AMRAP/ });
  await expect(amrap).toBeVisible();
  const geometry = await amrap.evaluate((el) => {
    const pencil = el.querySelector("svg")!.getBoundingClientRect();
    const row = el.closest("li")!;
    const target = row.querySelector("button[aria-pressed]")!.getBoundingClientRect();
    const others = [...row.parentElement!.children].map((li) => li.getBoundingClientRect().height);
    return { pencil: pencil.width, gap: target.left - pencil.right, heights: others, target: [target.width, target.height] };
  });
  expect(geometry.pencil).toBe(14);
  expect(geometry.gap, "pencil → check target").toBeGreaterThanOrEqual(16);
  // No wrap: the AMRAP row is as tall as the others.
  expect(new Set(geometry.heights).size, `row heights ${geometry.heights.join(", ")}`).toBe(1);
  expect(Math.min(...geometry.target), "check target").toBeGreaterThanOrEqual(44);

  // The main lift's footer: plates and "+ set" on one line.
  const plates = (await page.getByRole("img", { name: /^Plates, Set 1, per side:/ }).boundingBox())!;
  const add = (await page.getByRole("button", { name: "Add a back-off set of Bench press" }).boundingBox())!;
  expect(add.y, "“+ set” starts above the plates' bottom edge").toBeLessThan(plates.y + plates.height);
  expect(add.y + add.height, "“+ set” ends below the plates' top edge").toBeGreaterThan(plates.y);

  // Accessory rows are 44 px with a 44 px check target; "+ set" follows as a 44 px target.
  await addPullUp(page);
  const row = await check(page, "Pull-up", 1).evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { row: el.closest("li")!.getBoundingClientRect().height, target: [r.width, r.height] };
  });
  expect(row.row).toBe(44);
  expect(Math.min(...row.target)).toBeGreaterThanOrEqual(44);
  const addSet = (await page.getByRole("button", { name: "Add Pull-up set" }).boundingBox())!;
  expect(addSet.height).toBeGreaterThanOrEqual(44);
  expect(addSet.width).toBeGreaterThanOrEqual(44);
});

test("Finish: asked from the page while sets are open; from the dock once every set is logged and the page's button is off screen", async ({ page }) => {
  const finish = notifications(page).getByRole("button", { name: /^Finish · / });
  const inline = page.getByRole("button", { name: "Finish session" });
  await addPullUp(page);
  await expect(finish).toHaveCount(0); // nothing logged yet
  await check(page, "Bench press", 1).tap();
  await expect(check(page, "Bench press", 1)).toHaveAttribute("aria-pressed", "true");
  // Sets are open: the dock is the workout's (the rest pill), Finish is at the end of the page.
  await expect(page.getByRole("group", { name: "Rest timer" })).toBeVisible();
  await expect(finish).toHaveCount(0);
  await inline.scrollIntoViewIfNeeded();
  await expect(inline).toBeEnabled();
  await inline.tap();
  const question = page.getByRole("group", { name: /Finish with 6 sets unlogged\?/ });
  await expect(question).toBeInViewport({ ratio: 1 });
  await question.getByRole("button", { name: "Keep logging" }).tap();
  await expect(inline).toBeVisible();
  await expect(finish).toHaveCount(0);

  // Log the rest: two more bench sets, the AMRAP through its counter, the pull-ups.
  for (const n of [2, 3]) await check(page, "Bench press", n).tap();
  await check(page, "Bench press", 4).tap();
  const amrap = page.getByRole("dialog", { name: /AMRAP/ });
  await amrap.getByRole("button", { name: /^Log \d+ reps$/ }).tap();
  await expect(amrap).toHaveCount(0);
  for (const n of [1, 2]) await check(page, "Pull-up", n).tap();
  await expect(finish).toHaveCount(0); // one set to go
  await check(page, "Pull-up", 3).tap();
  await expect(check(page, "Pull-up", 3)).toHaveAttribute("aria-pressed", "true");

  // Every set is logged. At the top of the page its own Finish button is off screen: the dock offers it, in the accent.
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(finish).toHaveAccessibleName("Finish · 7/7 sets");
  await expect(finish).toBeInViewport({ ratio: 1 });
  await expect(inline).not.toBeInViewport();
  expect(await finish.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
    await inline.evaluate((el) => getComputedStyle(el).backgroundColor),
  );
  // Scrolled to the end, the page's own button is there: the dock's steps aside (never both, never overlapping).
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect(inline).toBeInViewport();
  await expect(finish).toHaveCount(0);
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(finish).toBeVisible();

  // One press finishes — nothing is unlogged, so nothing is asked — and the recap comes into view.
  await finish.tap();
  await expect(page.getByText(/unlogged\?/)).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Session complete" })).toBeInViewport();
  await expect(finish).toHaveCount(0);
  await expect(page.getByRole("group", { name: "Rest timer" })).toHaveCount(0);
  await expectSynced(page);
  await expect.poll(async () => !!(await serverData(page)).sessions.find((s) => s.date === MONDAY_ISO)?.completedAt).toBe(true);

  // The finished session is a record: its logged rows read a step brighter than mid-session.
  const numeral = values(page, "Pull-up", 1).locator(".num").first();
  await expect(numeral).toHaveClass(/text-fg-2/);
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
