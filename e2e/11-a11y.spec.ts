/**
 * Accessibility smoke: axe-core (WCAG 2.x A/AA rules) on every main screen and the common sheets;
 * no serious or critical violations. Monday of week 1, so Train has a full session.
 */
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, MONDAY, onboardedOn, test } from "./helpers";

async function expectNoSeriousViolations(page: Page, where: string) {
  // Let entrance animations settle (an element mid-fade reports a lower contrast than it has).
  await page.waitForTimeout(800);
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  const describe = serious.map(
    (v) => `${v.id} (${v.impact}): ${v.help}\n${v.nodes.map((n) => `    ${n.target.join(" ")}  ${n.failureSummary?.split("\n")[1]?.trim() ?? ""}`).join("\n")}`,
  );
  expect(describe, `axe on ${where}`).toEqual([]);
}

test.describe("axe: no serious or critical violations", () => {
  test.beforeEach(async ({ page }) => {
    await onboardedOn(page, MONDAY);
  });

  for (const [name, path] of [
    ["Today", "/"],
    ["Train", "/train"],
    ["Progress", "/progress"],
    ["Goals", "/goals"],
    ["Settings", "/settings"],
  ] as const)
    test(name, async ({ page }) => {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expectNoSeriousViolations(page, name);
    });

  test("Today with the editors open", async ({ page }) => {
    for (const row of [/Weigh-in/, /Nutrition/, /^Steps/]) await page.getByRole("button", { name: row }).click();
    await expect(page.getByRole("textbox", { name: "Calories" })).toBeVisible();
    await expectNoSeriousViolations(page, "Today, editors open");
  });

  test("Goals: new strength target sheet", async ({ page }) => {
    await page.goto("/goals");
    await page.getByRole("button", { name: "Add strength target" }).click();
    await expect(page.getByRole("dialog", { name: "New strength target" })).toBeVisible();
    await expectNoSeriousViolations(page, "the new strength target sheet");
  });

  test("Train: add exercise sheet and the AMRAP sheet", async ({ page }) => {
    await page.goto("/train");
    await page.getByRole("button", { name: "Exercise", exact: true }).click();
    const add = page.getByRole("dialog");
    await expect(add.getByRole("textbox", { name: "Search or create exercise" })).toBeVisible();
    await expectNoSeriousViolations(page, "the add exercise sheet");
    await page.keyboard.press("Escape");
    await expect(add).toHaveCount(0);

    await page.getByRole("button", { name: /^Bench press set \d+:.*AMRAP/ }).click();
    await expect(page.getByRole("dialog", { name: /AMRAP/ })).toBeVisible();
    await expectNoSeriousViolations(page, "the AMRAP sheet");
  });

  test("Today in high contrast", async ({ page }) => {
    await page.goto("/settings");
    await page.getByRole("switch", { name: "High contrast" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-contrast", "high");
    await page.goto("/");
    await expectNoSeriousViolations(page, "Today (high contrast)");
  });
});
