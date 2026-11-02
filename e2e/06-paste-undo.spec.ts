/**
 * Paste totals from a meal app: the readout shows what was read and what it replaces, "Use these"
 * applies it (focus stays on the Fuel editor), and the toast's Undo puts the previous numbers back.
 */
import { expect, expectFocusNotOnBody, fillNumber, notifications, onboardedOn, serverData, test, toastMessage } from "./helpers";

test("paste totals → replaces readout → Use these → Undo restores the previous values", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await onboardedOn(page);

  await page.getByRole("button", { name: /Nutrition/ }).click();
  await fillNumber(page, "Calories", "2000");
  await fillNumber(page, "Protein", "150");

  await page.evaluate(() => navigator.clipboard.writeText("2140 212 150 70"));
  await page.getByRole("button", { name: "Paste totals from a meal app" }).click();
  const panel = page.getByRole("group", { name: "Pasted totals" });
  await expect(panel).toBeVisible();
  // Where the clipboard can't be read the panel takes the paste by hand.
  const area = panel.getByRole("textbox", { name: "Paste nutrition totals" });
  if (await area.count()) await area.fill("2140 212 150 70");

  // What was read, and what it would overwrite (calories · protein · carbs · fat).
  await expect(panel).toContainText("2,140");
  await expect(panel.getByText(/^replaces/)).toHaveText(/replaces\s*2,000\s*·\s*150\s*·\s*—\s*·\s*—/);

  await panel.getByRole("button", { name: "Use these" }).click();
  await expect(panel).toHaveCount(0);
  await expectFocusNotOnBody(page, "Paste → Use these");
  await expect(page.getByRole("textbox", { name: "Calories" })).toHaveValue(/2,?140/);
  await expect(page.getByRole("textbox", { name: "Protein" })).toHaveValue("212");

  await expect(toastMessage(page, "Totals replaced")).toBeVisible();
  await notifications(page).getByRole("button", { name: "Undo" }).click();

  await expect(page.getByRole("textbox", { name: "Calories" })).toHaveValue(/2,?000/);
  await expect(page.getByRole("textbox", { name: "Protein" })).toHaveValue("150");
  await expect(page.getByRole("textbox", { name: "Carbs" })).toHaveValue("");
  await expect(page.getByRole("textbox", { name: "Fat" })).toHaveValue("");

  // The undo reached the server too.
  await expect
    .poll(async () => {
      const day = (await serverData(page)).days.find((d) => d.date === "2026-10-25");
      return day && [day.calories, day.proteinG, day.carbsG, day.fatG];
    })
    .toEqual([2000, 150, null, null]);
});
