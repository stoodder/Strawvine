/**
 * Progress is five views behind one segmented control (Week · Body · Fuel · Activity · Strength):
 * - the view lives in the URL (`/progress?view=body`; Week is the bare path), so a reload, a deep
 *   link and Back from another screen land on it;
 * - the control stays in reach while a view scrolls, and a view opened from a scrolled page starts
 *   at its top; where five tabs don't fit it scrolls inside itself, never the page;
 * - Body, Fuel and Activity share one chart range;
 * - Fuel's energy balance ends yesterday: logging today's food moves neither line nor "Latest".
 */
import type { Page } from "@playwright/test";
import { expect, expectSynced, fillNumber, MONDAY, onboardedOn, pageOverflow, seedHistory, serverData, test } from "./helpers";

const tab = (page: Page, name: string) => page.getByRole("tab", { name, exact: true });
const section = (page: Page, name: string) => page.locator("section").filter({ has: page.getByRole("heading", { name, exact: true }) });
const selected = (page: Page) => page.getByRole("tab", { selected: true });

/** Each view's tab, its `?view=` value and the heading of its first section. */
const VIEWS = [
  ["Week", null, "Weekly check-in"],
  ["Body", "body", "Bodyweight"],
  ["Fuel", "fuel", "Energy balance"],
  ["Activity", "activity", "Steps"],
  ["Strength", "strength", "Maxes"],
] as const;
const urlOf = (view: string | null) => new RegExp(view ? `/progress\\?view=${view}$` : "/progress$");

