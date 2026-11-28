/**
 * Settings › Previews: the app installed on the Home Screen has storage of its own (apart from
 * Safari's, where a `?flags=` link lands) and no address bar, so the previews are turned on in the
 * app itself. Each toggle sets this device's flag, says so in a dock toast, and what it turns on is
 * there at once (Settings' Rehab row, Program's Rehab section); off again, gone. A reload keeps it.
 */
import { expect, MONDAY, onboardedOn, test, toastMessage } from "./helpers";

const FLAGS_KEY = "strawvine:flags";

test("Previews: Rehab and New Train toggles turn the previews on and off for this device, saying so", async ({ page }) => {
  await onboardedOn(page, MONDAY);
  await page.goto("/settings");
  const previews = page.locator("#previews");
  await expect(previews.getByRole("heading", { level: 2, name: "Previews" })).toBeVisible();
  // Quiet, at the foot of the page: not in the jump list.
  await expect(page.getByRole("navigation", { name: "Settings sections" }).getByRole("link", { name: "Previews" })).toHaveCount(0);
  const rehab = previews.getByRole("switch", { name: "Rehab (preview)" });
  const train = previews.getByRole("switch", { name: "New Train (preview)" });
  await expect(rehab).toHaveAttribute("aria-checked", "false");
  await expect(train).toHaveAttribute("aria-checked", "false");
  await expect(previews.getByText("Only on this device · still being built")).toHaveCount(2);
  await expect(page.locator('[data-program-link="rehab"]')).toHaveCount(0);

  await rehab.click();
  await expect(rehab).toHaveAttribute("aria-checked", "true");
  await expect(toastMessage(page, "Rehab preview on for this device")).toBeVisible();
  await expect(page.locator('[data-program-link="rehab"]')).toBeVisible();
  expect(await page.evaluate((key) => localStorage.getItem(key), FLAGS_KEY)).toBe("rehab");

  await train.click();
  await expect(toastMessage(page, "New Train preview on for this device")).toBeVisible();
  expect(await page.evaluate((key) => localStorage.getItem(key), FLAGS_KEY)).toBe("trainDay,rehab");

  // Kept across a reload; Program has its Rehab section.
  await page.reload();
  await expect(page.locator("#previews").getByRole("switch", { name: "Rehab (preview)" })).toHaveAttribute("aria-checked", "true");
  await page.goto("/program");
  await expect(page.getByRole("heading", { level: 2, name: "Rehab" })).toBeVisible();

  await page.goto("/settings");
  await page.locator("#previews").getByRole("switch", { name: "Rehab (preview)" }).click();
  await expect(toastMessage(page, "Rehab preview off for this device")).toBeVisible();
  await expect(page.locator('[data-program-link="rehab"]')).toHaveCount(0);
  await page.locator("#previews").getByRole("switch", { name: "New Train (preview)" }).click();
  expect(await page.evaluate((key) => localStorage.getItem(key), FLAGS_KEY)).toBeNull();
  await page.goto("/program");
  await expect(page.getByRole("heading", { level: 2, name: "Cycle weeks" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Rehab" })).toHaveCount(0);
});

test("Previews: storage that refuses says so, and the toggle shows what is stored", async ({ page }) => {
  await onboardedOn(page, MONDAY);
  await page.goto("/settings");
  await page.evaluate((key) => {
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k: string, v: string) {
      if (k === key) throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
      return set.call(this, k, v);
    };
  }, FLAGS_KEY);
  const rehab = page.locator("#previews").getByRole("switch", { name: "Rehab (preview)" });
  await rehab.click();
  await expect(toastMessage(page, "Couldn't change the Rehab preview: this device didn't let Strawvine save it")).toBeVisible();
  await expect(rehab).toHaveAttribute("aria-checked", "false");
});
