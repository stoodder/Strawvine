/**
 * The minimum calorie target (SPEC §4.4): Settings → Nutrition → "Minimum calories" is a floor
 * under the daily target. While it holds the target up, Today shows the minimum as the target with
 * one quiet line saying so, the rate beside it is the one that target is built for, and the
 * check-in and Goals say the same.
 */
import type { Page } from "@playwright/test";
import { expect, expectSynced, fillNumber, MONDAY, onboardedOn, pageOverflow, seedHistory, serverData, test } from "./helpers";

const fuel = (page: Page) => page.locator("section").filter({ has: page.getByRole("heading", { name: "Fuel", exact: true }) });
const num = (text: string | null) => Number((text ?? "").replace(/−/g, "-").replace(/[^\d.-]/g, ""));
const kcal = (n: number) => n.toLocaleString("en-US");
/** The Target tile: its number, and the lines under it. */
const targetTile = (page: Page) =>
  fuel(page)
    .locator(".label", { hasText: /^Target$/ })
    .locator("xpath=..");
const target = async (page: Page) =>
  num(
    await targetTile(page)
      .locator("xpath=div[2]")
      .evaluate((el) => el.firstChild!.textContent),
  );
const note = (page: Page) => page.locator("[data-floor-note]");
const minimum = (page: Page) => page.getByRole("textbox", { name: "Minimum calories", exact: true });
const serverMinimum = async (page: Page) => (await serverData(page)).settings.limits.minCalories;

async function setMinimum(page: Page, value: number) {
  await page.goto("/settings");
  await fillNumber(page, "Minimum calories", String(value));
  await expect(minimum(page)).toHaveValue(kcal(value));
  await expectSynced(page);
  await expect.poll(() => serverMinimum(page)).toBe(value);
}

test("Settings → Minimum calories is a floor under the target: Today shows the held target and says so", async ({ page }) => {
  await onboardedOn(page);
  // A weigh-in gives the day its target: maintenance at the starting estimate, well above the default minimum.
  await page.getByRole("button", { name: /^Morning check-in/ }).click();
  await fillNumber(page, "Morning weight", "200");
  await expect(fuel(page).locator("[data-fuel-side]")).toHaveAttribute("data-fuel-side", "left");
  const own = await target(page);
  expect(own).toBeGreaterThan(2000);
  await expect(note(page)).toHaveCount(0);
  await expectSynced(page);

  // The field sits with the other limits, shows the default, and says what it does.
  await page.goto("/settings");
  const nutrition = page.locator("section#nutrition");
  await expect(nutrition.getByRole("textbox", { name: "Minimum calories", exact: true })).toHaveValue("1,500");
  await expect(nutrition.getByText("Your daily target never goes below this, whatever the pace or the scale says")).toBeVisible();
  expect(await serverMinimum(page)).toBe(1500);

  // Out of range: a message by the field, nothing saved.
  await fillNumber(page, "Minimum calories", "500");
  await expect(nutrition.getByText("Between 800 and 5,000.")).toBeVisible();
  await expect(minimum(page)).toHaveAttribute("aria-invalid", "true");
  await expectSynced(page);
  expect(await serverMinimum(page)).toBe(1500);

  // Above the day's own target: the minimum holds it up.
  const floor = own + 200;
  await fillNumber(page, "Minimum calories", String(floor));
  await expect(minimum(page)).toHaveValue(kcal(floor));
  await expect(nutrition.getByText("Between 800 and 5,000.")).toHaveCount(0);
  await expectSynced(page);
  await expect.poll(() => serverMinimum(page)).toBe(floor);

  await page.getByRole("link", { name: "Back to Today" }).click();
  await expect(note(page)).toHaveText(`Held at your ${kcal(floor)} kcal minimum.`);
  expect(await target(page)).toBe(floor);
  await expect(targetTile(page)).toContainText("Maintenance");
  await expect(fuel(page).locator("[data-fuel-side]")).toHaveText(`${kcal(floor)} kcalleft`);
  // The line is under the target, in the tile's own muted text: no alert, no warning colour, no icon.
  await expect(targetTile(page).locator("[data-floor-note]")).toHaveCount(1);
  const colours = await note(page).evaluate((el) => ({
    note: getComputedStyle(el).color,
    sub: getComputedStyle(el.parentElement!).color,
    alert: !!el.closest("[role=alert]"),
    icons: el.querySelectorAll("svg").length,
  }));
  expect(colours.note).toBe(colours.sub);
  expect(colours.alert).toBe(false);
  expect(colours.icons).toBe(0);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 700 });
    expect(await pageOverflow(page), `${width}px, held target`).toBeNull();
  }
  await page.setViewportSize({ width: 412, height: 839 });

  // What is left counts down from the held target.
  await page.getByRole("button", { name: /^Nutrition/ }).click();
  await fillNumber(page, "Calories", "1000");
  await expect(fuel(page).locator("[data-fuel-side]")).toHaveText(`${kcal(floor - 1000)} kcalleft`);
  await expectSynced(page);

  // It is a setting: it survives a reload…
  await page.reload();
  await expect(note(page)).toHaveText(`Held at your ${kcal(floor)} kcal minimum.`);
  expect(await target(page)).toBe(floor);

  // …and lowered again, the target stands on its own and the line is gone.
  await setMinimum(page, 1500);
  await page.getByRole("link", { name: "Back to Today" }).click();
  await expect(fuel(page).locator("[data-fuel-side]")).toHaveText(`${kcal(own - 1000)} kcalleft`);
  expect(await target(page)).toBe(own);
  await expect(note(page)).toHaveCount(0);
});

