/**
 * Data integrity across two devices on one account (two browser contexts, each with its own
 * storage): nothing one device logged may be lost to the other's stale copy.
 *
 *   (a) an edit made while a save is in flight, during a 409 merge, keeps the other device's sets;
 *   (b) reverting a moved session from a stale device doesn't delete the session the other device
 *       has logged into since — a calm conflict message, the session kept;
 *   (c) "Do this session today" credits the day it was planned for (its Lift item is done, Train
 *       says "Done Sun · Push"), and the rest day that received it shows a Lift item.
 */
import type { Browser, Page, Route } from "@playwright/test";
import {
  dismissCelebrations,
  expect,
  expectSynced,
  keepAnimationsOnTheRealTimeline,
  MONDAY,
  MONDAY_ISO,
  onboardedOn,
  serverData,
  SUNDAY,
  test,
  toastMessage,
} from "./helpers";

const SUNDAY_ISO = "2026-10-25";

const setButton = (page: Page, n: number) => page.getByRole("button", { name: new RegExp(`^Bench press set ${n}:`) });
type SessionLike = {
  date: string;
  completedAt?: string | null;
  blocks: Array<{ kind: string; exercises: Array<{ sets: Array<{ done: boolean }> }> }>;
};
const mainSets = (s: SessionLike | undefined) => s?.blocks.find((b) => b.kind === "primary")?.exercises[0]?.sets.map((x) => x.done);
const sessionOn = async (page: Page, date: string) =>
  (await serverData(page)).sessions.find((s) => s.date === date) as SessionLike | undefined;

/**
 * A second device signed in to the same account, at `time`, on `path`. Its copy is then kept
 * stale: every revalidation of /api/bootstrap hears "nothing changed".
 */
async function secondDevice(page: Page, browser: Browser, time: Date, path: string) {
  const context = await browser.newContext({ baseURL: new URL(page.url()).origin, storageState: await page.context().storageState() });
  await keepAnimationsOnTheRealTimeline(context);
  const b = await context.newPage();
  await b.clock.install({ time });
  await b.clock.resume();
  await dismissCelebrations(b);
  await b.goto(path);
  await expect(b.getByRole("navigation", { name: "Primary" })).toBeVisible();
  await b.route("**/api/bootstrap", (route) => route.fulfill({ status: 304 }));
  return { b, close: () => context.close() };
}

/** Hold the device's next request matching `method` + `url` until `release()`; resolves `held` once it is waiting. */
async function holdNext(page: Page, method: string, url: string) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let markHeld!: () => void;
  const held = new Promise<void>((r) => (markHeld = r));
  let used = false;
  await page.route(url, async (route: Route) => {
    if (used || route.request().method() !== method) return route.fallback();
    used = true;
    markHeld();
    await gate;
    await route.fallback();
  });
  return { held, release };
}

test("(a) an edit made while a conflicting save is in flight keeps the other device's sets", async ({ page, browser }) => {
  await onboardedOn(page, MONDAY);
  await page.goto("/train");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Push/);

  // Device B opens Monday's (still unsaved) session before A logs anything.
  const { b, close } = await secondDevice(page, browser, MONDAY, "/train");
  try {
    await expect(b.getByRole("heading", { level: 1 })).toHaveText(/Push/);

    // A logs set 1 and it reaches the server.
    await setButton(page, 1).click();
    await expectSynced(page);
    await expect.poll(async () => mainSets(await sessionOn(page, MONDAY_ISO))).toEqual([true, false, false, false]);

    // B (stale: it thinks there is no session yet) logs set 2; that save is held in flight…
    const put = await holdNext(b, "PUT", "**/api/sessions/*");
    await setButton(b, 2).click();
    await put.held;
    // …and B logs set 3 while it is. Then the first save goes out and conflicts (409).
    await setButton(b, 3).click();
    await expect(setButton(b, 3)).toHaveAttribute("aria-pressed", "true");
    put.release();

    // Everything lands: A's set 1 and both of B's sets.
    await expect.poll(async () => mainSets(await sessionOn(page, MONDAY_ISO)), { timeout: 20_000 }).toEqual([true, true, true, false]);
    await expectSynced(b);
    // B shows the merged session too.
    for (const n of [1, 2, 3]) await expect(setButton(b, n)).toHaveAttribute("aria-pressed", "true");
    // Nothing drifts afterwards (a late save of B's pre-merge copy would drop A's set).
    await b.waitForTimeout(1500);
    expect(mainSets(await sessionOn(page, MONDAY_ISO))).toEqual([true, true, true, false]);
  } finally {
    await close();
  }
});

