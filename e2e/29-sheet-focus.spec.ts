/**
 * A sheet that opens into a text field (Train → Add exercise) never has that field above the
 * visible top: not while the sheet comes in, not once a keyboard is up, not on a later open,
 * and not when the page behind was scrolled.
 *
 * The bug on iOS: the field was focused (`autoFocus`) while the panel was still off screen,
 * sliding up. iOS scrolls the page to reveal a field focused under the keyboard; the panel then
 * slid on to its place, past the top of the screen. Chromium doesn't do that scroll, so the test
 * checks the condition that triggers it — the field is inside the visible viewport from the
 * first frame it has focus — and plays the keyboard the way iOS Safari and Chrome on Android
 * do: the layout viewport (where `position: fixed` lives) keeps its height while the visual
 * viewport shrinks above the keyboard, and may be panned (`offsetTop`) to show the field.
 */
import type { Locator, Page } from "@playwright/test";
import { expect, MONDAY, onboardedOn, test } from "./helpers";

test.use({ viewport: { width: 390, height: 844 } });

type Frame = { t: number; focused: boolean; top: number; bottom: number; vvTop: number; vvBottom: number; scrollY: number };

/**
 * Records every animation frame for `ms`: whether the search field exists and has focus, its
 * rect, and the visible viewport. Started before the tap, so the first frames of the sheet count.
 */
async function recordFrames(page: Page, ms: number) {
  await page.evaluate((ms) => {
    const w = window as unknown as { __frames: Frame[]; __recording: Promise<void>; __atFocus: Frame | null; __inGesture: boolean | null };
    w.__frames = [];
    w.__atFocus = null;
    w.__inGesture = null;
    const t0 = performance.now();
    const isSearch = (el: unknown): el is HTMLInputElement =>
      el instanceof HTMLInputElement && el.getAttribute("aria-label") === "Search or create exercise";
    // Where the field is at the moment it takes focus: what iOS measures to decide on a scroll.
    document.addEventListener("focusin", (e) => {
      if (!isSearch(e.target)) return;
      const r = e.target.getBoundingClientRect();
      const vv = window.visualViewport!;
      w.__atFocus = {
        t: 0,
        focused: true,
        top: r.top,
        bottom: r.bottom,
        vvTop: vv.offsetTop,
        vvBottom: vv.offsetTop + vv.height,
        scrollY: window.scrollY,
      };
    });
    // Whether focus arrived within the tap's click dispatch (iOS raises the keyboard only then):
    // a window listener runs after React's root listener and the microtasks it queued.
    window.addEventListener("click", () => (w.__inGesture = isSearch(document.activeElement)), { once: true });
    w.__recording = new Promise<void>((done) => {
      const tick = () => {
        const input = document.querySelector<HTMLInputElement>('input[aria-label="Search or create exercise"]');
        const vv = window.visualViewport!;
        if (input) {
          const r = input.getBoundingClientRect();
          w.__frames.push({
            t: Math.round(performance.now() - t0),
            focused: document.activeElement === input,
            top: r.top,
            bottom: r.bottom,
            vvTop: vv.offsetTop,
            vvBottom: vv.offsetTop + vv.height,
            scrollY: window.scrollY,
          });
        }
        if (performance.now() - t0 < ms) requestAnimationFrame(tick);
        else done();
      };
      requestAnimationFrame(tick);
    });
  }, ms);
  return async () => {
    await page.evaluate(() => (window as unknown as { __recording: Promise<void> }).__recording);
    return page.evaluate(() => {
      const w = window as unknown as { __frames: Frame[]; __atFocus: Frame | null; __inGesture: boolean | null };
      return { frames: w.__frames, atFocus: w.__atFocus, inGesture: w.__inGesture };
    });
  };
}

/** The field's rect against the visible (visual) viewport, now. */
const where = (search: Locator) =>
  search.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const vv = window.visualViewport!;
    return { top: r.top, bottom: r.bottom, vvTop: vv.offsetTop, vvBottom: vv.offsetTop + vv.height };
  });

async function expectVisible(search: Locator, what: string) {
  const w = await where(search);
  expect(w.top, `${what}: field top vs visible top`).toBeGreaterThanOrEqual(w.vvTop);
  expect(w.bottom, `${what}: field bottom vs visible bottom`).toBeLessThanOrEqual(w.vvBottom);
}

