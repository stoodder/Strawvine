/**
 * Accessibility: axe-core (WCAG 2.x A/AA rules) on every main screen and the common sheets — no
 * serious or critical violations — with three weeks of history seeded (charts, trends, streaks,
 * carried-over accessories), on Monday of week 1 so Train has a full session.
 *
 * Contrast is actually measured: the ambient glow (body::before, a gradient behind every text
 * node) is hidden first, otherwise axe can't determine any background and files every
 * color-contrast check under "incomplete" (it then never fails). What axe still can't decide
 * (text on a gradient surface or over a chart) is measured against the rendered pixels
 * (scripts/lib/contrast.mjs) and must pass too — nothing is left undecided. High-contrast mode is
 * held to 7:1 (`color-contrast-enhanced`, WCAG AAA) on the main screens.
 */
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { formatContrast, measureTextContrast } from "../scripts/lib/contrast.mjs";
import { expect, hideAmbientGlow, MONDAY, onboardedOn, seedHistory, test } from "./helpers";

/** An axe rule result (axe-core's `Result`, without depending on axe-core directly). */
type Result = Awaited<ReturnType<AxeBuilder["analyze"]>>["violations"][number];

const WCAG_AA = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

const describeResults = (results: Result[]) =>
  results.map(
    (v) =>
      `${v.id} (${v.impact}): ${v.help}\n${v.nodes
        .map((n) => `    ${n.target.join(" ")}  ${(n.failureSummary ?? n.any[0]?.message ?? "").split("\n").at(-1)?.trim() ?? ""}`)
        .join("\n")}`,
  );

/**
 * Let entrance animations settle (an element mid-fade reports a lower contrast than it has, and
 * at opacity 0 isn't checked at all) and hide the glow. Under Playwright's fake clock Motion's
 * WAAPI fades start "in the future" and can sit at opacity 0 for seconds, so running finite
 * animations are finished outright.
 */
async function settle(page: Page) {
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    for (const a of document.getAnimations()) if (Number.isFinite(a.effect?.getComputedTiming().endTime)) a.finish();
  });
  await page.waitForTimeout(200);
  await hideAmbientGlow(page);
}

/**
 * The nodes axe couldn't decide for `rule`, measured against the rendered pixels instead: every
 * one must reach its ratio (and be measurable at all).
 */
async function expectUndecidedPass(page: Page, results: Result[], rule: string, where: string, highContrast: boolean) {
  const nodes = results.find((r) => r.id === rule)?.nodes ?? [];
  if (!nodes.length) return;
  const targets = nodes.map((n) => n.target[0]).filter((t): t is string => typeof t === "string");
  const measured = await measureTextContrast(page, { targets, highContrast });
  const failing = measured.filter((m) => m.ratio === null || m.ratio < m.required).map(formatContrast);
  expect(failing, `${rule}: nodes axe left undecided, measured on the rendered page (${where})`).toEqual([]);
  expect(measured.length, `${rule}: every undecided node measured (${where}): ${targets.join(", ")}`).toBe(targets.length);
}

async function expectNoSeriousViolations(page: Page, where: string, { minChecked = 6 } = {}) {
  await settle(page);
  const results = await new AxeBuilder({ page }).withTags(WCAG_AA).analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(describeResults(serious), `axe on ${where}`).toEqual([]);
  // Sanity: the contrast rule really decided on text (with the glow, it decided on nothing).
  const checked = results.passes.find((r) => r.id === "color-contrast")?.nodes.length ?? 0;
  expect(checked, `color-contrast checks axe decided on ${where}`).toBeGreaterThanOrEqual(minChecked);
  await expectUndecidedPass(page, results.incomplete, "color-contrast", where, false);
}

/** High-contrast mode: 7:1 for normal text, 4.5:1 for large text (WCAG 1.4.6). */
async function expectEnhancedContrast(page: Page, where: string) {
  await settle(page);
  const results = await new AxeBuilder({ page }).withRules(["color-contrast-enhanced"]).analyze();
  expect(describeResults(results.violations), `color-contrast-enhanced on ${where}`).toEqual([]);
  await expectUndecidedPass(page, results.incomplete, "color-contrast-enhanced", where, true);
}

