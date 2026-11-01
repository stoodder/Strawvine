/**
 * Going offline right after signing in — before this device has saved its own copy of the data —
 * and reloading must land somewhere useful (the app, or a calm "you're offline" state), never an
 * endless splash.
 */
import { dismissCelebrations, expect, login, PASSWORD, test } from "./helpers";

test.use({ serviceWorkers: "allow" });

test("an offline reload within seconds of signing in doesn't hang on the splash", async ({ page, browser }) => {
  // Onboard once (fresh database). The onboarding may still be on its way to the server, so the
  // second sign-in can land on onboarding again — also fine: it's the app, not the splash.
  await dismissCelebrations(page);
  await login(page);

  const context = await browser.newContext({ baseURL: page.url(), serviceWorkers: "allow" });
  try {
    const tab = await context.newPage();
    await dismissCelebrations(tab);
    await tab.goto("/");
    // The service worker caches the app shell, so a reload can open offline at all.
    await expect
      .poll(() => tab.evaluate(async () => !!(await navigator.serviceWorker?.getRegistration())?.active), { timeout: 20_000 })
      .toBe(true);

    await tab.getByLabel("Password").fill(PASSWORD);
    await tab.getByRole("button", { name: "Sign in" }).click();
    const nav = tab.getByRole("navigation", { name: "Primary" });
    const onboarding = tab.getByRole("heading", { name: "Let's calibrate." });
    const app = nav.or(onboarding);
    await expect(app.first()).toBeVisible();
    const signedInAt = Date.now();

    await context.setOffline(true);
    await tab.reload();
    expect(Date.now() - signedInAt).toBeLessThan(4_000);

    const offline = tab.getByText(/You're offline|Couldn't reach Strawvine/);
    const signIn = tab.getByLabel("Password");
    await expect(app.or(offline).or(signIn).first()).toBeVisible({ timeout: 10_000 });

    // Back online it recovers by itself (or with "Try again").
    await context.setOffline(false);
    if (await offline.isVisible())
      await tab
        .getByRole("button", { name: "Try again" })
        .click({ timeout: 2_000 })
        .catch(() => {});
    await expect(app.or(signIn).first()).toBeVisible({ timeout: 20_000 });
  } finally {
    await context.close();
  }
});
