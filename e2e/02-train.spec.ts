/**
 * Monday, week 1: the bench AMRAP last set beats its target and the max bump is applied.
 */
import { expect, test } from "@playwright/test";
import { dismissCelebrations, login, MONDAY } from "./helpers";

test("Monday session: log the main lift, beat the AMRAP and apply the bump", async ({ page }) => {
  await page.clock.setFixedTime(MONDAY);
  await dismissCelebrations(page);
  await login(page);

  await page.getByRole("link", { name: "Train" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Push/);

  // Main lift sets: tap to log; the last one is the AMRAP (opens its counter).
  const sets = page.getByRole("button", { name: /^Bench press set \d+:/ });
  const count = await sets.count();
  expect(count).toBeGreaterThanOrEqual(2);
  for (let i = 0; i < count - 1; i++) {
    await page.getByRole("button", { name: new RegExp(`^Bench press set ${i + 1}:`) }).click();
  }
  await page.getByRole("button", { name: new RegExp(`^Bench press set ${count}:.*AMRAP`) }).click();

  const amrap = page.getByRole("dialog", { name: /AMRAP/ });
  await expect(amrap).toBeVisible();
  // Three reps over target.
  for (let i = 0; i < 3; i++) await amrap.getByRole("button", { name: "Increase reps" }).click();
  await expect(amrap.getByText(/\+3 over target/)).toBeVisible();
  await amrap.getByRole("button", { name: /^Log \d+ reps$/ }).click();

  await expect(amrap.getByText("Target beaten")).toBeVisible();
  await amrap.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByRole("dialog", { name: /AMRAP/ })).toHaveCount(0);

  // 3 extra reps × 1 lb: the bench max moves 225 → 228, and survives a reload.
  await expect(page.getByRole("button", { name: "max 228" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "max 228" })).toBeVisible();
});
