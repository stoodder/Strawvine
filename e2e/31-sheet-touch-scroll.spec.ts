/**
 * A sheet's content scrolls by touch, both ways, and a swipe down still closes it — from the grab
 * area (handle and title) always, from the content only once it's at its top. (On iPhone the
 * exercise options sheet couldn't be scrolled at all: the panel was a motion `drag="y"`, which
 * sets `touch-action: pan-x`, so every vertical swipe was a drag — down closed, up was clamped.
 * The mouse wheel still scrolled, so pointer-driven tests never saw it.)
 *
 * Real touch input through CDP (Input.dispatchTouchEvent goes through the browser's gesture
 * handling, so touch-action and native scrolling apply), at a short 390×600 viewport so the
 * options sheet overflows.
 */
import type { Locator, Page } from "@playwright/test";
import { expect, MONDAY, onboardedOn, test } from "./helpers";

test.use({ viewport: { width: 390, height: 600 } });

/** A one-finger swipe from (x, y) by dy, in `steps` moves 16 ms apart, then the finger lifts. */
async function swipe(page: Page, x: number, y: number, dy: number, steps = 12) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  for (let i = 1; i <= steps; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y + (dy * i) / steps }] });
    await page.waitForTimeout(16);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
  await page.waitForTimeout(600); // momentum, the spring back, or the exit
}

const scrollTop = (panel: Locator) => panel.evaluate((el) => el.scrollTop);

async function openOptions(page: Page) {
  await page.getByRole("button", { name: "Rows options" }).click();
  const sheet = page.getByRole("dialog", { name: "Rows" });
  await expect(sheet).toBeVisible();
  await page.waitForTimeout(500); // its entrance
  return sheet;
}

test("the exercise options sheet scrolls by touch both ways; a swipe down closes it only from the top or the handle", async ({ page }) => {
  await onboardedOn(page, MONDAY);
  await page.getByRole("link", { name: "Train" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Push/);
  await page.getByRole("button", { name: "Exercise", exact: true }).click();
  const add = page.getByRole("dialog", { name: "Add exercise" });
  await add.getByRole("textbox", { name: "Search or create exercise" }).fill("Rows");
  await add.getByRole("button", { name: /Create & add/ }).click();
  await expect(add).toHaveCount(0);

  let sheet = await openOptions(page);
  const overflow = await sheet.evaluate((el) => el.scrollHeight - el.clientHeight);
  expect(overflow, "the options sheet overflows at 600 tall").toBeGreaterThan(100);
  const touchAction = await sheet.evaluate((el) => getComputedStyle(el).touchAction);
  expect(touchAction, "the panel lets the browser pan it").toBe("auto");
  let box = (await sheet.boundingBox())!;
  const x = box.x + box.width / 2;
  const mid = box.y + box.height / 2;

  // Swipe up on the content: it scrolls (it used to be clamped), the sheet stays.
  await swipe(page, x, mid + 100, -200);
  await expect(sheet).toBeVisible();
  const scrolled = await scrollTop(sheet);
  expect(scrolled).toBeGreaterThan(50);

  // Swipe down while scrolled: it scrolls back up, never closes — even past the top.
  await swipe(page, x, mid - 100, 60);
  await expect(sheet).toBeVisible();
  expect(await scrollTop(sheet)).toBeLessThan(scrolled);
  await swipe(page, x, mid - 150, 300);
  await expect(sheet).toBeVisible();
  expect(await scrollTop(sheet)).toBe(0);
  box = (await sheet.boundingBox())!;
  expect(Math.round(box.y + box.height), "the panel is back on the bottom").toBe(600);

  // At the top, a swipe down on the content closes it.
  await swipe(page, x, mid - 100, 220);
  await expect(sheet).toHaveCount(0);

  // A short swipe down from the top springs back; from the handle a swipe down closes it.
  sheet = await openOptions(page);
  box = (await sheet.boundingBox())!;
  await swipe(page, x, mid, 40, 20);
  await expect(sheet).toBeVisible();
  box = (await sheet.boundingBox())!;
  expect(Math.round(box.y + box.height)).toBe(600);
  const grab = (await sheet.locator("[data-sheet-grab]").boundingBox())!;
  await swipe(page, grab.x + 30, grab.y + 10, 220);
  await expect(sheet).toHaveCount(0);
});