const SCREENS = [
  ["Today", "/"],
  ["Train", "/train"],
  ["Progress", "/progress"],
  ["Progress: Body", "/progress?view=body"],
  ["Progress: Fuel", "/progress?view=fuel"],
  ["Progress: Activity", "/progress?view=activity"],
  ["Progress: Strength", "/progress?view=strength"],
  ["Goals", "/goals"],
  ["Settings", "/settings"],
] as const;

test.describe("axe: no serious or critical violations", () => {
  test.beforeEach(async ({ page }) => {
    await onboardedOn(page, MONDAY);
    await seedHistory(page);
  });

  for (const [name, path] of SCREENS)
    test(name, async ({ page }) => {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expectNoSeriousViolations(page, name);
    });

  // The checklist is an accordion (one editor open at a time): each editor on its own.
  for (const [row, field] of [
    ["Weigh-in", "Morning weight"],
    ["Nutrition", "Calories"],
    ["Steps", "Steps"],
  ] as const)
    test(`Today with the ${row} editor open`, async ({ page }) => {
      await page.goto("/");
      await page
        .locator("button[aria-controls]")
        .filter({ hasText: new RegExp(`^${row}`) })
        .click();
      await expect(page.getByRole("textbox", { name: field })).toBeVisible();
      await expectNoSeriousViolations(page, `Today, ${row} editor open`);
    });

  test("Goals: new strength target sheet", async ({ page }) => {
    await page.goto("/goals");
    await page.getByRole("button", { name: "Add strength target" }).click();
    await expect(page.getByRole("dialog", { name: "New strength target" })).toBeVisible();
    // Behind a sheet the page is inert (axe skips it): only the sheet's own text is checked.
    await expectNoSeriousViolations(page, "the new strength target sheet", { minChecked: 0 });
  });

  test("Settings: edit exercise sheet (an accessory, and a main lift the program locks)", async ({ page }) => {
    for (const name of ["Sandbag carry", "Bench press"]) {
      await page.goto("/settings");
      await page.getByRole("button", { name: `Edit ${name}`, exact: true }).click();
      const sheet = page.getByRole("dialog", { name: `Edit ${name}` });
      await expect(sheet.getByRole("textbox", { name: "Name" })).toHaveValue(name);
      await expectNoSeriousViolations(page, `the edit exercise sheet (${name})`, { minChecked: 0 });
    }
  });

  test("Train: add exercise sheet and the AMRAP sheet", async ({ page }) => {
    await page.goto("/train");
    await page.getByRole("button", { name: "Exercise", exact: true }).click();
    const add = page.getByRole("dialog");
    await expect(add.getByRole("textbox", { name: "Search or create exercise" })).toBeVisible();
    await expectNoSeriousViolations(page, "the add exercise sheet", { minChecked: 0 });
    await page.keyboard.press("Escape");
    await expect(add).toHaveCount(0);

    await page.getByRole("button", { name: /^Bench press set \d+:.*AMRAP/ }).click();
    await expect(page.getByRole("dialog", { name: /AMRAP/ })).toBeVisible();
    await expectNoSeriousViolations(page, "the AMRAP sheet", { minChecked: 0 });
  });
});

test.describe("high contrast: 7:1 text (color-contrast-enhanced)", () => {
  test.beforeEach(async ({ page }) => {
    await onboardedOn(page, MONDAY);
    await seedHistory(page);
    await page.goto("/settings");
    await page.getByRole("switch", { name: "High contrast" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-contrast", "high");
  });

  for (const [name, path] of SCREENS)
    test(name, async ({ page }) => {
      await page.goto(path);
      await expect(page.locator("html")).toHaveAttribute("data-contrast", "high");
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expectNoSeriousViolations(page, `${name} (high contrast)`);
      await expectEnhancedContrast(page, `${name} (high contrast)`);
    });
});