test("(b) reverting from a stale device keeps a session the other device has logged into", async ({ page, browser }) => {
  await onboardedOn(page); // Sunday
  // Device A moves Monday's Push to today (Sunday).
  await page.goto(`/train/${MONDAY_ISO}`);
  await page.getByRole("button", { name: "Do this session today" }).click();
  await expect(page).toHaveURL(/\/train\/?$/);
  await expectSynced(page);
  await expect.poll(async () => (await sessionOn(page, SUNDAY_ISO))?.date).toBe(SUNDAY_ISO);

  // Device B sees the moved, untouched session (it can still be reverted).
  const { b, close } = await secondDevice(page, browser, SUNDAY, "/train");
  try {
    const revert = b.getByRole("button", { name: "Revert to today's plan" });
    await expect(revert).toBeVisible();

    // A logs a set into it.
    await setButton(page, 1).click();
    await expectSynced(page);
    await expect.poll(async () => mainSets(await sessionOn(page, SUNDAY_ISO))?.[0]).toBe(true);

    // B, stale, reverts: the delete must not win over A's logged work.
    await revert.click();
    await expect(toastMessage(b, /another device/i)).toBeVisible({ timeout: 15_000 });
    await expectSynced(b);
    await b.waitForTimeout(1000);
    const kept = await sessionOn(page, SUNDAY_ISO);
    expect(kept, "the session A logged into is still on the server").toBeTruthy();
    expect(mainSets(kept)?.[0]).toBe(true);
    // B shows the server's copy again: the session, with A's set logged.
    await expect(b.getByRole("heading", { level: 1 })).toHaveText(/Push/);
    await expect(setButton(b, 1)).toHaveAttribute("aria-pressed", "true");
  } finally {
    await close();
  }
});

test("(c) a session done early credits the day it was planned for; the rest day shows a Lift item", async ({ page }) => {
  await onboardedOn(page); // Sunday, a rest day
  await expect(page.getByRole("link", { name: /^Lift\b/ })).toHaveCount(0);

  // Do Monday's Push today and finish it.
  await page.goto(`/train/${MONDAY_ISO}`);
  await page.getByRole("button", { name: "Do this session today" }).click();
  await expect(page).toHaveURL(/\/train\/?$/);
  const count = await page.getByRole("button", { name: /^Bench press set \d+:/ }).count();
  for (let i = 1; i < count; i++) await setButton(page, i).click();
  await setButton(page, count).click();
  const amrap = page.getByRole("dialog", { name: /AMRAP/ });
  await amrap.getByRole("button", { name: /^Log \d+ reps$/ }).click();
  await expect(amrap).toHaveCount(0);
  await page.getByRole("button", { name: "Finish session" }).click();
  await expect(page.getByRole("heading", { name: "Session complete" })).toBeVisible();
  await expectSynced(page);
  await expect.poll(async () => !!(await sessionOn(page, SUNDAY_ISO))?.completedAt).toBe(true);

  // Sunday (the receiving rest day) now has a Lift item, done.
  await page.getByRole("link", { name: "Today" }).click();
  await expect(page.getByRole("link", { name: /^Lift\s*, done/ })).toBeVisible();

  // Monday (the day it was planned for): the Lift item is done, and Train says where it was done.
  await page.clock.setSystemTime(MONDAY);
  await page.goto("/");
  await expect(page.getByRole("link", { name: /^Lift\s*, done/ })).toBeVisible();
  await page.getByRole("link", { name: "Train" }).click();
  await expect(page.getByText(/Done Sun · Push/)).toBeVisible();
  await expect(page.getByRole("link", { name: "View Sunday's Push session" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Log a session anyway|Start a session anyway/ })).toBeVisible();
});
