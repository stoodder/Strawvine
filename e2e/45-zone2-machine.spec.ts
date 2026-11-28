/**
 * Zone 2 on any machine (SPEC §3.5): one line in Today's Zone 2 editor, under the minutes and the reading —
 * "Machine · Rowing ▾", a native select (Bike · Row · Elliptical · Ski · the owner's own names · Other…). The day
 * starts on the last machine used (derived, nothing stored for it); a machine chosen is written at once, even with
 * nothing else logged, and counts for nothing by itself; a first Zone 2 value saved without one (the dot, an older
 * build) gets the last one used, on the device and on the server. Named in the Zone 2 row ("Rowing · 320 kcal") and
 * the shared check-in. Fits a 320 px phone.
 */
import type { Locator, Page } from "@playwright/test";
import { expect, expectSynced, fillNumber, MONDAY, MONDAY_ISO, onboardedOn, pageOverflow, serverData, test } from "./helpers";

/** The Zone 2 row's text button (the dot beside it is "Zone 2 complete"). */
const zone2Row = (page: Page) => page.locator("button[aria-controls]").filter({ hasText: /^Zone 2/ });
const editor = (page: Page) => page.getByRole("group", { name: "Zone 2 details" });
const machine = (page: Page) => editor(page).getByRole("combobox", { name: "Machine" });
const nameField = (page: Page) => editor(page).getByRole("textbox", { name: "Machine name" });
const options = (page: Page) => machine(page).locator("option").allTextContents();
const dot = (page: Page) => page.getByRole("button", { name: "Zone 2 complete" });
const serverDay = async (page: Page, date: string) => (await serverData(page)).days.find((d) => d.date === date);
/** Days are put one at a time through the API, as a phone that logged them before. */
const put = async (page: Page, date: string, body: Record<string, unknown>) =>
  expect((await page.request.put(`/api/days/${date}`, { data: body })).ok(), date).toBe(true);

const TUESDAY = new Date(2026, 9, 27, 10, 0, 0);
const WEDNESDAY = new Date(2026, 9, 28, 10, 0, 0);

