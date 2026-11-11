/**
 * The page behind an open sheet stays put, and the sideways safety net holds.
 *
 * html and body clip sideways overflow (styles.css). That stops body's `overflow: hidden` from
 * reaching the viewport, so a sheet that locked the page that way let it scroll behind it (wheel
 * and touch inside the sheet chained to the page). A Sheet now pins body where it is
 * (ui.tsx `lockPage`): wheel, touch and `scrollTo` move nothing, and closing it gives the page
 * back at the same place. The net itself: a too-wide stray can't be scrolled or swiped to, and
 * html has no overscroll-behavior-x (which would turn off the trackpad's swipe back/forward).
 */
import type { Page } from "@playwright/test";
import { expect, login, startClockAt, SUNDAY, test } from "./helpers";

/**
 * A finger drag of (dx, dy) from (x, y), as browser-level touch input (it scrolls like a real
 * finger: up to scroll down). `Input.synthesizeScrollGesture` doesn't scroll the page here at all,
 * so it would prove nothing.
 */
async function touchScroll(page: Page, x: number, y: number, dx: number, dy: number) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  for (let i = 1; i <= 15; i++)
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + (dx * i) / 15, y: y + (dy * i) / 15 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
  await page.waitForTimeout(300);
}

const scroll = (page: Page) => page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));

test("an open sheet holds the page still; closing it gives the page back where it was", async ({ page }) => {
  await startClockAt(page, SUNDAY);
  await login(page);
  await page.goto("/program");
  const trigger = page.getByRole("button", { name: "Edit Bench press", exact: true });
  // Well down a long page.
  await trigger.evaluate((el) => el.scrollIntoView({ block: "center" }));
  const before = await scroll(page);
  expect(before.y).toBeGreaterThan(300);
  const top = () => trigger.evaluate((el) => Math.round(el.getBoundingClientRect().top));
  const topBefore = await top();

  await trigger.click();
  const sheet = page.getByRole("dialog", { name: /^Edit / });
  await expect(sheet.getByRole("textbox", { name: "Name" })).toBeVisible();
  await expect(page.locator("html[data-scroll-locked]")).toHaveCount(1);
  const box = (await sheet.boundingBox())!;
  const vp = page.viewportSize()!;

  // Wheel inside the sheet (past its own end), on the backdrop, a touch drag in both, and code.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 6; i++) await page.mouse.wheel(0, 800);
  await page.mouse.move(vp.width / 2, Math.max(10, box.y - 40));
  await page.mouse.wheel(0, 800);
  await touchScroll(page, box.x + box.width / 2, box.y + box.height / 2, 0, -400);
  await touchScroll(page, vp.width / 2, Math.max(10, box.y - 40), 0, -300);
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    window.scrollBy(0, 5000);
  });
  await page.waitForTimeout(300);
  // Nothing behind the sheet moved.
  expect(await top()).toBe(topBefore);
  await expect(sheet).toBeInViewport();

  // Closing it: the page is where it was, and scrolls again.
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(page.locator("html[data-scroll-locked]")).toHaveCount(0);
  expect(await scroll(page)).toEqual(before);
  expect(await top()).toBe(topBefore);
  expect(await page.evaluate(() => document.body.getAttribute("style") ?? "")).not.toMatch(/position|top:/);
  await page.mouse.move(vp.width / 2, vp.height / 2);
  await page.mouse.wheel(0, 400);
  await expect.poll(async () => (await scroll(page)).y).toBeGreaterThan(before.y);
  await touchScroll(page, vp.width / 2, vp.height / 2, 0, 300);
  await expect.poll(async () => (await scroll(page)).y).toBeLessThan(before.y + 400);
});

test("sideways: a too-wide stray can't be scrolled or swiped to, with or without a sheet", async ({ page }) => {
  await startClockAt(page, SUNDAY);
  await login(page);
  await page.goto("/program");
  await expect(page.getByRole("button", { name: "Edit Bench press", exact: true })).toBeVisible();

  // No overscroll-behavior-x on the page: it would disable the trackpad's back/forward swipe.
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).overscrollBehaviorX)).toBe("auto");
  expect(await page.evaluate(() => getComputedStyle(document.body).overscrollBehaviorX)).toBe("auto");

  // A wide block in the flow and an absolutely positioned one far to the right.
  await page.evaluate(() => {
    const wide = document.createElement("div");
    wide.id = "stray-wide";
    wide.style.cssText = "width: 2400px; height: 40px;";
    const abs = document.createElement("div");
    abs.id = "stray-abs";
    abs.style.cssText = "position: absolute; top: 200px; left: 1800px; width: 300px; height: 40px;";
    document.getElementById("root")!.append(wide);
    document.body.append(abs);
  });
  const vp = page.viewportSize()!;
  const tryToPan = async () => {
    await page.evaluate(() => {
      window.scrollTo(800, window.scrollY);
      document.scrollingElement!.scrollLeft = 900;
    });
    await touchScroll(page, vp.width - 30, vp.height / 2, -(vp.width - 60), 0);
    await page.waitForTimeout(200);
    return (await scroll(page)).x;
  };
  expect(await tryToPan()).toBe(0);
  expect(await page.evaluate(() => document.scrollingElement!.scrollWidth)).toBeLessThanOrEqual(vp.width);

  // The same with a sheet open (body pinned).
  await page.getByRole("button", { name: "Edit Bench press", exact: true }).click();
  await expect(page.getByRole("dialog", { name: /^Edit / })).toBeVisible();
  expect(await tryToPan()).toBe(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: /^Edit / })).toHaveCount(0);
  expect(await tryToPan()).toBe(0);
});
