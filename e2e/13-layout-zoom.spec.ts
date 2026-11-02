/**
 * Reflow (WCAG 1.4.10): at 200% zoom on a 390 px phone (a 195 CSS px viewport) and on a 320 px
 * phone, no screen may scroll sideways — including Train with the dock full (rest timer + a
 * toast) and with its sheets open. Monday of week 1, so Train shows a full session with plates.
 */
import type { Locator, Page } from "@playwright/test";
import { expect, MONDAY, notifications, onboardedOn, test } from "./helpers";

/** null when the page fits; otherwise the widths and the first few elements that stick out. */
const overflow = (page: Page) =>
  page.evaluate(() => {
    const doc = document.documentElement;
    if (doc.scrollWidth <= doc.clientWidth) return null;
    const wide = [...document.querySelectorAll<HTMLElement>("body *")]
      .filter((el) => el.getBoundingClientRect().right > doc.clientWidth + 0.5)
      .slice(0, 5)
      .map(
        (el) =>
          `${el.tagName.toLowerCase()}.${[...el.classList].slice(0, 4).join(".")} → ${Math.round(el.getBoundingClientRect().right)}px`,
      );
    return `scrollWidth ${doc.scrollWidth} > clientWidth ${doc.clientWidth}\n    ${wide.join("\n    ")}`;
  });

/**
 * Fixed layers (the dock, a sheet) don't widen the page, so the page check can't see them: every
 * visible element inside `layer` must lie within the viewport, unless an ancestor inside the layer
 * clips it (a deliberate horizontal scroller). Returns what sticks out.
 */
const outside = (layer: Locator) =>
  layer.evaluate((root) => {
    const vw = document.documentElement.clientWidth;
    const out: string[] = [];
    // The layer itself is a full-width fixed box (on a phone it follows the layout viewport, which
    // a too-wide page stretches): what matters is what is drawn in it.
    for (const el of root.querySelectorAll<HTMLElement>("*")) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || getComputedStyle(el).visibility === "hidden") continue;
      if (r.left >= -0.5 && r.right <= vw + 0.5) continue;
      let clipped = false;
      for (let a = el.parentElement; a && a !== root.parentElement; a = a.parentElement)
        if (getComputedStyle(a).overflowX !== "visible") {
          const ar = a.getBoundingClientRect();
          if (ar.left >= -0.5 && ar.right <= vw + 0.5) clipped = true;
          break;
        }
      if (!clipped)
        out.push(
          `${el.tagName.toLowerCase()}.${[...el.classList].slice(0, 4).join(".")} "${(el.textContent ?? "").trim().slice(0, 30)}" spans ${Math.round(r.left)}–${Math.round(r.right)}px of ${vw}`,
        );
      if (out.length >= 5) break;
    }
    return out;
  });

const dock = (page: Page) => page.locator("[data-dock]");

for (const width of [195, 320]) {
  test.describe(`no horizontal scrolling at ${width} px`, () => {
    test.beforeEach(async ({ page }) => {
      await onboardedOn(page, MONDAY);
      await page.setViewportSize({ width, height: width === 195 ? 422 : 568 });
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
        expect(await overflow(page), `${name} at ${width} px`).toBeNull();
      });

    /** Train with an accessory skipped (its toast has Undo) and a logged set (the rest timer runs). */
    const fillTheDock = async (page: Page) => {
      await page.goto("/train");
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Push/);
      await page.getByRole("button", { name: "Exercise", exact: true }).click();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: /^Pull-up/ })
        .click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await page.getByRole("button", { name: /^Bench press set 1:/ }).click();
      await page.getByRole("button", { name: "Pull-up options" }).click();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: /^Skip today/ })
        .click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(page.getByRole("group", { name: "Rest timer" })).toBeVisible();
      await expect(notifications(page).getByRole("button", { name: "Undo" })).toBeVisible();
      await page.waitForTimeout(500);
    };

    test("Train: the dock fits with the rest timer and a toast", async ({ page }) => {
      await fillTheDock(page);
      expect(await outside(dock(page)), `the dock at ${width} px`).toEqual([]);
      // The dock's controls stay reachable: each is fully inside the viewport.
      for (const control of [
        page.getByRole("button", { name: "Dismiss rest timer" }),
        notifications(page).getByRole("button", { name: "Undo" }),
      ]) {
        const box = (await control.boundingBox())!;
        expect(box.x, "dock control left edge").toBeGreaterThanOrEqual(0);
        expect(box.x + box.width, "dock control right edge").toBeLessThanOrEqual(width + 0.5);
      }
    });

    test("Train with a skipped accessory, the rest timer and a toast", async ({ page }) => {
      await fillTheDock(page);
      expect(await overflow(page), `Train with a full dock at ${width} px`).toBeNull();
    });

    test("Train's sheets: add exercise, exercise options, AMRAP", async ({ page }) => {
      await page.goto("/train");
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Push/);

      await page.getByRole("button", { name: "Exercise", exact: true }).click();
      const add = page.getByRole("dialog");
      await expect(add.getByRole("textbox", { name: "Search or create exercise" })).toBeVisible();
      await page.waitForTimeout(400);
      expect(await outside(add), `add exercise sheet at ${width} px`).toEqual([]);
      expect(await overflow(page)).toBeNull();
      await add.getByRole("button", { name: /^Pull-up/ }).click();
      await expect(add).toHaveCount(0);

      await page.getByRole("button", { name: "Pull-up options" }).click();
      const options = page.getByRole("dialog");
      await expect(options.getByRole("button", { name: /^Skip today/ })).toBeVisible();
      await page.waitForTimeout(400);
      expect(await outside(options), `exercise options sheet at ${width} px`).toEqual([]);
      await page.keyboard.press("Escape");
      await expect(options).toHaveCount(0);

      await page.getByRole("button", { name: /^Bench press set \d+:.*AMRAP/ }).click();
      const amrap = page.getByRole("dialog", { name: /AMRAP/ });
      await expect(amrap).toBeVisible();
      await page.waitForTimeout(400);
      expect(await outside(amrap), `AMRAP sheet at ${width} px`).toEqual([]);
      expect(await overflow(page)).toBeNull();
    });
  });
}