test("the machine is chosen on Today, written at once, remembered, filled in when not chosen, and named", async ({ page }) => {
  await page.addInitScript(() => {
    // The share sheet, as a phone has it: what is shared is kept for the test to read.
    Object.assign(navigator, {
      canShare: () => true,
      share: async (d: { text: string }) => void ((window as unknown as { __shared: string }).__shared = d.text),
    });
  });
  await onboardedOn(page, MONDAY);
  // A week of weights and calories so the check-in has something to show; Zone 2 on the elliptical last Wednesday,
  // then on Friday by an older build that sends no machine: the server gives it the last one used.
  for (let i = 7; i >= 1; i--) {
    const date = new Date(Date.UTC(2026, 9, 26 - i)).toISOString().slice(0, 10);
    const zone2 =
      date === "2026-10-21"
        ? { zone2Done: true, zone2Minutes: 30, zone2Machine: "elliptical" }
        : date === "2026-10-23"
          ? { zone2Done: true, zone2Minutes: 30 }
          : {};
    await put(page, date, { weightLb: 200, calories: 2400, ...zone2 });
  }
  expect(await serverDay(page, "2026-10-23")).toMatchObject({ zone2Done: true, zone2Machine: "elliptical" });
  await page.reload();
  await expect(zone2Row(page)).toContainText("Elliptical");

  // Monday: one line under the minutes and the reading, on the elliptical as last time.
  await zone2Row(page).click();
  expect(await options(page)).toEqual(["Bike", "Row", "Elliptical", "Ski", "Other…"]);
  await expect(machine(page)).toHaveValue("elliptical");
  // What the line says, as drawn beside the select.
  await expect(machine(page).locator("xpath=..").locator("span[aria-hidden]")).toHaveText(["Machine ·", "Elliptical"]);
  const minutesBox = (await editor(page).getByRole("textbox", { name: "Zone 2 minutes" }).boundingBox())!;
  const lineBox = (await machine(page).boundingBox())!;
  expect(lineBox.y, "the machine's line is under the minutes").toBeGreaterThan(minutesBox.y + minutesBox.height);
  expect(lineBox.height).toBeGreaterThanOrEqual(44);

  // Chosen with nothing else logged: written at once, and counted for nothing (the item isn't done).
  await machine(page).selectOption({ label: "Row" });
  await expect(zone2Row(page)).toContainText("Rowing");
  await expectSynced(page);
  expect(await serverDay(page, MONDAY_ISO)).toMatchObject({ zone2Machine: "row", zone2Done: false, zone2Minutes: null, zone2Kcal: null });
  await expect(dot(page)).toHaveAttribute("aria-pressed", "false");
  // The choice survives a reload.
  await page.reload();
  await expect(zone2Row(page)).toContainText("Rowing");
  await zone2Row(page).click();
  await expect(machine(page)).toHaveValue("row");

  // The day's values are values only: the day has its machine.
  await fillNumber(page, "Zone 2 minutes", "30");
  await fillNumber(page, "Zone 2 machine calories", "320");
  await expectSynced(page);
  expect(await serverDay(page, MONDAY_ISO)).toMatchObject({ zone2Done: true, zone2Minutes: 30, zone2Kcal: 320, zone2Machine: "row" });
  await expect(zone2Row(page)).toContainText("Rowing · 320 kcal");
  await expect(zone2Row(page)).toContainText("30 min");

  // Tuesday starts on the rower. Other…: a name field under the line; the line still says the rower until a name is given.
  await page.clock.setSystemTime(TUESDAY);
  await page.goto("/");
  await zone2Row(page).click();
  await expect(machine(page)).toHaveValue("row");
  await machine(page).selectOption({ label: "Other…" });
  await expect(nameField(page)).toBeFocused();
  await expect(machine(page)).toHaveValue("row");
  await page.keyboard.type("Assault bike");
  await page.keyboard.press("Enter");
  await expect(machine(page)).toHaveValue("Assault bike");
  await expect(zone2Row(page)).toContainText("Assault bike");
  // The editor closed, then the dot: the day is logged on the machine named.
  await zone2Row(page).click();
  await dot(page).click();
  await expectSynced(page);
  expect(await serverDay(page, "2026-10-27")).toMatchObject({ zone2Done: true, zone2Minutes: 30, zone2Machine: "Assault bike" });

  // Wednesday: the owner's own machine is offered, and the one to start on.
  await page.clock.setSystemTime(WEDNESDAY);
  await page.goto("/");
  await zone2Row(page).click();
  expect(await options(page)).toEqual(["Bike", "Row", "Elliptical", "Ski", "Assault bike", "Other…"]);
  await expect(machine(page)).toHaveValue("Assault bike");
  await expect(nameField(page)).toHaveCount(0);
  // Other… with no name given writes nothing.
  await machine(page).selectOption({ label: "Other…" });
  await nameField(page).press("Enter");
  await expectSynced(page);
  expect(await serverDay(page, "2026-10-28")).toBeUndefined();
  // A machine chosen takes the name field away, from under everything: nothing above it moves.
  // (Where they are in the page, once what was held while the name field had focus has caught up.)
  await page.waitForTimeout(800);
  const docTop = (l: Locator) => l.evaluate((el) => el.getBoundingClientRect().top + window.scrollY);
  const minutes = editor(page).getByRole("textbox", { name: "Zone 2 minutes" });
  const [minutesAt, lineAt] = [await docTop(minutes), await docTop(machine(page))];
  await machine(page).selectOption({ label: "Ski" });
  await expect(nameField(page)).toHaveCount(0);
  expect(await docTop(minutes)).toBeCloseTo(minutesAt, 0);
  expect(await docTop(machine(page))).toBeCloseTo(lineAt, 0);
  await expectSynced(page);
  expect(await serverDay(page, "2026-10-28")).toMatchObject({ zone2Machine: "ski", zone2Done: false });
  // Fits a 320 px phone, the line inside the gutters.
  await page.setViewportSize({ width: 320, height: 640 });
  expect(await pageOverflow(page)).toBeNull();
  const line = (await machine(page).boundingBox())!;
  expect(line.x + line.width).toBeLessThanOrEqual(320 - 16 + 0.5);
  await page.setViewportSize({ width: 390, height: 844 });

  // An older build logs Thursday without a machine: the server gives it the last one used — Tuesday's, Wednesday
  // having a machine chosen and no Zone 2.
  await put(page, "2026-10-29", { zone2Done: true, zone2Minutes: 25 });
  expect(await serverDay(page, "2026-10-29")).toMatchObject({ zone2Machine: "Assault bike" });

  // A past day: its own machine; another chosen there is written at once.
  await page.goto("/day/2026-10-23");
  await zone2Row(page).click();
  await expect(machine(page)).toHaveValue("elliptical");
  await machine(page).selectOption({ label: "Bike" });
  await expectSynced(page);
  expect(await serverDay(page, "2026-10-23")).toMatchObject({ zone2Done: true, zone2Machine: "bike" });

  // The check-in (Oct 21–27) names what Zone 2 was done on in the shared text: each once (a day each: the most recent
  // first), then Monday's reading, on the machines.
  await page.goto("/");
  await page.getByRole("link", { name: "Progress" }).click();
  await page.getByRole("button", { name: "Share check-in" }).click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __shared?: string }).__shared))
    .toMatch(/ · Zone 2 4\/5 \(Assault bike, Rowing, Cycling, Elliptical · 320 kcal on the machines\)\n/);
});
