/**
 * Reflow at 200% zoom on a 390 px phone (a 195 CSS px viewport): no screen may scroll sideways
 * (WCAG 1.4.10). Monday of week 1, so Train shows a full session with plates.
 */
import type { Page } from "@playwright/test";
import { expect, MONDAY, onboardedOn, test } from "./helpers";

/** null when the page fits; otherwise the widths and the first few elements that stick out. */
const overflow = (page: Page) =>
  page.evaluate(() => {
    const doc = document.documentElement;
    if (doc.scrollWidth <= doc.clientWidth) return null;
    const wide = [...document.querySelectorAll<HTMLElement>("body *")]
      .filter((el) => el.getBoundingClientRect().right > doc.clientWidth + 0.5)
      .slice(0, 5)
      .map((el) => `${el.tagName.toLowerCase()}.${[...el.classList].slice(0, 4).join(".")} → ${Math.round(el.getBoundingClientRect().right)}px`);
    return `scrollWidth ${doc.scrollWidth} > clientWidth ${doc.clientWidth}\n    ${wide.join("\n    ")}`;
  });

test.describe("no horizontal scrolling at 195 px", () => {
  test.beforeEach(async ({ page }) => {
    await onboardedOn(page, MONDAY);
    await page.setViewportSize({ width: 195, height: 422 });
  });

  for (const [name, path, open] of [
    ["Today", "/", null],
    ["Today with Nutrition open", "/", /Nutrition/],
    ["Train", "/train", null],
    ["Progress", "/progress", null],
    ["Goals", "/goals", null],
    ["Settings", "/settings", null],
  ] as const)
    test(name, async ({ page }) => {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      if (open) await page.getByRole("button", { name: open }).click();
      await page.waitForTimeout(500);
      expect(await overflow(page), `${name} at 195 px`).toBeNull();
    });
});
