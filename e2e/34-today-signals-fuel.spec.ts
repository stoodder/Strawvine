/**
 * Today leads with what to act on: the app's Signals sit right under the header (the most
 * important one, the rest behind "+N more"), and Fuel says what is left of today's calories — the
 * overage once past the tolerance — while a past day keeps what was eaten (SPEC §3.1, §7).
 */
import type { Page } from "@playwright/test";
import { expect, expectSynced, fillNumber, MONDAY, onboardedOn, pageOverflow, seedHistory, serverData, SUNDAY, test } from "./helpers";

const fuel = (page: Page) => page.locator("section").filter({ has: page.getByRole("heading", { name: "Fuel", exact: true }) });
const num = (text: string | null) => Number((text ?? "").replace(/[^\d.-]/g, ""));
const top = async (page: Page, selector: string) => (await page.locator(selector).first().boundingBox())!.y;

test("Signals sit under the header: the most important first, the rest open in place", async ({ page }) => {
  await onboardedOn(page, MONDAY);
  await seedHistory(page);
  await page.goto("/");

  const signals = page.locator("section[data-signals]");
  await expect(signals.getByRole("heading", { name: "Signals" })).toHaveCount(1);
  // Above Fuel, the checklist and the Journal; below the title.
  const order = await page.evaluate(() => [...document.querySelectorAll("#root h1, #root h2")].map((h) => h.textContent));
  expect(order).toEqual(["Today", "Signals", "Fuel", "Close the day", "Journal"]);
  expect(await top(page, "section[data-signals]")).toBeGreaterThan(await top(page, "h1"));
  expect(await top(page, "section[data-signals]")).toBeLessThan((await fuel(page).boundingBox())!.y);

  // Collapsed: one signal, and a quiet toggle saying how many more.
  const rows = signals.getByRole("listitem");
  await expect(rows).toHaveCount(1);
  const toggle = signals.locator("button[aria-controls]");
  await expect(toggle).toHaveAccessibleName(/^\+\d+ more signals?$/);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  const more = num(await toggle.textContent());
  expect(more).toBeGreaterThan(0);
  expect((await toggle.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  const first = await rows.first().textContent();

  // Expanded in place: all of them, warnings before notes before good news; the first stays first.
  await toggle.click();
  await expect(rows).toHaveCount(more + 1);
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(toggle).toHaveText("Show less");
  await expect(rows.first()).toHaveText(first!);
  const rank = { warn: 0, info: 1, good: 2 } as Record<string, number>;
  const tones = await rows.evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.tone!));
  expect(tones.map((t) => rank[t])).toEqual([...tones.map((t) => rank[t]!)].sort((a, b) => a - b));
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 700 });
    expect(await pageOverflow(page), `${width}px, signals open`).toBeNull();
  }
  await toggle.click();
  await expect(rows).toHaveCount(1);

  // A past day has no signals (they are about now), and no empty section in their place.
  await page.goto("/day/2026-10-24");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Saturday");
  await expect(page.locator("[data-signals]")).toHaveCount(0);
});

test("no signals yet: nothing is rendered in their place", async ({ page }) => {
  await onboardedOn(page);
  await expect(page.getByRole("heading", { name: "Fuel", exact: true })).toBeVisible();
  await expect(page.locator("[data-signals]")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Signals" })).toHaveCount(0);
});

test("Fuel counts down what is left as calories are logged; over target it says by how much; a past day says eaten", async ({ page }) => {
  await onboardedOn(page);
  // A weigh-in gives the day its targets.
  await page.getByRole("button", { name: /^Morning check-in/ }).click();
  await fillNumber(page, "Morning weight", "200");
  const section = fuel(page);
  const side = section.locator("[data-fuel-side]");
  const eaten = section.locator("[data-fuel-eaten]");
  const target = num(
    await section
      .locator(".label", { hasText: /^Target$/ })
      .locator("xpath=following-sibling::div[1]")
      .evaluate((el) => el.firstChild!.textContent),
  );
  expect(target).toBeGreaterThan(1000);
  const kcal = (n: number) => n.toLocaleString("en-US");

  // Nothing logged: the whole target is left.
  await expect(side).toHaveAttribute("data-fuel-side", "left");
  await expect(side).toHaveText(`${kcal(target)} kcalleft`);
  await expect(eaten).toHaveText("Nothing logged yet");

  // Log some: left goes down by exactly that, and what was eaten sits under the bar.
  await page.getByRole("button", { name: /^Nutrition/ }).click();
  await fillNumber(page, "Calories", "1000");
  await expect(side).toHaveText(`${kcal(target - 1000)} kcalleft`);
  await expect(eaten).toHaveText("1,000 eaten");
  await fillNumber(page, "Calories", "1480");
  await expect(side).toHaveText(`${kcal(target - 1480)} kcalleft`);
  await expect(eaten).toHaveText("1,480 eaten");

  // Well over: the overage, labelled "over", said once (no second note under the bar).
  const over = Math.round(target * 1.3);
  await fillNumber(page, "Calories", String(over));
  await expect(side).toHaveAttribute("data-fuel-side", "over");
  await expect(side).toHaveText(`+${kcal(over - target)} kcalover`);
  await expect(eaten).toHaveText(`${kcal(over)} eaten`);
  await expect(section.getByText("kcal over")).toHaveCount(0);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 700 });
    expect(await pageOverflow(page), `${width}px, over target`).toBeNull();
  }
  await page.getByRole("button", { name: /^Nutrition/ }).click();
  await expectSynced(page);
  const iso = `${SUNDAY.getFullYear()}-${String(SUNDAY.getMonth() + 1).padStart(2, "0")}-${String(SUNDAY.getDate()).padStart(2, "0")}`;
  expect((await serverData(page)).days.find((d) => d.date === iso)?.calories).toBe(over);

  // The next day, looking back: what was eaten, with the over note under the bar.
  await page.clock.setSystemTime(MONDAY);
  await page.goto(`/day/${iso}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sunday");
  await expect(side).toHaveAttribute("data-fuel-side", "eaten");
  await expect(side).toHaveText(`${kcal(over)}eaten`);
  await expect(eaten).toHaveCount(0);
  await expect(section.getByText("kcal over")).toHaveCount(1);
});
