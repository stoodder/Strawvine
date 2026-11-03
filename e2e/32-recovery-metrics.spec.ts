/**
 * Optional recovery metrics and the "Also today" flags (SPEC §3.3, §3.4): resting HR and VO2 max
 * are logged in the morning editor, shown on Today (Recovery, the Weigh-in summary) and averaged /
 * trended in the weekly check-in; alcohol, nicotine, THC and caffeine are tracking-only chips in
 * the Nutrition editor (on/off: a second tap clears back to not recorded, in a neutral style, not
 * lime). Readings out of range are refused, not clamped. Neither closes the day. Nothing overflows
 * a 320 px phone with both open.
 */
import type { Locator, Page } from "@playwright/test";
import { dismissCelebrations, expect, expectSynced, fillNumber, login, pageOverflow, serverData, startClockAt, test } from "./helpers";

/** Friday of the suite's first week; the template onboarded on the Sunday before. */
const FRIDAY = new Date(2026, 9, 30, 10, 0, 0);
const TODAY = "2026-10-30";

const morningRow = (page: Page) => page.getByRole("button", { name: /^Weigh-in/ });
const nutritionRow = (page: Page) => page.getByRole("button", { name: /^Nutrition/ });
/** A Stat tile (label, value, unit, sub) by its label. */
const stat = (scope: Page | Locator, label: string) => scope.getByText(label, { exact: true }).locator("xpath=..");

async function logMorning(page: Page, path: string, rhr: string, vo2: string) {
  await page.goto(path);
  await morningRow(page).click();
  await fillNumber(page, "Resting HR", rhr);
  await fillNumber(page, "VO2 max", vo2);
  await morningRow(page).click(); // close the editor
}

test("resting HR and VO2 max from the morning editor show on Today and in the check-in", async ({ page }) => {
  await startClockAt(page, FRIDAY);
  await dismissCelebrations(page);
  await login(page);

  // Earlier this week, through the API: weights and calories (so the check-in exists) and the metrics.
  const history: Array<[string, Record<string, number>]> = [
    ["2026-10-26", { weightLb: 201, calories: 2500, restingHrBpm: 50, vo2Max: 50 }],
    ["2026-10-27", { weightLb: 200.8, calories: 2450, restingHrBpm: 52 }],
    ["2026-10-28", { weightLb: 200.6, calories: 2480, restingHrBpm: 48 }],
  ];
  for (const [date, body] of history) expect((await page.request.put(`/api/days/${date}`, { data: body })).ok()).toBe(true);

  // Thursday and today in the morning editor, at a narrow phone's width.
  await page.setViewportSize({ width: 320, height: 568 });
  await logMorning(page, "/day/2026-10-29", "50", "51.2");
  await page.goto("/");
  await morningRow(page).click();
  const rhrInput = page.getByRole("textbox", { name: "Resting HR", exact: true });
  const vo2Input = page.getByRole("textbox", { name: "VO2 max", exact: true });
  await fillNumber(page, "Resting HR", "48.6"); // whole bpm
  await fillNumber(page, "VO2 max", "51.54"); // one decimal, saved as shown
  await expect(rhrInput).toHaveValue("49");
  await expect(vo2Input).toHaveValue("51.5");
  // Units sit in the boxes.
  await expect(rhrInput.locator("xpath=..")).toContainText("bpm");
  await expect(page.getByRole("textbox", { name: "HRV", exact: true }).locator("xpath=..")).toContainText("ms");
  // Out of range: refused (not clamped to a believable 20 bpm), the range said under the field.
  await fillNumber(page, "Resting HR", "5");
  await expect(rhrInput).toHaveValue("49");
  await expect(rhrInput).toHaveAttribute("aria-invalid", "true");
  await expect(rhrInput).toHaveAccessibleDescription("Resting HR not saved: use 20–220 bpm");
  await expect(page.getByText("20–220 bpm")).toBeVisible();
  expect(await pageOverflow(page)).toBeNull();
  await fillNumber(page, "VO2 max", "520");
  await expect(vo2Input).toHaveValue("51.5");
  await expect(vo2Input).toHaveAttribute("aria-invalid", "true");
  expect(await pageOverflow(page)).toBeNull();
  // The next accepted entry clears it.
  await fillNumber(page, "Resting HR", "49");
  await expect(rhrInput).not.toHaveAttribute("aria-invalid", "true");
  await expect(page.getByText("20–220 bpm")).toHaveCount(0);
  await morningRow(page).click();
  await expectSynced(page);

  const server = await serverData(page);
  expect(server.days.find((d) => d.date === "2026-10-29")).toMatchObject({ restingHrBpm: 50, vo2Max: 51.2 });
  expect(server.days.find((d) => d.date === TODAY)).toMatchObject({ restingHrBpm: 49, vo2Max: 51.5, weightLb: null });

  // Today: in the Recovery stats (VO2 max without its unit, which would wrap here), and in the
  // Weigh-in row's summary — which they don't close.
  const recovery = page.locator("section").filter({ has: page.getByRole("heading", { name: "Recovery", exact: true }) });
  await expect(stat(recovery, "Resting HR")).toHaveText("Resting HR49bpm");
  await expect(stat(recovery, "VO2 max")).toHaveText("VO2 max51.5");
  await expect(morningRow(page)).toContainText("RHR");
  await expect(page.getByRole("button", { name: /resting heart rate 49/ })).toHaveCount(1);
  await expect(morningRow(page)).toContainText("not done");
  expect(await pageOverflow(page)).toBeNull();

  // The check-in (Oct 23–29): the week's average resting HR, the latest VO2 max and its change.
  await page.getByRole("link", { name: "Progress" }).click();
  const checkin = page.locator("section").filter({ has: page.getByRole("heading", { name: "Weekly check-in", exact: true }) });
  await expect(stat(checkin, "Resting HR")).toHaveText("Resting HR50bpmaverage");
  await expect(stat(checkin, "VO2 max")).toHaveText("VO2 max51.2mL/kg/min+1.2 since Oct 26");
  expect(await pageOverflow(page)).toBeNull();
});

