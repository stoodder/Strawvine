/**
 * Weighted is its own choice, next to the measure: a weighted dead hang (time + load) shows and
 * logs a load; an unweighted plank (time only) has no load anywhere. The flag can be changed
 * later in Settings' exercise library.
 */
import { expect, expectSynced, MONDAY, onboardedOn, serverData, test } from "./helpers";

test.beforeEach(async ({ page }) => {
  await onboardedOn(page, MONDAY);
  await page.getByRole("link", { name: "Train" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Push/);
});

async function create(page: import("@playwright/test").Page, name: string, measure: string, weighted: boolean) {
  await page.getByRole("button", { name: "Exercise", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Add exercise" });
  await sheet.getByRole("textbox", { name: "Search or create exercise" }).fill(name);
  await sheet.getByRole("button", { name: measure, exact: true }).click();
  const toggle = sheet.getByRole("switch", { name: "Weighted" });
  await expect(toggle).toHaveAttribute("aria-checked", "true"); // on by default
  if (!weighted) await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", String(weighted));
  await sheet.getByRole("button", { name: /Create & add/ }).click();
  await expect(sheet).toHaveCount(0);
}

test("a weighted hold logs a load; an unweighted one has none", async ({ page }) => {
  await create(page, "Weighted dead hang", "Time", true);
  // No load yet: the chip says so, so there's something to set.
  const first = page.getByRole("button", { name: /^Weighted dead hang set 1: 30\s?s\s*\(no load\)$/ });
  await expect(first).toBeVisible();

  await first.focus();
  await page.keyboard.press("Shift+F10");
  const editor = page.getByRole("dialog", { name: "Weighted dead hang · set 1" });
  await expect(editor.getByText("Load · lb")).toBeVisible();
  for (let i = 0; i < 5; i++) await editor.getByRole("button", { name: "Increase load" }).click();
  await editor.getByRole("button", { name: "Log set" }).click();
  await expect(page.getByRole("button", { name: /^Weighted dead hang set 1: 30\s?s\s+at\s+25\s+lb$/ })).toBeVisible();
  // The load carries to the open sets.
  await expect(page.getByRole("button", { name: /^Weighted dead hang set 2: 30\s?s\s+at\s+25\s+lb$/ })).toBeVisible();

  await create(page, "Plank", "Time", false);
  const plank = page.getByRole("button", { name: /^Plank set 1: 30\s?s$/ });
  await expect(plank).toBeVisible();
  await plank.focus();
  await page.keyboard.press("Shift+F10");
  const plankEditor = page.getByRole("dialog", { name: "Plank · set 1" });
  await expect(plankEditor.getByText("Seconds", { exact: true })).toBeVisible();
  await expect(plankEditor.getByRole("button", { name: "Increase load" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  await expectSynced(page);
  const { exercises } = await serverData(page);
  expect(exercises.find((e) => e.name === "Weighted dead hang")).toMatchObject({ measure: "seconds", weighted: true });
  expect(exercises.find((e) => e.name === "Plank")).toMatchObject({ measure: "seconds", weighted: false });

  // Made weighted later in the library: the plank's sets now offer a load.
  await page.goto("/settings");
  const chip = page.getByRole("button", { name: "Plank: track load" });
  await expect(chip).toHaveAttribute("aria-pressed", "false");
  await chip.click();
  await expect(chip).toHaveAttribute("aria-pressed", "true");
  await page.goto("/train");
  await expect(page.getByRole("button", { name: /^Plank set 1: 30\s?s\s*\(no load\)$/ })).toBeVisible();
});
