/**
 * Toasts live in the dock, outside the app root that a sheet makes inert: a toast's Undo must
 * still work while a sheet is open.
 */
import { expect, fillNumber, notifications, onboardedOn, serverData, test, toastMessage } from "./helpers";

test("a toast's Undo works while a sheet is open (Goals: remove a strength target)", async ({ page }) => {
  await onboardedOn(page);
  await page.getByRole("link", { name: "Goals" }).click();

  // Add a target: Bench press 300.
  await page.getByRole("button", { name: "Add strength target" }).click();
  const sheet = page.getByRole("dialog", { name: "New strength target" });
  await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: "Bench press" }).click();
  await fillNumber(page, "Target", "300");
  await sheet.getByRole("button", { name: "Add target" }).click();
  await expect(sheet).toHaveCount(0);
  const remove = page.getByRole("button", { name: "Remove Bench press target" });
  await expect(remove).toBeVisible();

  // Remove it, then open a sheet before pressing Undo.
  await remove.click();
  await expect(remove).toHaveCount(0);
  await expect(toastMessage(page, "Bench press target removed")).toBeVisible();
  await page.getByRole("button", { name: "Add strength target" }).click();
  await expect(sheet).toBeVisible();

  await notifications(page).getByRole("button", { name: "Undo" }).click();
  await expect(toastMessage(page, "Bench press target removed")).toHaveCount(0);
  // The sheet is still open: Undo didn't need it closed.
  await expect(sheet).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Remove Bench press target" })).toBeVisible();
  await expect.poll(async () => (await serverData(page)).settings.strengthTargets.map((t) => t.targetLb)).toEqual([300]);
});
