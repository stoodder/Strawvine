/**
 * Goals' pace slider sets the calorie targets, so it is hard to nudge by accident and easy to take
 * back: a drag saves once (on release, not per tick) and raises "Pace set to … · Undo"; a finger
 * that scrolls the page across the slider never moves the thumb, one that drags along it or taps
 * the track does — read from where the finger is, so it doesn't hang on any browser's own slider.
 *
 * Touch goes through CDP (Input.dispatchTouchEvent → the browser's own gesture handling, so
 * touch-action and native scrolling apply); the mouse drag through Playwright's mouse.
 */
import type { Page, Request } from "@playwright/test";
import { expect, expectSynced, MONDAY, notifications, onboardedOn, seedHistory, serverData, test, toastMessage } from "./helpers";

const slider = (page: Page) => page.getByRole("slider", { name: /^Pace/ });
const serverPace = async (page: Page) => (await serverData(page)).settings.weightGoal?.pacePctPerWeek;
const shownPace = async (page: Page) => Number(await slider(page).inputValue());

/** Counts settings saves leaving the page. */
function settingsSaves(page: Page) {
  const seen: Request[] = [];
  page.on("request", (r) => {
    if (r.method() === "PUT" && new URL(r.url()).pathname === "/api/settings") seen.push(r);
  });
  return seen;
}

/** Where the thumb's centre is (the thumb is 18px wide and travels the track's width less its own). */
async function thumb(page: Page) {
  const box = (await slider(page).boundingBox())!;
  const { min, max, value } = await slider(page).evaluate((el) => {
    const i = el as HTMLInputElement;
    return { min: Number(i.min), max: Number(i.max), value: Number(i.value) };
  });
  return { x: box.x + 9 + ((value - min) / (max - min)) * (box.width - 18), y: box.y + box.height / 2, box, min, max };
}

/** The pace whose thumb position is nearest `x` (steps of 0.05 from the slowest pace). */
function paceUnder(at: Awaited<ReturnType<typeof thumb>>, x: number) {
  const fraction = Math.min(1, Math.max(0, (x - at.box.x - 9) / (at.box.width - 18)));
  return +(at.min + Math.round((fraction * (at.max - at.min)) / 0.05) * 0.05).toFixed(2);
}

/** A one-finger tap at (x, y): down, a moment, up — no travel. */
async function tap(page: Page, x: number, y: number) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  await page.waitForTimeout(40);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

/** A one-finger swipe from (x, y) by (dx, dy), in `steps` moves 16 ms apart, then the finger lifts. */
async function swipe(page: Page, x: number, y: number, dx: number, dy: number, steps = 12) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  for (let i = 1; i <= steps; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + (dx * i) / steps, y: y + (dy * i) / steps }] });
    await page.waitForTimeout(16);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
  await page.waitForTimeout(500); // momentum
}

async function openGoals(page: Page) {
  await onboardedOn(page, MONDAY);
  await seedHistory(page); // a cut to 190 lb at 0.75 %/wk
  await page.goto("/goals");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Goals");
  await expect(slider(page)).toHaveValue("0.75");
  expect(await serverPace(page)).toBe(0.75);
}

test("a pace drag saves once, on release, with an Undo that restores the previous pace on the server", async ({ page }) => {
  await openGoals(page);
  const saves = settingsSaves(page);

  // Drag the thumb a third of the track to the left, in many small moves.
  const from = await thumb(page);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(from.x - (from.box.width / 3) * (i / 10), from.y);
  // Mid-drag: the readout follows, nothing is saved, no toast.
  const dragged = await shownPace(page);
  expect(dragged).toBeLessThan(0.75);
  expect(saves).toHaveLength(0);
  await expect(notifications(page).getByRole("button", { name: "Undo" })).toHaveCount(0);
  await page.mouse.up();

  // Released: one save, one toast naming the new pace.
  const label = `Pace set to −${dragged.toFixed(2)}%/wk`;
  await expect(toastMessage(page, label)).toBeVisible();
  await expect(notifications(page).getByRole("button", { name: "Undo" })).toHaveCount(1);
  await expectSynced(page);
  await expect.poll(() => serverPace(page)).toBe(dragged);
  expect(saves).toHaveLength(1);
  await expect(slider(page)).toHaveValue(String(dragged));

  // Undo: the previous pace, here and on the server.
  await notifications(page).getByRole("button", { name: "Undo" }).click();
  await expect(toastMessage(page, label)).toHaveCount(0);
  await expect(slider(page)).toHaveValue("0.75");
  await expectSynced(page);
  await expect.poll(() => serverPace(page)).toBe(0.75);
  expect(saves).toHaveLength(2);
});

