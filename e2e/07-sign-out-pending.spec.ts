/**
 * Signing out with a change that hasn't reached the server asks first; "Keep on this device"
 * holds it through the sign-out, and it syncs after signing back in.
 */
import { expect, fillNumber, login, onboardedOn, serverData, test } from "./helpers";

test("sign out with a pending change → keep it → it syncs after signing in again", async ({ page }) => {
  await onboardedOn(page);

  // The server never hears about day edits for now: the change stays pending.
  const blockDays = "**/api/days/**";
  await page.route(blockDays, (route) => (route.request().method() === "PUT" ? route.abort("failed") : route.fallback()));

  await page.getByRole("button", { name: /Nutrition/ }).click();
  await fillNumber(page, "Calories", "2222");

  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByText("1 change hasn't synced.")).toBeVisible();
  await page.getByRole("button", { name: "Keep on this device" }).click();
  await expect(page.getByLabel("Password")).toBeVisible();

  await page.unroute(blockDays);
  await login(page);
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();

  await expect
    .poll(async () => (await serverData(page)).days.find((d) => d.date === "2026-10-25")?.calories ?? null, { timeout: 20_000 })
    .toBe(2222);
  await page.getByRole("button", { name: /Nutrition/ }).click();
  await expect(page.getByRole("textbox", { name: "Calories" })).toHaveValue(/2,?222/);
});
