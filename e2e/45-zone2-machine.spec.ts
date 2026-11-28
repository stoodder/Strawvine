/**
 * Zone 2 on any machine (SPEC §3.5): chosen with chips in Today's Zone 2 editor (Bike · Row ·
 * Elliptical · Ski · + Other), remembered from the last day with Zone 2 (derived, nothing stored for
 * it), written with the day's first Zone 2 value — never by a chip alone — and named in the Zone 2
 * row ("Rowing · 320 kcal") and the shared check-in. A day logged before machines were reads as the
 * bike ("Cycling"). The chips are a radio group a keyboard can work, and fit a 320 px phone.
 */
import type { Page } from "@playwright/test";
import { expect, expectSynced, fillNumber, MONDAY, MONDAY_ISO, onboardedOn, pageOverflow, serverData, test } from "./helpers";

/** The Zone 2 row's text button (the dot beside it is "Zone 2 complete"). */
const zone2Row = (page: Page) => page.locator("button[aria-controls]").filter({ hasText: /^Zone 2/ });
const editor = (page: Page) => page.getByRole("group", { name: "Zone 2 details" });
const machines = (page: Page) => editor(page).getByRole("radiogroup", { name: "Machine" });
const chip = (page: Page, name: string) => machines(page).getByRole("radio", { name, exact: true });
/** The line under the chips (the radio group's description). */
const caption = (page: Page) => editor(page).locator("p").first();
const serverDay = async (page: Page, date: string) => (await serverData(page)).days.find((d) => d.date === date);
/** Days are put one at a time: each through the API, as a phone that logged them before. */
const put = async (page: Page, date: string, body: Record<string, unknown>) =>
  expect((await page.request.put(`/api/days/${date}`, { data: body })).ok(), date).toBe(true);

const TUESDAY = new Date(2026, 9, 27, 10, 0, 0);
const WEDNESDAY = new Date(2026, 9, 28, 10, 0, 0);