test("keyboard nudges fold into one toast whose Undo goes back to where they began", async ({ page }) => {
  await openGoals(page);
  await slider(page).focus();
  for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowLeft");
  await expect(slider(page)).toHaveValue("0.6");
  await expect(toastMessage(page, "Pace set to −0.60%/wk")).toBeVisible();
  await expect(notifications(page).getByRole("button", { name: "Undo" })).toHaveCount(1);
  await expectSynced(page);
  await expect.poll(() => serverPace(page)).toBe(0.6);
  await notifications(page).getByRole("button", { name: "Undo" }).click();
  await expect(slider(page)).toHaveValue("0.75");
  await expectSynced(page);
  await expect.poll(() => serverPace(page)).toBe(0.75);
});

test("touch: scrolling the page across the slider never moves the thumb; a drag along it does, once", async ({ page }) => {
  await openGoals(page);
  const saves = settingsSaves(page);
  expect(await slider(page).evaluate((el) => getComputedStyle(el).touchAction)).toBe("pan-y");
  const scrollY = () => page.evaluate(() => window.scrollY);
  expect(await scrollY()).toBe(0);

  // A swipe up that starts on the thumb itself, drifting sideways as a thumb does: the page scrolls.
  let at = await thumb(page);
  await swipe(page, at.x, at.y, -24, -220);
  expect(await scrollY(), "the page scrolled").toBeGreaterThan(100);
  await expect(slider(page)).toHaveValue("0.75");
  // …and one that starts on the track, away from the thumb (where a tap would jump it).
  await page.evaluate(() => window.scrollTo(0, 0));
  at = await thumb(page);
  await swipe(page, at.box.x + 40, at.y, 10, -220);
  expect(await scrollY()).toBeGreaterThan(100);
  await expect(slider(page)).toHaveValue("0.75");
  expect(saves).toHaveLength(0);
  await expect(notifications(page).getByRole("button", { name: "Undo" })).toHaveCount(0);
  expect(await serverPace(page)).toBe(0.75);

  // A drag along the track from the thumb: it follows, and saves once when the finger lifts.
  await page.evaluate(() => window.scrollTo(0, 0));
  at = await thumb(page);
  await swipe(page, at.x, at.y, -at.box.width / 3, 6);
  expect(await scrollY(), "a sideways drag doesn't scroll the page").toBe(0);
  const dragged = await shownPace(page);
  expect(dragged).toBeLessThan(0.7);
  await expect(toastMessage(page, `Pace set to −${dragged.toFixed(2)}%/wk`)).toBeVisible();
  await expectSynced(page);
  await expect.poll(() => serverPace(page)).toBe(dragged);
  expect(saves).toHaveLength(1);

  // Undo works after a touch too.
  await notifications(page).getByRole("button", { name: "Undo" }).click();
  await expect(slider(page)).toHaveValue("0.75");
  await expectSynced(page);
  await expect.poll(() => serverPace(page)).toBe(0.75);
  expect(saves).toHaveLength(2);
});

test("touch: a tap on the track sets the pace there, once; a tap on the thumb doesn't; a drag may start anywhere on the track", async ({
  page,
}) => {
  await openGoals(page);
  const saves = settingsSaves(page);
  const settled = async (pace: number) => {
    await expect(slider(page)).toHaveValue(String(pace));
    await expect(toastMessage(page, `Pace set to −${pace.toFixed(2)}%/wk`)).toBeVisible();
    await expectSynced(page);
    await expect.poll(() => serverPace(page)).toBe(pace);
  };

  // A tap on the thumb (a little off its centre): nothing moves, nothing is saved.
  let at = await thumb(page);
  await tap(page, at.x + 5, at.y);
  await expect(slider(page)).toHaveValue("0.75");
  expect(saves).toHaveLength(0);
  await expect(notifications(page).getByRole("button", { name: "Undo" })).toHaveCount(0);

  // A tap on the track, a quarter of the way along: the pace under the finger, saved once — and not
  // again by the mouse events a browser makes up after a tap.
  const quarter = paceUnder(at, at.box.x + at.box.width / 4);
  expect(quarter).toBeLessThan(0.5);
  await tap(page, at.box.x + at.box.width / 4, at.y);
  await settled(quarter);
  await page.waitForTimeout(800);
  expect(saves).toHaveLength(1);
  await expect(slider(page)).toHaveValue(String(quarter));
  expect(await page.evaluate(() => window.scrollY), "a tap doesn't scroll the page").toBe(0);

  // A drag that starts on the track, far from the thumb: the thumb comes to the finger and follows it.
  at = await thumb(page);
  const startX = at.box.x + at.box.width * 0.6;
  const end = paceUnder(at, startX - 40);
  expect(end).toBeGreaterThan(quarter);
  expect(end).toBeLessThan(0.75);
  await swipe(page, startX, at.y, -40, 4);
  await settled(end);
  expect(saves).toHaveLength(2);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);

  // One toast for both nudges; its Undo goes back to where they began.
  await expect(notifications(page).getByRole("button", { name: "Undo" })).toHaveCount(1);
  await notifications(page).getByRole("button", { name: "Undo" }).click();
  await expect(slider(page)).toHaveValue("0.75");
  await expectSynced(page);
  await expect.poll(() => serverPace(page)).toBe(0.75);
});
