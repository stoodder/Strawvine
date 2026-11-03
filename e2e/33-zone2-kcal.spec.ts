/**
 * The Zone 2 machine kcal reading (SPEC §3.5): logged in the Zone 2 editor beside the duration,
 * summarised in the Zone 2 row and totalled in the weekly check-in — and never part of the day's
 * calories: Today's targets, intake, macros and TDEE read exactly as before. Out of range it is
 * refused. Nothing overflows a 320 px phone with the editor open.
 */
import type { Locator, Page } from "@playwright/test";
import { dismissCelebrations, expect, expectSynced, fillNumber, login, pageOverflow, serverData, startClockAt, test } from "./helpers";

/** Friday of the suite's first week (a Zone 2 day); the template onboarded on the Sunday before. */
const FRIDAY = new Date(2026, 9, 30, 10, 0, 0);
const TODAY = "2026-10-30";

/** The Zone 2 row's text button (the dot beside it is "Zone 2 complete"). */
const zone2Row = (page: Page) => page.getByRole("button", { name: /^Zone 2(?! complete)/ });
const section = (page: Page, name: string) => page.locator("section").filter({ has: page.getByRole("heading", { name, exact: true }) });
/** A Stat tile (label, value, unit, sub) by its label. */
const stat = (scope: Locator, label: string) => scope.getByText(label, { exact: true }).locator("xpath=..");

test("Zone 2 machine kcal is logged beside the duration and leaves Today's calories alone", async ({ page }) => {
  await startClockAt(page, FRIDAY);
  await dismissCelebrations(page);
  await login(page);

  // Two weeks of weights and calories through yesterday (so Today has targets), and Tuesday's
  // ride with its machine reading (for the check-in).
  for (let i = 14; i >= 1; i--) {
    const date = new Date(Date.UTC(2026, 9, 30 - i)).toISOString().slice(0, 10);
    const body: Record<string, number | boolean> = { weightLb: 200 + i * 0.1, calories: 2500, proteinG: 190 };
    if (date === "2026-10-27") Object.assign(body, { zone2Done: true, zone2Minutes: 40, zone2Kcal: 410 });
    expect((await page.request.put(`/api/days/${date}`, { data: body })).ok(), date).toBe(true);
  }
  expect((await page.request.put(`/api/days/${TODAY}`, { data: { calories: 1800, proteinG: 150, carbsG: 200, fatG: 60 } })).ok()).toBe(true);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const fuel = section(page, "Fuel");
  await expect(stat(fuel, "Target")).toBeVisible();
  await expect(fuel).toContainText("1,800");
  const fuelBefore = await fuel.innerText();
  const nutritionBefore = await page.getByRole("button", { name: /^Nutrition/ }).innerText();

  // The editor: duration, then the machine's reading next to it.
  await zone2Row(page).click();
  const kcal = page.getByRole("textbox", { name: "Zone 2 machine calories", exact: true });
  await expect(page.getByText("Machine reading · not added to intake")).toBeVisible();
  await fillNumber(page, "Zone 2 minutes", "30");
  await fillNumber(page, "Zone 2 machine calories", "320.4"); // whole kcal
  await expect(kcal).toHaveValue("320");
  // Same line as the minutes at 390.
  const [minBox, kcalBox] = [await page.getByRole("textbox", { name: "Zone 2 minutes" }).boundingBox(), await kcal.boundingBox()];
  expect(Math.abs(minBox!.y + minBox!.height - (kcalBox!.y + kcalBox!.height))).toBeLessThan(16);
  // Out of range: refused, the range said under the field.
  await fillNumber(page, "Zone 2 machine calories", "4000");
  await expect(kcal).toHaveValue("320");
  await expect(kcal).toHaveAttribute("aria-invalid", "true");
  await expect(kcal).toHaveAccessibleDescription("Zone 2 machine calories not saved: use 0–3000 kcal");
  await expect(page.getByText("0–3000 kcal")).toBeVisible();
  // Nothing sticks out of a 320 px phone, the hint showing.
  await page.setViewportSize({ width: 320, height: 568 });
  expect(await pageOverflow(page)).toBeNull();
  for (const box of [await page.getByRole("textbox", { name: "Zone 2 minutes" }).boundingBox(), await kcal.boundingBox()])
    expect(box!.x + box!.width).toBeLessThanOrEqual(320 - 16 + 0.5);
  await fillNumber(page, "Zone 2 machine calories", "320");
  await expect(kcal).not.toHaveAttribute("aria-invalid", "true");
  await zone2Row(page).click(); // close the editor
  await expectSynced(page);

  const day = (await serverData(page)).days.find((d) => d.date === TODAY);
  expect(day).toMatchObject({ zone2Done: true, zone2Minutes: 30, zone2Kcal: 320, calories: 1800, proteinG: 150 });

  // The row: done, with the minutes and the reading.
  await expect(zone2Row(page)).toContainText("Cycling · 320 kcal");
  await expect(zone2Row(page)).toContainText("30 min");
  await expect(page.getByRole("button", { name: "Zone 2 complete" })).toHaveAttribute("aria-pressed", "true");
  expect(await pageOverflow(page)).toBeNull();

  // Today's calories, targets, macros and TDEE: exactly as before — and after a reload.
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await fuel.innerText()).toBe(fuelBefore);
  expect(await page.getByRole("button", { name: /^Nutrition/ }).innerText()).toBe(nutritionBefore);
  await page.reload();
  await expect(stat(fuel, "Target")).toBeVisible();
  expect(await fuel.innerText()).toBe(fuelBefore);

  // The check-in (Oct 23–29): Tuesday's reading under the Zone 2 count; intake still the food alone.
  await page.getByRole("link", { name: "Progress" }).click();
  const checkin = section(page, "Weekly check-in");
  await expect(stat(checkin, "Avg intake")).toContainText("2,500");
  await expect(checkin.getByText("Zone 2", { exact: true }).locator("xpath=..")).toContainText("410 kcal");
  expect(await pageOverflow(page)).toBeNull();
});