test("the machine is picked on Today, written with the first value, remembered and named", async ({ page }) => {
  await page.addInitScript(() => {
    // The share sheet, as a phone has it: what is shared is kept for the test to read.
    Object.assign(navigator, {
      canShare: () => true,
      share: async (d: { text: string }) => void ((window as unknown as { __shared: string }).__shared = d.text),
    });
  });
  await onboardedOn(page, MONDAY);
  // Last Friday's ride, logged before machines were (no machine): it reads as the bike. A week of weights and
  // calories so the check-in has something to show.
  for (let i = 1; i <= 7; i++) {
    const date = new Date(Date.UTC(2026, 9, 26 - i)).toISOString().slice(0, 10);
    await put(page, date, { weightLb: 200, calories: 2400, ...(date === "2026-10-23" ? { zone2Done: true, zone2Minutes: 30 } : {}) });
  }
  await page.reload();
  await expect(zone2Row(page)).toContainText("Cycling");

  // Monday: the bike, as last time.
  await zone2Row(page).click();
  await expect(machines(page).getByRole("radio")).toHaveText(["Bike", "Row", "Elliptical", "Ski", "Other"]);
  await expect(chip(page, "Bike")).toHaveAttribute("aria-checked", "true");
  await expect(machines(page)).toHaveAccessibleDescription("Same as last time · Fri");

  // A chip alone changes the screen only: nothing is written, no day is created.
  await chip(page, "Row").click();
  await expect(chip(page, "Row")).toHaveAttribute("aria-checked", "true");
  await expect(chip(page, "Bike")).toHaveAttribute("aria-checked", "false");
  await expect(caption(page)).toHaveText("Your choice today");
  await expect(zone2Row(page)).toContainText("Rowing");
  await expectSynced(page);
  expect(await serverDay(page, MONDAY_ISO)).toBeUndefined();

  // The first value carries it.
  await fillNumber(page, "Zone 2 minutes", "30");
  await fillNumber(page, "Zone 2 machine calories", "320");
  await expectSynced(page);
  expect(await serverDay(page, MONDAY_ISO)).toMatchObject({ zone2Done: true, zone2Minutes: 30, zone2Kcal: 320, zone2Machine: "row" });
  await expect(zone2Row(page)).toContainText("Rowing · 320 kcal");
  await page.reload();
  await expect(zone2Row(page)).toContainText("Rowing · 320 kcal");
  await expect(zone2Row(page)).toContainText("30 min");

  // Tuesday starts on the rower — by keyboard, Other, named, then ticked off with the dot.
  await page.clock.setSystemTime(TUESDAY);
  await page.goto("/");
  await zone2Row(page).click();
  await expect(chip(page, "Row")).toHaveAttribute("aria-checked", "true");
  await expect(machines(page)).toHaveAccessibleDescription("Same as last time · Mon");
  await chip(page, "Row").focus();
  await page.keyboard.press("ArrowRight");
  await expect(chip(page, "Elliptical")).toBeFocused();
  await expect(chip(page, "Elliptical")).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("End");
  await expect(chip(page, "Other")).toBeFocused();
  await expect(chip(page, "Other")).toHaveAttribute("aria-checked", "true");
  await expect(caption(page)).toHaveText("Name it below");
  // One tab stop for the group: the next is Other's name.
  await page.keyboard.press("Tab");
  const name = editor(page).getByRole("textbox", { name: "Machine name" });
  await expect(name).toBeFocused();
  await page.keyboard.type("Assault bike");
  await page.keyboard.press("Enter");
  await expect(caption(page)).toHaveText("Your choice today");
  await expect(zone2Row(page)).toContainText("Assault bike");
  await page.getByRole("button", { name: "Zone 2 complete" }).click();
  await expectSynced(page);
  expect(await serverDay(page, "2026-10-27")).toMatchObject({ zone2Done: true, zone2Minutes: 30, zone2Machine: "Assault bike" });

  // Wednesday: the owner's own machine is a chip now, and the one to start on.
  await page.clock.setSystemTime(WEDNESDAY);
  await page.goto("/");
  await zone2Row(page).click();
  await expect(machines(page).getByRole("radio")).toHaveText(["Bike", "Row", "Elliptical", "Ski", "Assault bike", "Other"]);
  await expect(chip(page, "Assault bike")).toHaveAttribute("aria-checked", "true");
  await expect(machines(page)).toHaveAccessibleDescription("Same as last time · Tue");
  await expect(editor(page).getByRole("textbox", { name: "Machine name" })).toHaveCount(0);
  // Fits a 320 px phone, the chips wrapping inside the gutters.
  await page.setViewportSize({ width: 320, height: 640 });
  expect(await pageOverflow(page)).toBeNull();
  for (const r of await machines(page).getByRole("radio").all()) {
    const box = (await r.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(320 - 16 + 0.5);
  }
  await page.setViewportSize({ width: 390, height: 844 });

  // A past day logged before machines were: the bike; another chip there writes at once.
  await page.goto("/day/2026-10-23");
  await zone2Row(page).click();
  await expect(chip(page, "Bike")).toHaveAttribute("aria-checked", "true");
  await chip(page, "Ski").click();
  await expect(caption(page)).toHaveText("Your choice that day");
  await expectSynced(page);
  expect(await serverDay(page, "2026-10-23")).toMatchObject({ zone2Done: true, zone2Machine: "ski" });
  await chip(page, "Bike").click();
  await expectSynced(page);
  expect(await serverDay(page, "2026-10-23")).toMatchObject({ zone2Machine: "bike" });

  // The check-in (Oct 21–27) names what Zone 2 was done on in the shared text: each once (a day each: the most
  // recent first), then Monday's reading.
  await page.goto("/");
  await page.getByRole("link", { name: "Progress" }).click();
  await page.getByRole("button", { name: "Share check-in" }).click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __shared?: string }).__shared))
    .toMatch(/ · Zone 2 3\/\d \(Assault bike, Rowing, Cycling · 320 kcal on the machine\)\n/);
});
