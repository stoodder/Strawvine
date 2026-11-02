/**
 * Today's fuel bars shade from lime through caution yellow to warn red the further a macro (or
 * the day's calories) runs over its target (SPEC §3.1), and say so in words, in the bar's colour.
 * Just past the tolerance the colour is already visibly off lime.
 */
import type { Locator, Page } from "@playwright/test";
import { dismissCelebrations, expect, fillNumber, login, startClockAt, test } from "./helpers";

const FRIDAY = new Date(2026, 9, 30, 10, 0, 0);

const macro = (page: Page, label: string) =>
  page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Fuel" }) })
    .locator("div.min-w-0")
    .filter({ has: page.locator(".label", { hasText: new RegExp(`^${label}$`) }) });

const fill = (m: Locator) => m.locator("[data-severity]");
const fuel = (page: Page) => page.locator("section").filter({ has: page.getByRole("heading", { name: "Fuel" }) });

/** The OKLCH hue of a computed colour: Chromium serialises a color-mix in oklch as oklch(L C H). */
const hueOf = (color: string) => {
  const m = color.match(/^oklch\(([\d.]+) ([\d.]+) ([\d.]+)/);
  return m ? Number(m[3]) : null;
};

/** A token's computed colour (to compare with what the bar paints). */
const tokenColor = (page: Page, token: string) =>
  page.evaluate((t) => {
    const el = document.createElement("div");
    el.style.backgroundColor = `var(${t})`;
    document.body.append(el);
    const c = getComputedStyle(el).backgroundColor;
    el.remove();
    return c;
  }, token);

test("a macro over target turns yellow, then red, and says how far over", async ({ page }) => {
  await startClockAt(page, FRIDAY);
  await dismissCelebrations(page);
  await login(page);

  // A weigh-in gives the day its targets.
  await page.getByRole("button", { name: /Weigh-in/ }).click();
  await fillNumber(page, "Morning weight", "200");
  await page.getByRole("button", { name: /Nutrition/ }).click();

  const carbs = macro(page, "Carbs");
  const target = Number(((await carbs.textContent()) ?? "").match(/\/ ([\d,]+)g/)![1]!.replace(/,/g, ""));
  expect(target).toBeGreaterThan(0);
  const bg = () => fill(carbs).evaluate((el) => getComputedStyle(el).backgroundColor);
  const [accent, warn] = [await tokenColor(page, "--color-accent"), await tokenColor(page, "--color-warn")];

  // On target (and within 5 % over): lime, no note.
  await fillNumber(page, "Carbs", String(target));
  await expect(fill(carbs)).toHaveAttribute("data-severity", "0");
  await expect.poll(bg).toBe(accent);
  await expect(carbs.getByText(/g over$/)).toHaveCount(0);
  await fillNumber(page, "Carbs", String(Math.floor(target * 1.03)));
  await expect(fill(carbs)).toHaveAttribute("data-severity", "0");
  await expect.poll(bg).toBe(accent);

  // 6 % over: just past the tolerance — no longer lime (lime's hue is ≈129°; this is ≤ 120°).
  await fillNumber(page, "Carbs", String(Math.ceil(target * 1.06)));
  await expect(fill(carbs)).not.toHaveAttribute("data-severity", "0");
  await expect.poll(async () => hueOf(await bg())).toBeLessThan(120);
  await expect.poll(async () => hueOf(await bg())).toBeGreaterThan(105);
  const note = carbs.getByText(/^\+\d+g over$/);
  await expect(note).toBeVisible();
  // The note is in the bar's colour.
  // (Polled together: the bar eases between colours, the note switches at once.)
  await expect.poll(async () => (await note.evaluate((el) => getComputedStyle(el).color)) === (await bg())).toBe(true);

  // 15 % over: halfway — caution yellow, neither lime nor red.
  await fillNumber(page, "Carbs", String(Math.round(target * 1.15)));
  await expect(fill(carbs)).toHaveAttribute("data-severity", /^0\.(4[5-9]|5|5[0-5])$/);
  await expect.poll(async () => [accent, warn].includes(await bg())).toBe(false);
  await expect(carbs.getByText(/^\+\d+g over$/)).toBeVisible();

  // 30 % over: warn red.
  await fillNumber(page, "Carbs", String(Math.round(target * 1.3)));
  await expect(fill(carbs)).toHaveAttribute("data-severity", "1");
  await expect.poll(bg).toBe(warn);
  await expect(carbs.getByText(`+${Math.round(target * 1.3) - target}g over`)).toBeVisible();

  // The calorie bar (the first in Fuel) follows the same scale: 15 % over is halfway, 30 % red.
  const section = fuel(page);
  const kcalTarget = Number(
    (
      (await section
        .locator(".label", { hasText: /^Target$/ })
        .locator("xpath=following-sibling::div[1]")
        .textContent()) ?? ""
    )
      .match(/[\d,]+/)![0]!
      .replace(/,/g, ""),
  );
  expect(kcalTarget).toBeGreaterThan(1000);
  const kcalBar = section.locator("[data-severity]").first();
  const kcalBg = () => kcalBar.evaluate((el) => getComputedStyle(el).backgroundColor);
  const kcalNote = section.getByText("kcal over").locator("xpath=..");
  await fillNumber(page, "Calories", String(Math.round(kcalTarget * 1.15)));
  await expect(kcalBar).toHaveAttribute("data-severity", /^0\.(4[5-9]|5|5[0-5])$/);
  await expect.poll(async () => [accent, warn].includes(await kcalBg())).toBe(false);
  await expect(kcalNote).toHaveText(`+${(Math.round(kcalTarget * 1.15) - kcalTarget).toLocaleString("en-US")} kcal over`);
  await expect.poll(async () => (await kcalNote.evaluate((el) => getComputedStyle(el).color)) === (await kcalBg())).toBe(true);
  await fillNumber(page, "Calories", String(Math.round(kcalTarget * 1.3)));
  await expect(kcalBar).toHaveAttribute("data-severity", "1");
  await expect.poll(kcalBg).toBe(warn);
  await expect.poll(async () => kcalNote.evaluate((el) => getComputedStyle(el).color)).toBe(warn);
  await fillNumber(page, "Calories", String(kcalTarget));
  await expect(kcalBar).toHaveAttribute("data-severity", "0");
  await expect(section.getByText("kcal over")).toHaveCount(0);

  // Protein is lenient: 20 % over is still on target.
  const protein = macro(page, "Protein");
  const pTarget = Number(((await protein.textContent()) ?? "").match(/\/ ([\d,]+)g/)![1]!.replace(/,/g, ""));
  await fillNumber(page, "Protein", String(Math.round(pTarget * 1.2)));
  await expect(fill(protein)).toHaveAttribute("data-severity", "0");
});
