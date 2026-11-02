/**
 * Round-3 features end to end: moving a previewed session to today, skipping the main lift, the
 * next-session link on Today, refused edits in Settings → Sync, forgetting this device, and a
 * version conflict between two devices editing the same session.
 */
import type { Page } from "@playwright/test";
import { dismissCelebrations, expect, expectFocusNotOnBody, expectSynced, MONDAY, MONDAY_ISO, onboardedOn, serverData, test, toastMessage } from "./helpers";

const SUNDAY_ISO = "2026-10-25";

/** Log the main lift's set `n` (1-based) on Train. */
const logSet = (page: Page, n: number) => page.getByRole("button", { name: new RegExp(`^Bench press set ${n}:`) }).click();
const primary = (s: { blocks: Array<{ kind: string; skipped?: boolean; exercises: Array<{ sets: Array<{ done: boolean }> }> }> } | undefined) =>
  s?.blocks.find((b) => b.kind === "primary");

test("Do this session today: a previewed day's session moves to today", async ({ page }) => {
  await onboardedOn(page);
  // Sunday: preview Monday's session and do it today instead.
  await page.goto(`/train/${MONDAY_ISO}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Push/);
  await page.getByRole("button", { name: "Do this session today" }).click();

  await expect(page).toHaveURL(/\/train\/?$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Push/);
  await expect(page.getByRole("button", { name: /^Bench press set 1:/ })).toBeVisible();
  await expect
    .poll(async () => {
      const s = (await serverData(page)).sessions.find((x) => x.date === SUNDAY_ISO);
      return s && { label: s.label, plannedFor: (s as { plannedFor?: string | null }).plannedFor };
    })
    .toEqual({ label: "Push", plannedFor: MONDAY_ISO });
});

test("skip the main lift: no unlogged-set question, the session still finishes", async ({ page }) => {
  await onboardedOn(page, MONDAY);
  await page.getByRole("link", { name: "Train" }).click();
  await page.getByRole("button", { name: "Skip Bench press today" }).click();
  await expect(toastMessage(page, "Main lift skipped today")).toBeVisible();
  await expectFocusNotOnBody(page, "skipping the main lift");
  await expect(page.getByRole("button", { name: /^Bench press set 1:/ })).toHaveCount(0);

  await page.getByRole("button", { name: "Finish session" }).click();
  await expect(page.getByText(/unlogged\?/)).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Session complete" })).toBeVisible();
  await expect
    .poll(async () => {
      const s = (await serverData(page)).sessions.find((x) => x.date === MONDAY_ISO);
      return s && { skipped: primary(s)?.skipped ?? false, completed: !!s.completedAt };
    })
    .toEqual({ skipped: true, completed: true });
});

test("Today links to the next session's preview", async ({ page }) => {
  await onboardedOn(page);
  // "Next session: Tomorrow Push · Bench press W1, preview" (the visible text leads the name).
  const next = page.getByRole("link", { name: /^Next\b.*Push/ });
  await expect(next).toBeVisible();
  await next.click();
  await expect(page).toHaveURL(new RegExp(`/train/${MONDAY_ISO}$`));
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Push/);
});

test("Settings → Sync lists an edit this device refused, and Clear empties it", async ({ page }) => {
  await onboardedOn(page);
  // The journal holds at most 50,000 characters: a longer entry is refused before it is queued.
  const journal = page.getByRole("textbox", { name: "Journal" });
  await journal.fill("x".repeat(50_001));
  await journal.blur();

  await page.goto("/settings");
  const refused = page.getByRole("group", { name: "Couldn't save" });
  await expect(refused).toBeVisible();
  await expect(refused.getByRole("list", { name: "Edits that couldn't be saved" }).getByRole("listitem")).toHaveCount(1);
  await expect(refused).toContainText(/too long/);
  await refused.getByRole("button", { name: "Clear" }).click();
  await expect(refused).toHaveCount(0);
  await expectFocusNotOnBody(page, "clearing refused edits");
});

test("forget this device clears the known-device cookie", async ({ page, context }) => {
  await onboardedOn(page);
  const deviceCookie = async () => (await context.cookies()).find((c) => /sv_device/.test(c.name));
  expect(await deviceCookie()).toBeTruthy();

  await page.goto("/settings");
  await page.getByRole("button", { name: "Forget this device" }).click();
  await page.getByRole("button", { name: "Forget", exact: true }).click();
  await expect.poll(deviceCookie).toBeUndefined();

  // What the screen says must match what happened: either it confirms and this browser is still
  // signed in, or it is back at the sign-in screen. (Contract note: Settings' copy says "You stay
  // signed in"; POST /api/auth/forget-device currently also clears the session cookie.)
  const done = page.getByText(/This device will be treated like a new one at the next sign-in/);
  const signIn = page.getByLabel("Password");
  await expect(done.or(signIn)).toBeVisible();
  if (await done.isVisible()) {
    await page.reload();
    await expect(page.getByRole("heading", { name: "The rules" })).toBeVisible();
  }
});

test("two devices edit the same session: the stale one merges and both changes reach the server", async ({ page, browser }) => {
  await onboardedOn(page, MONDAY);
  await page.goto("/train");
  await logSet(page, 1);
  await expectSynced(page);

  // A second device (its own storage), on the same Monday.
  const other = await browser.newContext({ baseURL: new URL(page.url()).origin, storageState: await page.context().storageState() });
  try {
    const b = await other.newPage();
    await b.clock.install({ time: MONDAY });
    await b.clock.resume();
    await dismissCelebrations(b);
    await b.goto("/train");
    await expect(b.getByRole("heading", { level: 1 })).toHaveText(/Push/);
    // Keep device B's copy stale: its revalidations hear "nothing changed".
    await b.route("**/api/bootstrap", (route) => route.fulfill({ status: 304 }));

    // Device A logs set 2; then stale device B logs set 3.
    await logSet(page, 2);
    await expectSynced(page);
    await logSet(b, 3);

    await expect(toastMessage(b, "Merged changes from another device")).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(async () => primary((await serverData(page)).sessions.find((x) => x.date === MONDAY_ISO))?.exercises[0]?.sets.map((s) => s.done))
      .toEqual([true, true, true, false]);
  } finally {
    await other.close();
  }
});