/**
 * An on-screen keyboard as iOS Safari has one: the visual viewport is `height` tall and panned
 * down by `offsetTop`, while the layout viewport stays the full window. Overrides the
 * visualViewport getters and fires its resize/scroll events; `null` puts the real ones back.
 */
async function keyboard(page: Page, kb: { height: number; offsetTop: number } | null) {
  await page.evaluate((kb) => {
    const vv = window.visualViewport!;
    for (const key of ["height", "offsetTop", "pageTop"] as const) delete (vv as unknown as Record<string, unknown>)[key];
    if (kb) {
      Object.defineProperty(vv, "height", { configurable: true, get: () => kb.height });
      Object.defineProperty(vv, "offsetTop", { configurable: true, get: () => kb.offsetTop });
      Object.defineProperty(vv, "pageTop", { configurable: true, get: () => window.scrollY + kb.offsetTop });
    }
    vv.dispatchEvent(new Event("resize"));
    vv.dispatchEvent(new Event("scroll"));
  }, kb);
  // Let layout catch up (the panel follows on the event).
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

async function openAndCheck(page: Page, label: string) {
  const stop = await recordFrames(page, 900);
  await page.getByRole("button", { name: "Exercise", exact: true }).tap();
  const sheet = page.getByRole("dialog", { name: "Add exercise" });
  const search = sheet.getByRole("textbox", { name: "Search or create exercise" });
  // The field takes focus on open (so a phone's keyboard comes up for the search)…
  await expect(search).toBeFocused();
  const { frames, atFocus, inGesture } = await stop();
  // …within the tap (so iOS raises the keyboard for it)…
  expect(inGesture, `${label}: focused within the tap's click`).toBe(true);
  // …and from the moment it has focus it is on screen, clear of where a phone keyboard comes up
  // (an iPhone's covers the bottom 336 px of 844), and stays put: nothing for iOS to scroll to.
  const KEYBOARD_TOP = 844 - 336;
  const focused = [atFocus!, ...frames.filter((f) => f.focused)];
  expect(atFocus, `${label}: the field's rect when it took focus`).not.toBeNull();
  expect(focused.length, `${label}: frames with the field focused`).toBeGreaterThan(5);
  const settled = focused[focused.length - 1]!;
  for (const f of focused) {
    expect(f.top, `${label}: field top at ${f.t} ms`).toBeGreaterThanOrEqual(f.vvTop);
    expect(f.bottom, `${label}: field bottom at ${f.t} ms`).toBeLessThanOrEqual(Math.min(f.vvBottom, KEYBOARD_TOP));
    expect(Math.abs(f.top - settled.top), `${label}: field moves after focus (${f.t} ms)`).toBeLessThanOrEqual(30);
    expect(f.scrollY, `${label}: window scroll at ${f.t} ms`).toBe(0);
  }
  await expectVisible(search, `${label}, settled`);

  // An iOS keyboard (844 - 336 visible): the sheet sits above it, the field on screen.
  await keyboard(page, { height: 508, offsetTop: 0 });
  await expectVisible(search, `${label}, keyboard up`);
  const panel = (await sheet.boundingBox())!;
  expect(panel.y + panel.height, `${label}: sheet bottom vs keyboard top`).toBeLessThanOrEqual(508 + 0.5);
  expect(panel.y, `${label}: sheet top`).toBeGreaterThanOrEqual(0);
  await expect(sheet.getByRole("button", { name: "Close" })).toBeInViewport();

  // iOS also pans the visual viewport to show a field: the sheet follows the visible area.
  await keyboard(page, { height: 508, offsetTop: 200 });
  await expectVisible(search, `${label}, keyboard up and the view panned`);
  const panned = (await sheet.boundingBox())!;
  expect(panned.y, `${label}: sheet top, panned`).toBeGreaterThanOrEqual(200 - 0.5);
  expect(panned.y + panned.height, `${label}: sheet bottom, panned`).toBeLessThanOrEqual(708 + 0.5);

  // Keyboard down again: the sheet goes back to the bottom of the window.
  await keyboard(page, null);
  await expectVisible(search, `${label}, keyboard down`);
  const back = (await sheet.boundingBox())!;
  expect(Math.round(back.y + back.height)).toBe(844);

  // A browser that resizes the whole viewport for the keyboard (Chrome with resizes-content).
  await page.setViewportSize({ width: 390, height: 500 });
  await page.waitForTimeout(100);
  await expectVisible(search, `${label}, viewport 500 tall`);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(100);

  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
}

test("Add exercise: the search field stays on screen through the open and with a keyboard, every time", async ({ page }) => {
  await onboardedOn(page, MONDAY);
  await page.getByRole("link", { name: "Train" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Push/);
  await page.getByRole("button", { name: "Exercise", exact: true }).scrollIntoViewIfNeeded();
  const scrolled = await page.evaluate(() => window.scrollY);

  await openAndCheck(page, "first open");
  await openAndCheck(page, "second open");
  expect(await page.evaluate(() => window.scrollY), "page scroll after closing").toBe(scrolled);

  // From further down the page (the page is pinned while the sheet is open, and given back).
  await page.evaluate(() => window.scrollTo(0, document.scrollingElement!.scrollHeight));
  const y = await page.evaluate(() => window.scrollY);
  expect(y).toBeGreaterThan(scrolled);
  await openAndCheck(page, "open from a scrolled page");
  expect(await page.evaluate(() => window.scrollY), "page scroll after closing").toBe(y);
});

test("a field low in a sheet (the max form) stays visible above the keyboard when tapped", async ({ page }) => {
  await onboardedOn(page, MONDAY);
  await page.goto("/progress");
  await page
    .getByRole("button", { name: /^Bench press/ })
    .first()
    .tap();
  const sheet = page.getByRole("dialog", { name: "Bench press" });
  const field = sheet.getByRole("textbox", { name: "New max" });
  await expect(field).toBeVisible();
  await page.waitForTimeout(500);
  await field.tap();
  await expect(field).toBeFocused();
  await keyboard(page, { height: 508, offsetTop: 0 });
  await expectVisible(field, "max form, keyboard up");
  const panel = (await sheet.boundingBox())!;
  expect(panel.y + panel.height).toBeLessThanOrEqual(508.5);
  await keyboard(page, { height: 508, offsetTop: 336 });
  await expectVisible(field, "max form, keyboard up and the view panned");
  await keyboard(page, null);
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
});

test("a sheet that opens while another's keyboard is going down stays on the bottom (Add another exercise → pick)", async ({ page }) => {
  await onboardedOn(page, MONDAY);
  await page.getByRole("link", { name: "Train" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Push/);
  await page.getByRole("button", { name: "Exercise", exact: true }).click();
  const first = page.getByRole("dialog", { name: "Add exercise" });
  await first.getByRole("textbox", { name: "Search or create exercise" }).fill("Rows");
  await first.getByRole("button", { name: /Create & add/ }).click();
  await expect(first).toHaveCount(0);
  await page.getByRole("button", { name: "Rows options" }).click();
  await page
    .getByRole("dialog", { name: "Rows" })
    .getByRole("button", { name: /^Superset with another exercise/ })
    .click();
  await page.getByRole("dialog", { name: "New superset" }).getByRole("button", { name: "Add another exercise" }).click();
  const add = page.getByRole("dialog", { name: "Add to superset" });
  await expect(add.getByRole("textbox", { name: "Search or create exercise" })).toBeFocused();
  // The search's keyboard is up: the Add sheet sits on it.
  await keyboard(page, { height: 508, offsetTop: 0 });
  await page.waitForTimeout(500); // the panel's entrance (a 24 px rise)
  const lifted = (await add.boundingBox())!;
  expect(lifted.y + lifted.height).toBeLessThanOrEqual(508.5);
  // Pick: the superset sheet comes back while the keyboard (still reported up) goes down. Nothing
  // in it that raises a keyboard has focus, so it sits on the window's bottom, not mid-screen.
  await add.getByRole("button", { name: /^Pull-up/ }).click();
  const sheet = page.getByRole("dialog", { name: "Superset A" });
  await expect(sheet.getByRole("button", { name: "Move Pull-up up in Superset A" })).toBeFocused();
  await keyboard(page, { height: 508, offsetTop: 0 });
  await page.waitForTimeout(500); // the panel's entrance
  const back = (await sheet.boundingBox())!;
  expect(Math.round(back.y + back.height)).toBe(844);
  await keyboard(page, null);
});
