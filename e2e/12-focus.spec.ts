/**
 * Focus never drops to <body> after actions that replace the control that was pressed:
 * Skip today (accessory), logging the AMRAP set, applying the bump, Finish.
 * (Paste → "Use these" is covered in 06-paste-undo.)
 */
import { expect, expectFocusNotOnBody, MONDAY, onboardedOn, test } from "./helpers";

test.beforeEach(async ({ page }) => {
  await onboardedOn(page, MONDAY);
  await page.getByRole("link", { name: "Train" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Push/);
});

test("Skip today moves focus to the exercise's Unskip button", async ({ page }) => {
  await page.getByRole("button", { name: "Exercise", exact: true }).click();
  const sheet = page.getByRole("dialog");
  await sheet.getByRole("button", { name: /^Pull-up/ }).click();
  await expect(sheet).toHaveCount(0);

  await page.getByRole("button", { name: "Pull-up options" }).click();
  await page.getByRole("dialog").getByRole("button", { name: /^Skip today/ }).click();
  // Focus is still on the sheet's button until the sheet has closed: wait for where it lands.
  await expect.poll(() => expectFocusNotOnBody(page, "Skip today"), { timeout: 10_000 }).toContain("Unskip Pull-up");
});

test("AMRAP log, apply and Finish keep focus off <body>", async ({ page }) => {
  const sets = page.getByRole("button", { name: /^Bench press set \d+:/ });
  const count = await sets.count();
  for (let i = 0; i < count - 1; i++) await page.getByRole("button", { name: new RegExp(`^Bench press set ${i + 1}:`) }).click();
  await page.getByRole("button", { name: new RegExp(`^Bench press set ${count}:.*AMRAP`) }).click();

  const amrap = page.getByRole("dialog", { name: /AMRAP/ });
  await amrap.getByRole("button", { name: "Increase reps" }).click();
  await amrap.getByRole("button", { name: /^Log \d+ reps$/ }).click();
  await expect(amrap.getByText("Target beaten")).toBeVisible();
  await expectFocusNotOnBody(page, "AMRAP log");

  await amrap.getByRole("button", { name: "Apply" }).click();
  await expect(amrap).toHaveCount(0);
  await expectFocusNotOnBody(page, "applying the AMRAP bump");

  await page.getByRole("button", { name: "Finish session" }).click();
  await expect(page.getByRole("heading", { name: "Session complete" })).toBeVisible();
  const focused = await expectFocusNotOnBody(page, "Finish");
  expect(focused).toContain("Session complete");
});
