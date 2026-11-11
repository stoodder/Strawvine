/**
 * Program and Settings: the program name is an inline text field (Enter commits, Escape reverts) and the
 * high-contrast switch is mirrored onto <html data-contrast="high">; both survive a reload.
 */
import { expect, onboardedOn, serverData, test } from "./helpers";

test("rename the program inline: Escape reverts, Enter commits, and it persists", async ({ page }) => {
  await onboardedOn(page);
  await page.goto("/program");

  const name = page.getByRole("textbox", { name: "Program name" });
  const original = await name.inputValue();
  expect(original).not.toBe("");

  await name.click();
  await name.fill("Not this one");
  await name.press("Escape");
  await expect(name).toHaveValue(original);

  await name.click();
  await name.fill("Autumn block");
  await name.press("Enter");
  await expect(name).toHaveValue("Autumn block");
  await expect(name).not.toBeFocused();

  await expect.poll(async () => (await serverData(page)).settings.program.name).toBe("Autumn block");
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Program name" })).toHaveValue("Autumn block");
});

test("high contrast is applied to <html> and persists across a reload", async ({ page }) => {
  await onboardedOn(page);
  await page.goto("/settings");
  const html = page.locator("html");
  const toggle = page.getByRole("switch", { name: "High contrast" });

  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(html).not.toHaveAttribute("data-contrast", "high");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(html).toHaveAttribute("data-contrast", "high");

  await expect.poll(async () => (await serverData(page)).settings.display?.highContrast).toBe(true);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-contrast", "high");
  await expect(page.getByRole("switch", { name: "High contrast" })).toHaveAttribute("aria-checked", "true");

  // And off again.
  await page.getByRole("switch", { name: "High contrast" }).click();
  await expect(page.locator("html")).not.toHaveAttribute("data-contrast", "high");
  await expect.poll(async () => (await serverData(page)).settings.display?.highContrast).toBe(false);
  await page.reload();
  await expect(page.getByRole("switch", { name: "High contrast" })).toHaveAttribute("aria-checked", "false");
  await expect(page.locator("html")).not.toHaveAttribute("data-contrast", "high");
});