test("a cut held at the minimum: the rate, the check-in and Goals all follow the held target", async ({ page }) => {
  await onboardedOn(page, MONDAY);
  await seedHistory(page);
  await page.goto("/");

  // The seeded cut (0.75 %/week): a target under the TDEE, standing on its own.
  const tile = targetTile(page);
  await expect(tile).toContainText(/Cut · −\d\.\d lb\/wk/);
  const own = await target(page);
  const paceRate = num((await tile.textContent())!.match(/Cut · (−\d\.\d) lb\/wk/)![1]!);
  const tdee = num(await fuel(page).locator("span", { hasText: /^TDEE/ }).first().locator(".num").first().textContent());
  expect(tdee).toBeGreaterThan(own);
  await expect(note(page)).toHaveCount(0);

  // A minimum halfway between the two: about half the deficit is left.
  const floor = Math.round((own + tdee) / 20) * 10;
  expect(floor).toBeGreaterThan(own);
  expect(floor).toBeLessThan(tdee);
  await setMinimum(page, floor);

  await page.getByRole("link", { name: "Back to Today" }).click();
  await expect(note(page)).toHaveText(`Held at your ${kcal(floor)} kcal minimum.`);
  expect(await target(page)).toBe(floor);
  await expect(tile).toContainText(/Cut · −\d\.\d lb\/wk/);
  const heldRateText = (await tile.textContent())!.match(/Cut · (−\d\.\d) lb\/wk/)![1]!;
  const heldRate = num(heldRateText);
  // Slower than the pace, still a loss.
  expect(heldRate).toBeLessThan(0);
  expect(heldRate).toBeGreaterThan(paceRate);

  // Progress → Week: next week's target is the held one, with the same line; the verdict and the
  // trend tile measure the week against the held rate, not the pace.
  await page.getByRole("link", { name: "Progress" }).click();
  const nextWeek = page.getByText("Next week", { exact: true }).locator("xpath=..");
  await expect(nextWeek).toContainText(`${kcal(floor)}kcal/day`);
  await expect(nextWeek.locator("[data-floor-note]")).toHaveText(`Held at your ${kcal(floor)} kcal minimum.`);
  const verdict = page.locator("[data-verdict]");
  await expect(verdict).toContainText(`against ${heldRateText} lb`);
  await expect(verdict).not.toHaveAttribute("data-verdict", "slower");
  await expect(page.getByText(`plan ${heldRateText}`)).toBeVisible();
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 700 });
    expect(await pageOverflow(page), `${width}px, Progress`).toBeNull();
  }
  await page.setViewportSize({ width: 412, height: 839 });

  // Goals: the slider still shows the pace that was chosen; the line under it says what the target is built for.
  await page.getByRole("link", { name: "Goals" }).click();
  const slider = page.getByRole("slider", { name: /^Pace/ });
  await expect(slider).toHaveValue("0.75");
  await expect(note(page)).toHaveText(
    `Your calorie target is held at your ${kcal(floor)} kcal minimum, so it is built for ${heldRateText} lb/wk for now.`,
  );
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 700 });
    expect(await pageOverflow(page), `${width}px, Goals`).toBeNull();
  }
});