test("views switch from the tablist, live in the URL, and survive a reload, a deep link and Back", async ({ page }) => {
  await onboardedOn(page, MONDAY);
  await seedHistory(page);
  await page.goto("/");
  await page.getByRole("link", { name: "Progress" }).click();

  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Progress");
  await expect(page.getByRole("tablist", { name: "Progress views" }).getByRole("tab")).toHaveText(VIEWS.map(([name]) => name));
  // Week by default: the verdict leads, the tiles follow in groups.
  await expect(selected(page)).toHaveText("Week");
  await expect(page).toHaveURL(urlOf(null));
  const checkin = section(page, "Weekly check-in");
  await expect(checkin.locator("[data-verdict]")).toHaveText(
    /^(On plan|Faster than plan|Slower than plan|Wrong direction) · [+−]?\d+\.\d lb this week against −\d\.\d/,
  );
  await expect(checkin.getByRole("heading", { level: 3 })).toHaveText(["Body", "Fuel", "Activity", "Recovery"]);
  await expect(checkin.getByText("Next week")).toBeVisible();

  for (const [name, view, heading] of VIEWS) {
    await tab(page, name).click();
    await expect(selected(page)).toHaveText(name);
    await expect(page).toHaveURL(urlOf(view));
    // One view at a time, in a panel named by its tab.
    await expect(page.getByRole("tabpanel", { name })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2 }).first()).toHaveText(heading);
    for (const [, , other] of VIEWS)
      if (other !== heading) await expect(page.getByRole("heading", { name: other, exact: true })).toHaveCount(0);
    // A reload keeps the view.
    await page.reload();
    await expect(selected(page)).toHaveText(name);
    await expect(page.getByRole("heading", { level: 2 }).first()).toHaveText(heading);
  }

  // Strength (where the loop ended): maxes with the seeded bench target, read-only; Goals edits it.
  const bench = page.getByRole("button", { name: /^Bench press/ });
  await expect(bench).toContainText("Target 275");
  await expect(bench).toContainText("50 lb to go");
  await page.getByRole("link", { name: "Edit targets in Goals" }).click();
  await expect(page).toHaveURL(/\/goals$/);
  await expect(page.getByRole("tablist", { name: "Progress views" })).toHaveCount(0);
  // Back returns to the view that was left, not to Week.
  await page.goBack();
  await expect(page).toHaveURL(urlOf("strength"));
  await expect(selected(page)).toHaveText("Strength");
  // A row still opens the lift's max sheet.
  await bench.click();
  await expect(page.getByRole("dialog", { name: "Bench press" }).getByRole("textbox", { name: "New max" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // Keyboard: one tab stop, the arrows move and select.
  await selected(page).focus();
  await page.keyboard.press("ArrowLeft");
  await expect(selected(page)).toHaveText("Activity");
  await expect(tab(page, "Activity")).toBeFocused();
  await expect(page).toHaveURL(urlOf("activity"));
  await page.keyboard.press("Home");
  await expect(selected(page)).toHaveText("Week");
  await expect(page).toHaveURL(urlOf(null));

  // A deep link opens its view; the tab bar's Progress goes to the week.
  await page.goto("/progress?view=fuel");
  await expect(selected(page)).toHaveText("Fuel");
  await expect(section(page, "Energy balance").getByRole("img")).toBeVisible();
  await page.getByRole("link", { name: "Progress" }).click();
  await expect(selected(page)).toHaveText("Week");
});

test("the control stays in reach while a view scrolls, and scrolls inside itself when narrow", async ({ page }) => {
  await onboardedOn(page, MONDAY);
  await seedHistory(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/progress");
  const list = page.getByRole("tablist", { name: "Progress views" });
  await expect(list).toBeVisible();
  const nav = page.getByRole("navigation", { name: "Primary" });

  // Scrolled deep into the week: the control is stuck at the top, clear of the bottom nav.
  await page.evaluate(() => window.scrollTo(0, 700));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(400);
  const stuck = (await list.boundingBox())!;
  expect(stuck.y).toBeGreaterThanOrEqual(0);
  expect(stuck.y).toBeLessThan(24);
  expect(stuck.y + stuck.height).toBeLessThan((await nav.boundingBox())!.y);

  // Another view from there starts at its top, under the control — not scrolled away, not hidden by it.
  await tab(page, "Body").click();
  const heading = page.getByRole("heading", { name: "Bodyweight", exact: true });
  await expect(heading).toBeInViewport();
  const [bar, head] = [(await list.boundingBox())!, (await heading.boundingBox())!];
  expect(head.y).toBeGreaterThanOrEqual(bar.y + bar.height);
  expect(head.y).toBeLessThan(bar.y + bar.height + 80);
  await expect(page.getByRole("group", { name: "Chart range" })).toBeInViewport();

  // Every view fits a 390, a 320 and a 195 px (200 % zoom) screen; the selected tab is in sight.
  for (const [width, height] of [
    [390, 844],
    [320, 568],
    [195, 422],
  ] as const) {
    await page.setViewportSize({ width, height });
    for (const [name, view] of VIEWS) {
      await page.goto(view ? `/progress?view=${view}` : "/progress");
      await expect(selected(page)).toHaveText(name);
      await expect(selected(page)).toBeInViewport({ ratio: 1 });
      expect(await pageOverflow(page), `${name} at ${width} px`).toBeNull();
    }
    // Down to a 320 px phone all five tabs fit: the control doesn't scroll.
    if (width >= 320) expect(await list.evaluate((el) => el.scrollWidth - el.clientWidth), `tabs at ${width} px`).toBeLessThanOrEqual(0);
  }
  // At 195 px five tabs don't fit: the control scrolls sideways itself, and follows the selection.
  expect(await list.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  await expect(tab(page, "Week")).not.toBeInViewport({ ratio: 1 });
  await selected(page).focus();
  await page.keyboard.press("Home");
  await expect(tab(page, "Week")).toBeInViewport({ ratio: 1 });
  expect(await pageOverflow(page)).toBeNull();
});

test("one chart range across Body, Fuel and Activity", async ({ page }) => {
  await onboardedOn(page, MONDAY);
  // Seven weeks (from Sep 7), so 30 days, 90 days and All start on different days.
  await seedHistory(page, { weeks: 7 });
  await page.goto("/progress?view=body");
  const range = page.getByRole("group", { name: "Chart range" });
  const pressed = range.locator("[aria-pressed=true]");
  const chart = page.getByRole("tabpanel").getByRole("img");

  await expect(pressed).toHaveText("30");
  await expect(chart).toHaveAttribute("aria-label", /^Bodyweight, Sep 27 to Oct 26\./);
  await range.getByRole("button", { name: "90 days" }).click();
  await expect(chart).toHaveAttribute("aria-label", /^Bodyweight, Jul 29 to Oct 26\./);

  // Fuel: the same range, already applied; its lines end yesterday (Oct 25).
  await tab(page, "Fuel").click();
  await expect(pressed).toHaveText("90");
  await expect(chart).toHaveAttribute("aria-label", /^Energy balance, Jul 29 to Oct 25\./);
  await range.getByRole("button", { name: "All time" }).click();
  await expect(chart).toHaveAttribute("aria-label", /^Energy balance, Sep 7 to Oct 25\./);

  await tab(page, "Activity").click();
  await expect(pressed).toHaveText("All");
  await expect(chart).toHaveAttribute("aria-label", /^Steps, Sep 7 to Oct 26\./);

  // Week and Strength have no charts and no range control; coming back, the range held.
  for (const name of ["Week", "Strength"]) {
    await tab(page, name).click();
    await expect(selected(page)).toHaveText(name);
    await expect(range).toHaveCount(0);
  }
  await tab(page, "Body").click();
  await expect(pressed).toHaveText("All");
  await expect(chart).toHaveAttribute("aria-label", /^Bodyweight, Sep 7 to Oct 26\./);
});

test("logging today's weight and calories leaves Fuel's energy balance (and its Latest) alone", async ({ page }) => {
  await onboardedOn(page, MONDAY);
  await seedHistory(page);
  await page.goto("/progress?view=fuel");
  const energy = section(page, "Energy balance");
  const chart = energy.getByRole("img");
  const readout = energy.locator("[aria-live=polite]");
  // Through yesterday (Sunday Oct 25), with nothing logged today yet.
  await expect(chart).toHaveAttribute(
    "aria-label",
    /^Energy balance, Sep 27 to Oct 25\. Intake [\d,]+ to [\d,]+\. TDEE [\d,]+ to [\d,]+\./,
  );
  await expect(readout).toHaveText(/^Intake[\d,]+TDEE[\d,]+Latest$/);
  const before = { label: await chart.getAttribute("aria-label"), readout: await readout.innerText() };

  // This morning: a weigh-in and breakfast (a fifth of a day's calories) — a logged day, half eaten.
  await page.goto("/");
  const log = async (row: RegExp, field: string, value: string) => {
    const button = page.getByRole("button", { name: row });
    await button.click();
    await fillNumber(page, field, value);
    await button.click(); // close the editor
  };
  await log(/^Morning check-in/, "Morning weight", "197");
  await log(/^Nutrition/, "Calories", "450");
  await expectSynced(page);
  const today = (await serverData(page)).days.find((d) => d.date === "2026-10-26");
  expect(today).toMatchObject({ weightLb: 197, calories: 450 });

  await page.getByRole("link", { name: "Progress" }).click();
  await tab(page, "Fuel").click();
  await expect(chart).toBeVisible();
  expect(await chart.getAttribute("aria-label")).toBe(before.label);
  expect(await readout.innerText()).toBe(before.readout);
  // The table has no row for today either.
  await energy.getByRole("button", { name: "Table" }).click();
  await expect(energy.getByRole("table").getByRole("row").nth(1)).toHaveText(/^Oct 25/);
  await expect(energy.getByRole("table").getByRole("row", { name: /^Oct 26/ })).toHaveCount(0);
  // Today is on the intake strip, as "so far".
  await expect(energy.getByText(/^Today so far: 450 of [\d,]+ kcal/)).toHaveCount(1);
  // And the bodyweight chart, where today's weigh-in is a finished reading, does include it.
  await tab(page, "Body").click();
  await expect(section(page, "Bodyweight").getByRole("img")).toHaveAttribute("aria-label", /^Bodyweight, Sep 27 to Oct 26\./);
  await expect(section(page, "Bodyweight").locator("[aria-live=polite]")).toHaveText(/^Scale197\.0Trend[\d.]+Latest$/);
});
