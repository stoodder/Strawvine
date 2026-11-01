/**
 * Offline: an edit made with no connection is kept on the device, survives a reload while still
 * offline, and reaches the server once back online.
 */
import { expect, test } from "@playwright/test";
import { dismissCelebrations, fillNumber, login, waitForDeviceCopy } from "./helpers";

test.use({ serviceWorkers: "allow" });

test("an offline write survives a reload and syncs when back online", async ({ page, context }) => {
  // No fake clock here: a reload re-installs it paused, and the app's startup waits on timers.
  await dismissCelebrations(page);
  await login(page);
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
  // Let the service worker install and cache this build (so the app opens offline).
  await expect
    .poll(() => page.evaluate(async () => !!(await navigator.serviceWorker?.getRegistration())?.active), { timeout: 20_000 })
    .toBe(true);
  await page.reload();
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
  await waitForDeviceCopy(page);

  await context.setOffline(true);
  await page.getByRole("button", { name: /Nutrition/ }).click();
  await fillNumber(page, "Calories", "2450");
  const pill = page.getByRole("button", { name: /Offline · \d+ pending/ });
  await expect(pill).toBeVisible();
  // The sync pill lives in the dock, above the nav (never on top of it).
  const pillBox = (await pill.boundingBox())!;
  const navBox = (await page.getByRole("navigation", { name: "Primary" }).boundingBox())!;
  expect(pillBox.y + pillBox.height).toBeLessThanOrEqual(navBox.y);

  await page.reload();
  await page.getByRole("button", { name: /Nutrition/ }).click();
  await expect(page.getByRole("textbox", { name: "Calories" })).toHaveValue(/2,?450/);
  await expect(page.getByRole("button", { name: /Offline · \d+ pending/ })).toBeVisible();

  await context.setOffline(false);
  await expect(page.getByRole("button", { name: /pending/ })).toHaveCount(0, { timeout: 20_000 });

  // The server has it: a fresh context (no device copy) sees the value.
  const fresh = await context.browser()!.newContext({ baseURL: page.url(), storageState: await context.storageState() });
  const other = await fresh.newPage();
  await other.goto("/");
  await other.getByRole("button", { name: /Nutrition/ }).click();
  await expect(other.getByRole("textbox", { name: "Calories" })).toHaveValue(/2,?450/);
  await fresh.close();
});
