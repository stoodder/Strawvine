/**
 * The first day: sign in → onboarding → Today. Logging weight, sleep, nutrition and steps closes
 * the (Sunday) day, which is celebrated.
 */
import { dismissCelebrations, expect, fillNumber, PASSWORD, startClockAt, SUNDAY, test } from "./helpers";

// Onboarding itself: start from an empty database rather than the onboarded template.
test.use({ emptyDatabase: true });

test("sign in, onboard and close the first day", async ({ page }) => {
  await startClockAt(page, SUNDAY);
  const celebrated = await dismissCelebrations(page);

  // Wrong password first: the message is announced and nothing else happens.
  await page.goto("/");
  await page.getByLabel("Password").fill("not-it");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).not.toBeEmpty();
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();

  // Onboarding
  await expect(page.getByRole("heading", { name: "Let's calibrate." })).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByRole("heading", { name: "Where are you starting?" })).toBeVisible();
  await fillNumber(page, "Bench press", "225");
  await fillNumber(page, "Back squat", "315");
  await fillNumber(page, "Deadlift", "405");
  await fillNumber(page, "Strict press", "135");
  await expect(page.getByText(/Week 1 bench:/)).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByRole("heading", { name: "Bodyweight & goal" })).toBeVisible();
  await fillNumber(page, "Today's weight", "200");
  await fillNumber(page, "Goal weight", "190");
  await expect(page.getByRole("slider", { name: /Pace/ })).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByRole("heading", { name: "Week 1 begins…" })).toBeVisible();
  const monday = page.getByRole("button", { name: /Monday/ }).first();
  await expect(monday).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Begin" }).click();

  // Today
  const nav = page.getByRole("navigation", { name: "Primary" });
  await expect(nav).toBeVisible();
  await expect(page.getByRole("link", { name: "Today" })).toHaveAttribute("aria-current", "page");

  // The weight was logged during onboarding; add sleep.
  await page.getByRole("button", { name: /Morning check-in/ }).click();
  const weight = page.getByRole("textbox", { name: "Morning weight" });
  await expect(weight).toHaveValue(/200/);
  const sleep = page.getByRole("textbox", { name: "Sleep duration, hours and minutes" });
  await sleep.fill("7:30");
  await sleep.press("Enter");
  await expect(page.getByText("7h 30m").or(page.getByText("7:30")).first()).toBeVisible();

  // Nutrition
  await page.getByRole("button", { name: /Nutrition/ }).click();
  await fillNumber(page, "Calories", "2300");
  await fillNumber(page, "Protein", "200");
  await fillNumber(page, "Carbs", "230");
  await fillNumber(page, "Fat", "70");

  // Steps closes the day → "Day closed" celebration.
  await page.getByRole("button", { name: /^Steps/ }).click();
  await fillNumber(page, "Steps", "16000");
  // Close the open editor (celebrations wait while an editor is open).
  await page.getByRole("button", { name: /^Steps/ }).click();

  // "First entry" (weight + calories) and "Day closed" are celebrated; each is dismissed with Continue.
  const heading = page.getByRole("heading", { name: "Today", level: 1 });
  // A trial click is an action, so it gives the Continue handler a chance to run.
  await expect.poll(async () => (await heading.click({ trial: true }), celebrated), { timeout: 20_000 }).toContain("Day closed");
  expect(celebrated).toContain("First entry");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText("Day closed. Nicely done.")).toBeVisible();

  // Everything survives a reload (it reached the server).
  await page.reload();
  await page.getByRole("button", { name: /Morning check-in/ }).click();
  await expect(page.getByRole("textbox", { name: "Morning weight" })).toHaveValue(/200/);
});
