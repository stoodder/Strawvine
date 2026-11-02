/**
 * Managing supersets within a workout (§6.5): an exercise already in the workout joins a superset
 * (with its sets), a superset's order changes (A1, A2… — the order a round is logged in), one
 * comes out of the superset into a block of its own, and the workout's blocks are reordered — all
 * with Move up / Move down buttons, announced in the sheet's live region. The server holds the new
 * structure, and next week's pre-fill keeps it.
 */
import type { Page } from "@playwright/test";
import { expect, expectSynced, MONDAY, MONDAY_ISO, notifications, onboardedOn, serverData, test, toastMessage } from "./helpers";

/** The Monday after the suite's first one: Push again. */
const NEXT_MONDAY = new Date(2026, 10, 2, 10, 0, 0);

test.beforeEach(async ({ page }) => {
  await onboardedOn(page, MONDAY);
  await page.getByRole("link", { name: "Train" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Push/);
});

/** Create an unweighted rep accessory (a tap logs its sets) and add it to today's session. */
async function create(page: Page, name: string) {
  await page.getByRole("button", { name: "Exercise", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Add exercise" });
  await sheet.getByRole("textbox", { name: "Search or create exercise" }).fill(name);
  await sheet.getByRole("group", { name: "Load" }).getByRole("button", { name: "Unweighted", exact: true }).click();
  await sheet.getByRole("button", { name: /Create & add/ }).click();
  await expect(sheet).toHaveCount(0);
}

/** The accessories as the page lists them, in order (each exercise's options button). */
const pageOrder = (page: Page) =>
  page.locator('[data-control="options"]').evaluateAll((els) => els.map((el) => el.getAttribute("aria-label")!.replace(/ options$/, "")));

/** The accessory blocks of a session on the server, as exercise names. */
async function serverBlocks(page: Page, date: string) {
  const { sessions, exercises } = await serverData(page);
  const name = (id: number) => exercises.find((e) => e.id === id)!.name;
  return sessions
    .find((s) => s.date === date)!
    .blocks.filter((b) => b.kind === "accessory")
    .map((b) => b.exercises.map((e) => `${name(e.exerciseId)}${e.sets.some((s) => s.done) ? "*" : ""}`));
}

const members = (sheet: ReturnType<Page["getByRole"]>) => sheet.getByRole("list").first().getByRole("listitem");

test("superset existing exercises, reorder, move a block, take one out, log a round; next week keeps it", async ({ page }) => {
  for (const name of ["Rows", "Curls", "Dips"]) await create(page, name);
  expect(await pageOrder(page)).toEqual(["Rows", "Curls", "Dips"]);

  // Rows' options → pair it with Curls, from this workout.
  await page.getByRole("button", { name: "Rows options" }).click();
  await page
    .getByRole("dialog", { name: "Rows" })
    .getByRole("button", { name: /^Superset with another exercise/ })
    .click();
  let sheet = page.getByRole("dialog", { name: "New superset" });
  await sheet.getByRole("button", { name: "Superset Rows with Curls" }).click();
  sheet = page.getByRole("dialog", { name: "Superset A" });
  await expect(sheet.getByRole("status")).toHaveText("Curls added to Superset A as A2");
  // Dips joins too (A3), then moves to the front.
  await sheet.getByRole("button", { name: "Add Dips to Superset A" }).click();
  await expect(members(sheet)).toHaveText([/^A1: Rows/, /^A2: Curls/, /^A3: Dips/]);
  await expect(sheet.getByRole("button", { name: "Move Dips up in Superset A" })).toBeFocused();
  await sheet.getByRole("button", { name: "Move Dips up in Superset A" }).press("Enter");
  await expect(sheet.getByRole("status")).toHaveText("Dips moved up · now A2 of 3");
  await page.keyboard.press("Enter"); // focus stays on the button that moved
  await expect(sheet.getByRole("status")).toHaveText("Dips moved up · now A1 of 3");
  await expect(members(sheet)).toHaveText([/^A1: Dips/, /^A2: Rows/, /^A3: Curls/]);
  // Nothing left to add from this workout.
  await expect(sheet.getByText("No other accessories in this workout yet.")).toBeVisible();

  // Rows out of the superset: it gets its own block, right after.
  await sheet.getByRole("button", { name: "Remove Rows from Superset A" }).click();
  await expect(sheet.getByRole("status")).toHaveText("Rows removed from Superset A · now right after it");
  await expect(members(sheet)).toHaveText([/^A1: Dips/, /^A2: Curls/]);
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  expect(await pageOrder(page)).toEqual(["Dips", "Curls", "Rows"]);

  // The workout order: Rows before the superset (the main lift stays first).
  await page.getByRole("button", { name: "Reorder workout" }).click();
  const order = page.getByRole("dialog", { name: "Workout order" });
  await expect(order.getByRole("listitem")).toHaveText([/^Main lift\s*Bench press/, /^Superset A: Dips.*Curls/, /^Rows$/]);
  await order.getByRole("button", { name: "Move Rows up in workout" }).click();
  await expect(order.getByRole("status")).toHaveText("Rows moved up · 1 of 2");
  await expect(order.getByRole("button", { name: "Move Rows up in workout" })).toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Escape");
  await expect(order).toHaveCount(0);
  expect(await pageOrder(page)).toEqual(["Rows", "Dips", "Curls"]);

  // A round of Superset A, in its new order: Dips, then Curls.
  await page.getByRole("button", { name: "Manage Superset A" }).click();
  await expect(page.getByRole("dialog", { name: "Superset A" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Manage Superset A" })).toBeFocused();
  await page.getByRole("button", { name: "Dips options" }).click();
  await page
    .getByRole("dialog", { name: "Dips" })
    .getByRole("button", { name: /^Log next round of Superset A/ })
    .click();
  await expect(toastMessage(page, "Superset A · round logged")).toBeVisible();
  for (const name of ["Dips", "Curls"])
    await expect(page.getByRole("button", { name: new RegExp(`^${name} set 1:`) })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: /^Rows set 1:/ })).toHaveAttribute("aria-pressed", "false");

  await expectSynced(page);
  expect(await serverBlocks(page, MONDAY_ISO)).toEqual([["Rows"], ["Dips*", "Curls*"]]);

  // Next Monday: pre-filled with the same structure and order.
  await page.clock.setSystemTime(NEXT_MONDAY);
  await page.goto("/train");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Push/);
  expect(await pageOrder(page)).toEqual(["Rows", "Dips", "Curls"]);
  await page.getByRole("button", { name: "Manage Superset A" }).click();
  await expect(members(page.getByRole("dialog", { name: "Superset A" }))).toHaveText([/^A1: Dips/, /^A2: Curls/]);
});

test("Remove from superset (exercise options) is undoable; removing from the workout is separate", async ({ page }) => {
  for (const name of ["Rows", "Curls"]) await create(page, name);
  await page.getByRole("button", { name: "Rows options" }).click();
  await page
    .getByRole("dialog", { name: "Rows" })
    .getByRole("button", { name: /^Superset with another exercise/ })
    .click();
  await page.getByRole("dialog", { name: "New superset" }).getByRole("button", { name: "Superset Rows with Curls" }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Manage Superset A" })).toBeVisible();

  // Log a Curls set, then take Curls out: it keeps its logged set.
  await page.getByRole("button", { name: /^Curls set 1:/ }).click();
  await expect(page.getByRole("button", { name: /^Curls set 1:/ })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Curls options" }).click();
  const options = page.getByRole("dialog", { name: "Curls" });
  await expect(options.getByRole("button", { name: /^Manage Superset A/ })).toBeVisible();
  await expect(options.getByRole("button", { name: /^Remove — also from future/ })).toBeVisible();
  await options.getByRole("button", { name: /^Remove from superset/ }).click();
  await expect(options).toHaveCount(0);
  await expect(toastMessage(page, "Curls removed from Superset A")).toBeVisible();
  await expect(page.getByRole("button", { name: "Manage Superset A" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Curls options" })).toBeFocused();
  await expect(page.getByRole("button", { name: /^Curls set 1:/ })).toHaveAttribute("aria-pressed", "true");
  await expectSynced(page);
  expect(await serverBlocks(page, MONDAY_ISO)).toEqual([["Rows"], ["Curls*"]]);

  await notifications(page).getByRole("button", { name: "Undo" }).click();
  await expect(page.getByRole("button", { name: "Manage Superset A" })).toBeVisible();
  await expectSynced(page);
  expect(await serverBlocks(page, MONDAY_ISO)).toEqual([["Rows", "Curls*"]]);
});

test("a new exercise added from the superset sheet; the sheet comes back with it", async ({ page }) => {
  await create(page, "Rows");
  await page.getByRole("button", { name: "Rows options" }).click();
  await page
    .getByRole("dialog", { name: "Rows" })
    .getByRole("button", { name: /^Superset with another exercise/ })
    .click();
  await page.getByRole("dialog", { name: "New superset" }).getByRole("button", { name: "Add another exercise" }).click();
  const add = page.getByRole("dialog", { name: "Add to superset" });
  await add.getByRole("textbox", { name: "Search or create exercise" }).fill("Face pull");
  await add.getByRole("button", { name: /Create & add/ }).click();
  const sheet = page.getByRole("dialog", { name: "Superset A" });
  await expect(sheet.getByRole("status")).toHaveText("Face pull added to Superset A as A2");
  await expect(members(sheet)).toHaveText([/^A1: Rows/, /^A2: Face pull/]);
  // Focus is on the new member (not the panel), like an exercise added from this workout.
  await expect(sheet.getByRole("button", { name: "Move Face pull up in Superset A" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expectSynced(page);
  expect(await serverBlocks(page, MONDAY_ISO)).toEqual([["Rows", "Face pull"]]);
});

/** Rows + the others in Superset A (from Rows' options), the sheet left open. */
async function supersetOf(page: Page, ...others: string[]) {
  await page.getByRole("button", { name: "Rows options" }).click();
  await page
    .getByRole("dialog", { name: "Rows" })
    .getByRole("button", { name: /^Superset with another exercise/ })
    .click();
  await page.getByRole("dialog", { name: "New superset" }).getByRole("button", { name: `Superset Rows with ${others[0]}` }).click();
  const sheet = page.getByRole("dialog", { name: "Superset A" });
  for (const o of others.slice(1)) await sheet.getByRole("button", { name: `Add ${o} to Superset A` }).click();
  await expect(members(sheet)).toHaveText(["Rows", ...others].map((n, i) => new RegExp(`^A${i + 1}: ${n}`)));
  return sheet;
}

test("Add from this workout takes the one picked (not the first offered)", async ({ page }) => {
  for (const name of ["Rows", "Curls", "Dips"]) await create(page, name);
  await page.getByRole("button", { name: "Rows options" }).click();
  await page
    .getByRole("dialog", { name: "Rows" })
    .getByRole("button", { name: /^Superset with another exercise/ })
    .click();
  const start = page.getByRole("dialog", { name: "New superset" });
  await expect(start.locator("[data-candidate]")).toHaveText([/^Curls/, /^Dips/]);
  await start.getByRole("button", { name: "Superset Rows with Dips" }).click();
  const sheet = page.getByRole("dialog", { name: "Superset A" });
  await expect(members(sheet)).toHaveText([/^A1: Rows/, /^A2: Dips/]);
  await expect(sheet.getByRole("button", { name: "Move Dips up in Superset A" })).toBeFocused();
  await expect(sheet.locator("[data-candidate]")).toHaveText([/^Curls/]);
  await page.keyboard.press("Escape");
  expect(await pageOrder(page)).toEqual(["Rows", "Dips", "Curls"]);
  await expectSynced(page);
  expect(await serverBlocks(page, MONDAY_ISO)).toEqual([["Rows", "Dips"], ["Curls"]]);
});

test("Add another exercise doesn't add what's already there: members and the main lift are disabled, one from this workout moves in", async ({
  page,
}) => {
  for (const name of ["Rows", "Curls", "Dips"]) await create(page, name);
  // Curls has a logged set: it keeps it when it moves.
  await page.getByRole("button", { name: /^Curls set 1:/ }).click();
  await expect(page.getByRole("button", { name: /^Curls set 1:/ })).toHaveAttribute("aria-pressed", "true");
  const sheet = await supersetOf(page, "Dips");
  await sheet.getByRole("button", { name: "Add another exercise" }).click();
  const add = page.getByRole("dialog", { name: "Add to Superset A" });
  const pick = (name: string) => add.getByRole("button", { name: new RegExp(`^${name}\\b`) });
  for (const name of ["Rows", "Dips"]) {
    await expect(pick(name)).toHaveAttribute("aria-disabled", "true");
    await expect(pick(name)).toContainText("Already in Superset A");
  }
  await expect(pick("Bench press")).toHaveAttribute("aria-disabled", "true");
  await expect(pick("Bench press")).toContainText("Main lift");
  await expect(pick("Curls")).toContainText("In this workout · moves here");
  await expect(pick("Curls")).not.toHaveAttribute("aria-disabled");
  // A disabled one does nothing.
  await pick("Rows").click({ force: true });
  await pick("Bench press").click({ force: true });
  await expect(add).toBeVisible();
  await pick("Curls").click();
  await expect(add).toHaveCount(0);
  await expect(sheet.getByRole("status")).toHaveText("Curls added to Superset A as A3");
  await expect(members(sheet)).toHaveText([/^A1: Rows/, /^A2: Dips/, /^A3: Curls.*1 logged/]);
  await expect(sheet.getByRole("button", { name: "Move Curls up in Superset A" })).toBeFocused();
  await page.keyboard.press("Escape");
  expect(await pageOrder(page)).toEqual(["Rows", "Dips", "Curls"]);
  await expectSynced(page);
  expect(await serverBlocks(page, MONDAY_ISO)).toEqual([["Rows", "Dips", "Curls*"]]);
});

test("a full superset says so; nothing more can be added", async ({ page }) => {
  const names = ["Rows", "Curls", "Dips", "Flyes", "Shrugs", "Raises"];
  for (const name of names) await create(page, name);
  const sheet = await supersetOf(page, ...names.slice(1));
  await expect(sheet.getByText("A superset holds up to 6 exercises")).toBeVisible();
  await expect(sheet.getByText("No other accessories in this workout yet.")).toHaveCount(0);
  const add = sheet.getByRole("button", { name: "Add another exercise" });
  await expect(add).toHaveAttribute("aria-disabled", "true");
  await add.click({ force: true }); // aria-disabled: Playwright would wait for it to be enabled
  await expect(page.getByRole("dialog", { name: /^Add to/ })).toHaveCount(0);
  await expect(sheet).toBeVisible();
});

test("Remove from superset, undone from the sheet and from the toast: A1 is A1 again", async ({ page }) => {
  for (const name of ["Rows", "Curls", "Dips"]) await create(page, name);
  const sheet = await supersetOf(page, "Curls", "Dips");

  // In the sheet: a visible Remove, and the sheet's own Undo.
  const remove = sheet.getByRole("button", { name: "Remove Rows from Superset A" });
  await expect(remove).toHaveText("Remove");
  await remove.click();
  await expect(sheet.getByRole("status")).toHaveText("Rows removed from Superset A · now right after it");
  await expect(members(sheet)).toHaveText([/^A1: Curls/, /^A2: Dips/]);
  await sheet.getByRole("button", { name: "Undo removing Rows" }).click();
  await expect(members(sheet)).toHaveText([/^A1: Rows/, /^A2: Curls/, /^A3: Dips/]);
  await expect(sheet.getByRole("status")).toHaveText("Rows back in Superset A as A1");
  await expect(sheet.getByRole("button", { name: "Remove Rows from Superset A" })).toBeFocused();
  await expectSynced(page);
  expect(await serverBlocks(page, MONDAY_ISO)).toEqual([["Rows", "Curls", "Dips"]]);

  // Removed in the sheet, then the sheet closed: the Undo is the toast's now.
  await sheet.getByRole("button", { name: "Remove Rows from Superset A" }).click();
  await expect(members(sheet)).toHaveText([/^A1: Curls/, /^A2: Dips/]);
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Manage Superset A" })).toBeFocused();
  expect(await pageOrder(page)).toEqual(["Curls", "Dips", "Rows"]);
  await expect(toastMessage(page, "Rows removed from Superset A")).toBeVisible();
  await notifications(page).getByRole("button", { name: "Undo" }).click();
  await expect.poll(() => pageOrder(page)).toEqual(["Rows", "Curls", "Dips"]);
  await expect(page.getByRole("button", { name: "Rows options" })).toBeFocused();

  // From the exercise's options: the toast's Undo puts A1 back as A1.
  await page.getByRole("button", { name: "Rows options" }).click();
  await page
    .getByRole("dialog", { name: "Rows" })
    .getByRole("button", { name: /^Remove from superset/ })
    .click();
  await expect(toastMessage(page, "Rows removed from Superset A")).toBeVisible();
  expect(await pageOrder(page)).toEqual(["Curls", "Dips", "Rows"]);
  await notifications(page).getByRole("button", { name: "Undo" }).click();
  await expect.poll(() => pageOrder(page)).toEqual(["Rows", "Curls", "Dips"]);
  await page.getByRole("button", { name: "Manage Superset A", exact: true }).click();
  await expect(members(page.getByRole("dialog", { name: "Superset A" }))).toHaveText([/^A1: Rows/, /^A2: Curls/, /^A3: Dips/]);
  await page.keyboard.press("Escape");
  await expectSynced(page);
  expect(await serverBlocks(page, MONDAY_ISO)).toEqual([["Rows", "Curls", "Dips"]]);
});

test("Add another exercise cancelled: back in the superset sheet, and Escape gives focus back to its header", async ({ page }) => {
  for (const name of ["Rows", "Curls"]) await create(page, name);
  await supersetOf(page, "Curls");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Manage Superset A" }).click();
  const sheet = page.getByRole("dialog", { name: "Superset A" });
  await sheet.getByRole("button", { name: "Add another exercise" }).click();
  const add = page.getByRole("dialog", { name: "Add to Superset A" });
  await expect(add.getByRole("textbox", { name: "Search or create exercise" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(add).toHaveCount(0);
  await expect(sheet.getByRole("button", { name: "Add another exercise" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Manage Superset A" })).toBeFocused();
});