test("Also today chips in the Nutrition editor are saved as tracking-only flags", async ({ page }) => {
  await startClockAt(page, FRIDAY);
  await dismissCelebrations(page);
  await login(page);
  await page.setViewportSize({ width: 320, height: 568 });

  await nutritionRow(page).click();
  const group = page.getByRole("group", { name: "Also today" });
  const chip = (name: string) => group.getByRole("button", { name, exact: true });
  for (const name of ["Alcohol", "Nicotine", "THC", "Caffeine"]) await expect(chip(name)).toHaveAttribute("aria-pressed", "false");

  await chip("Caffeine").click();
  await chip("Alcohol").click();
  await expect(chip("Caffeine")).toHaveAttribute("aria-pressed", "true");
  await expect(chip("Alcohol")).toHaveAttribute("aria-pressed", "true");
  // Pressed is a neutral fill — not the lime of "done" — and carries no check mark.
  const look = await chip("Caffeine").evaluate((b) => ({ bg: getComputedStyle(b).backgroundColor, svg: !!b.querySelector("svg") }));
  expect(look.svg).toBe(false);
  expect(look.bg).not.toMatch(/183,\s*243,\s*106|b7f36a/i);
  // Tapping again clears it back to not recorded (the server gets null, never false).
  await chip("Alcohol").click();
  await expect(chip("Alcohol")).toHaveAttribute("aria-pressed", "false");
  await expectSynced(page);
  expect((await serverData(page)).days.find((d) => d.date === TODAY)).toMatchObject({ caffeine: true, alcohol: null });

  // 44px targets: two by two inside a 320 px phone, all four in a row at 390.
  const boxes = async () => Promise.all(["Alcohol", "Nicotine", "THC", "Caffeine"].map(async (n) => (await chip(n).boundingBox())!));
  const rows = (bs: Array<{ y: number }>) => new Set(bs.map((b) => Math.round(b.y))).size;
  let bs = await boxes();
  for (const box of bs) {
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.x + box.width).toBeLessThanOrEqual(320 - 16 + 0.5);
  }
  expect(rows(bs)).toBe(2);
  expect(await pageOverflow(page)).toBeNull();
  await page.setViewportSize({ width: 390, height: 844 });
  bs = await boxes();
  expect(rows(bs)).toBe(1);
  for (const box of bs) expect(box.x + box.width).toBeLessThanOrEqual(390 - 16 + 0.5);
  expect(await pageOverflow(page)).toBeNull();
  await nutritionRow(page).click();
  await expectSynced(page);

  const day = (await serverData(page)).days.find((d) => d.date === TODAY);
  expect(day).toMatchObject({ caffeine: true, alcohol: null, nicotine: null, thc: null, calories: null });
  // The Nutrition row lists what was had; nothing else changes.
  await expect(nutritionRow(page)).toContainText("Caffeine");
  await expect(nutritionRow(page)).not.toContainText("Alcohol");
  await expect(nutritionRow(page)).toContainText("not done");
});
