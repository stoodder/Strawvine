import { test as base, expect, type Page } from "@playwright/test";

export { expect };
export const PASSWORD = process.env.E2E_PASSWORD ?? "e2e-password-not-secret";

/**
 * The suite's `test`: before each test (and each retry) the runner (scripts/e2e.mjs) restarts
 * the server on an empty database, so every test is self-sufficient and nothing leaks between
 * them. Without E2E_CONTROL_URL (running Playwright by hand) the database is left alone.
 */
export const test = base.extend<{ freshDatabase: void }>({
  freshDatabase: [
    async ({}, use) => {
      const control = process.env.E2E_CONTROL_URL;
      if (control) {
        const res = await fetch(`${control}/reset`, { method: "POST" });
        if (!res.ok) throw new Error(`Resetting the e2e database failed: ${res.status} ${await res.text()}`);
      }
      await use();
    },
    { auto: true },
  ],
});

/**
 * Local-time instants (the browser runs in the machine's zone). The suite pins the clock so the
 * program calendar is predictable: onboarding on Sunday 2026-10-25 starts the cycle on Monday the
 * 26th, which is week 1 (Push — bench, AMRAP last set).
 */
export const SUNDAY = new Date(2026, 9, 25, 9, 0, 0);
export const MONDAY = new Date(2026, 9, 26, 10, 0, 0);
export const MONDAY_ISO = "2026-10-26";

/**
 * Celebrations (day closed, PRs, streaks) are modal and can appear at any moment: whenever one
 * shows up, press "Continue" until none is left. Returns the titles seen, in order.
 */
export async function dismissCelebrations(page: Page): Promise<string[]> {
  const seen: string[] = [];
  // The newest overlay (a dismissed one may still be fading out underneath).
  const dialog = page
    .getByRole("dialog")
    .filter({ has: page.getByRole("button", { name: /^Continue/ }) })
    .last();
  const cont = dialog.getByRole("button", { name: /^Continue/ });
  await page.addLocatorHandler(
    cont,
    async () => {
      for (let i = 0; i < 10; i++) {
        const title = await dialog
          .getByRole("heading", { level: 2 })
          .textContent({ timeout: 1000 })
          .catch(() => null);
        if (!title) break;
        if (seen.at(-1) !== title) seen.push(title);
        if (process.env.E2E_DEBUG) console.log(`celebration: ${title}`);
        // The overlay ignores taps for its first instant (they were meant for what was underneath).
        await page.waitForTimeout(500);
        await cont.click({ timeout: 2000 }).catch(() => {});
        await page.waitForTimeout(400);
      }
    },
    { noWaitAfter: true },
  );
  return seen;
}

/**
 * Sign in (unless a session cookie already does) and, on a fresh database, skip through
 * onboarding (bench press max 225; the cycle starts the Monday after the browser's today).
 */
export async function login(page: Page) {
  await page.goto("/");
  const pw = page.getByLabel("Password");
  const nav = page.getByRole("navigation", { name: "Primary" });
  const onboarding = page.getByRole("heading", { name: "Let's calibrate." });
  await expect(pw.or(nav).or(onboarding)).toBeVisible();
  if (await pw.isVisible()) {
    await pw.fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
  }
  await expect(nav.or(onboarding)).toBeVisible();
  if (await onboarding.isVisible()) {
    await page.getByRole("button", { name: "Continue" }).click();
    await fillNumber(page, "Bench press", "225");
    for (let i = 0; i < 2; i++) await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: "Begin" }).click();
    await expect(nav).toBeVisible();
  }
}

/** Fill a commit-on-blur number field. */
export async function fillNumber(page: Page, name: string | RegExp, value: string) {
  const input = page.getByRole("textbox", { name, exact: typeof name === "string" }).first();
  await input.click();
  await input.fill(value);
  await input.press("Enter");
  await expect(input).not.toBeFocused();
}

/**
 * Wait until this device has a trusted copy of the data (IndexedDB "strawvine" / kv: the
 * "b:meta" record of the split copy, or the older single "base" record — written a few seconds
 * after a load), and no "strawvine:cache-invalid" mark from the sign-out that preceded sign-in,
 * so the app can open offline.
 */
export async function waitForDeviceCopy(page: Page) {
  const trusted = () =>
    page.evaluate(
      () =>
        new Promise<boolean>((resolve) => {
          if (localStorage.getItem("strawvine:cache-invalid") !== null) return resolve(false);
          const req = indexedDB.open("strawvine");
          req.onerror = () => resolve(false);
          req.onsuccess = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains("kv")) return (db.close(), resolve(false));
            const store = db.transaction("kv").objectStore("kv");
            const meta = store.get("b:meta");
            const legacy = store.get("base");
            legacy.onsuccess = () => (db.close(), resolve(meta.result != null || legacy.result != null));
            legacy.onerror = () => (db.close(), resolve(false));
          };
        }),
    );
  await expect.poll(trusted, { timeout: 20_000, intervals: [500] }).toBe(true);
}

/**
 * Start the page's clock at `time` and let it run in real time. (A fixed clock would freeze
 * `Date.now()`, which the app's animations and idle checks rely on.)
 */
export async function startClockAt(page: Page, time: Date) {
  await page.clock.install({ time });
  await page.clock.resume();
}
