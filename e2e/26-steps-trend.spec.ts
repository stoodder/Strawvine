/**
 * Progress charts daily steps with a weighted 7-day trend (SPEC §3.2): empty until a couple of
 * days have a count; then each day is a dot, the trend reads the weighted average through
 * yesterday, today's count is a hollow "so far" point kept off the scale, and the step target is
 * a reference line named in the legend. The section names the range it follows.
 */
import type { Page } from "@playwright/test";
import { dismissCelebrations, expect, expectSynced, fillNumber, login, startClockAt, test } from "./helpers";

/** Friday of the suite's first week; the template onboarded on the Sunday before. */
const FRIDAY = new Date(2026, 9, 30, 10, 0, 0);

async function logSteps(page: Page, path: string, steps: number) {
  await page.goto(path);
  const row = page.getByRole("button", { name: /^Steps/ });
  await row.click();
  await fillNumber(page, "Steps", String(steps));
  await row.click(); // close the editor
}

const stepsSection = (page: Page) => page.locator("section").filter({ has: page.getByRole("heading", { name: "Steps", exact: true }) });

test("logging steps over several days draws the steps trend", async ({ page }) => {
  await startClockAt(page, FRIDAY);
  await dismissCelebrations(page);
  await login(page);

  await page.getByRole("link", { name: "Progress" }).click();
  await expect(stepsSection(page).getByText("Log steps a few days to see your trend.")).toBeVisible();

  // Mon–Thu, then a partial count today.
  const counts: Array<[string, number]> = [
    ["2026-10-26", 10000],
    ["2026-10-27", 12000],
    ["2026-10-28", 14000],
    ["2026-10-29", 16000],
  ];
  for (const [date, steps] of counts) await logSteps(page, `/day/${date}`, steps);
  await logSteps(page, "/", 4000);
  await expectSynced(page);

  await page.getByRole("link", { name: "Progress" }).click();
  const section = stepsSection(page);
  const chart = section.getByRole("img");
  await expect(chart).toBeVisible();
  // Thu·5 + Wed·5 + Tue·5 + Mon·4 over 19 (the window's other days have no count) = 13,158.
  await expect(chart).toHaveAttribute(
    "aria-label",
    /^Steps, .*Steps 10,000 to 16,000\. Steps so far on Oct 30: 4,000\. Trend 10,000 to 13,158\. Target 15,000\./,
  );
  // The readout: today's count so far, and the trend as of yesterday.
  await expect(section.getByText("Trend", { exact: true }).locator("xpath=following-sibling::span[1]")).toHaveText("13,158");
  const stepsReadout = section.locator("[aria-live=polite]").getByText("Steps", { exact: true }).locator("xpath=..");
  await expect(stepsReadout).toHaveText("Steps4,000so far");
  // The target is named in the legend row, not on the line over the data.
  await expect(section.getByText("Target", { exact: true }).locator("xpath=following-sibling::span[1]")).toHaveText("15,000");
  // Today is hollow, and its partial 4,000 isn't the scale's low.
  await expect(chart.locator("circle[data-partial]")).toHaveCount(1);
  await expect(chart.locator("span.font-mono")).toHaveText(["16,000", "10,000"]);

  // The accessible table lists each day with its count and trend; today's count says "so far".
  await section.getByRole("button", { name: "Table" }).click();
  const table = section.getByRole("table");
  await expect(table.getByRole("row", { name: /^Oct 29/ })).toContainText("16,000");
  await expect(table.getByRole("row", { name: /^Oct 29/ })).toContainText("13,158");
  await expect(table.getByRole("row", { name: /^Oct 30/ })).toContainText("4,000 so far");

  // The range toggle (on Bodyweight) applies to it too, and the section says which range it shows.
  await expect(section.getByText("Last 30 days")).toBeVisible();
  await page.getByRole("button", { name: "90 days" }).click();
  await expect(section.getByText("Last 90 days")).toBeVisible();
  await expect(chart).toHaveAttribute("aria-label", /Trend 10,000 to 13,158\./);
  await page.getByRole("button", { name: "All time" }).click();
  await expect(section.getByText("All time")).toBeVisible();
});
