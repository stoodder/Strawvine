/**
 * Celebrations wait for a calm moment: a benchmark PR earned in the Metcon editor isn't shown
 * while the editor is open (even with nothing focused), and appears once it is collapsed.
 */
import { expect, login, MONDAY, startClockAt, SUNDAY, test } from "./helpers";

test("a benchmark PR celebration waits until the Metcon editor is collapsed", async ({ page }) => {
  // No automatic dismissing here: the test watches for the overlay itself.
  await startClockAt(page, SUNDAY);
  await login(page);

  // A previous Fran a week ago (filed away quietly: older than the celebration window).
  const res = await page.request.put("/api/days/2026-10-19", {
    data: { metconDone: true, metconBenchmark: "Fran", metconScore: "5:00" },
  });
  expect(res.ok()).toBe(true);
  await page.clock.setSystemTime(MONDAY);
  await page.goto("/");

  const overlay = page.getByRole("dialog").filter({ has: page.getByRole("button", { name: /^Continue/ }) });
  const metcon = page.getByRole("button", { name: /^Metcon(?! complete)/ });
  await metcon.click();
  await expect(metcon).toHaveAttribute("aria-expanded", "true");

  // A combobox (it suggests earlier benchmark names).
  const name = page.getByLabel("Benchmark name", { exact: true });
  await name.fill("Fran");
  await name.press("Enter");
  const score = page.getByRole("textbox", { name: "Benchmark score" });
  await score.fill("4:30");
  await score.press("Enter");
  // "Prev. best 5:00" once the new score beats it.
  await expect(page.getByText(/best\s*5:00/i)).toBeVisible();

  // Nothing focused, editor still open: several calm checks go by without an overlay.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.waitForTimeout(3_000);
  await expect(overlay).toHaveCount(0);

  await metcon.click();
  await expect(metcon).toHaveAttribute("aria-expanded", "false");
  await expect(overlay).toBeVisible({ timeout: 10_000 });
  await expect(overlay.getByRole("heading", { level: 2 })).toHaveText("Fran PR");
  await page.waitForTimeout(600); // the overlay ignores taps for its first instant
  await overlay.getByRole("button", { name: /^Continue/ }).click();
  await expect(overlay).toHaveCount(0);
});

