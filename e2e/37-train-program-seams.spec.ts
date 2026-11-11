/**
 * The seams between Train and Program. Train's header always links to Program — also before the
 * first cycle starts (the plan pushed back in week 1), when it says when the program starts and
 * never asks for a max the lift already has — Program's back control returns to the day it was
 * opened from, and a locked lift's "weekly layout" link in the Edit exercise sheet lands on that
 * section with the sheet closed. Monday of week 1 (bench press 225; the other lifts have no max).
 */
import { expect, expectSynced, MONDAY, onboardedOn, serverData, test } from "./helpers";

const TUESDAY_ISO = "2026-10-27";

test.beforeEach(async ({ page }) => {
  await onboardedOn(page, MONDAY);
  await page.getByRole("link", { name: "Train" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Push/);
});

test("pushed back a week in week 1: Train keeps its Program link and says when the program starts — no max prompt", async ({ page }) => {
  await expect(page.getByRole("button", { name: /^Bench press set \d+:/ })).toHaveCount(4);
  await page.getByRole("link", { name: "Program: Week 1 of 5" }).tap();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Program");
  await page.getByRole("button", { name: "Delay a week" }).tap();
  await expect.poll(async () => (await serverData(page)).settings.program.cycleStartDate).toBe("2026-11-02");
  await expectSynced(page);

  // Back to Train: the bench sets are gone (nothing is calculated before the start), the way to Program isn't.
  await page.getByRole("link", { name: /Back/ }).tap();
  await expect(page).toHaveURL(/\/train$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Push/);
  await expect(page.getByRole("button", { name: /^Bench press set \d+:/ })).toHaveCount(0);
  const link = page.getByRole("link", { name: "Program: starts Mon Nov 2" });
  await expect(link).toBeVisible();
  await expect(link).toHaveText("Starts Mon Nov 2", { useInnerText: true });
  const mainLift = page.locator("section").filter({ has: page.getByRole("heading", { level: 2, name: "Main lift" }) });
  await expect(mainLift).toContainText("Your program starts Monday, Nov 2.");
  // The bench press has its max: nothing asks for one.
  await expect(page.getByText(/Set a max/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Set max/ })).toHaveCount(0);

  // A lift without a max, before the start: still "starts", not a max prompt.
  await page.goto(`/train/${TUESDAY_ISO}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Pull/);
  await expect(page.getByRole("link", { name: "Program: starts Mon Nov 2" })).toBeVisible();
  await expect(mainLift).toContainText("Your program starts Monday, Nov 2.");
  await expect(page.getByText(/Set a max/)).toHaveCount(0);

  // The notice's own link goes to Program, and Back returns to the day it came from.
  await mainLift.getByRole("link", { name: /Open the program/ }).tap();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Program");
  await page.getByRole("link", { name: /Back/ }).tap();
  await expect(page).toHaveURL(new RegExp(`/train/${TUESDAY_ISO}$`));

  // At 320 px the link keeps its place beside the dates, in its short form.
  await page.setViewportSize({ width: 320, height: 568 });
  const narrow = page.getByRole("link", { name: "Program: starts Mon Nov 2" });
  await expect(narrow).toHaveText("Starts Mon", { useInnerText: true });
  const a = (await narrow.boundingBox())!;
  const b = (await page.getByRole("button", { name: "Next day" }).boundingBox())!;
  expect(Math.abs(a.y - b.y), "the link is on the dates' row").toBeLessThan(2);
});

test("once the cycle runs, a lift without a max asks for it — by the program day's lift", async ({ page }) => {
  // Tuesday of week 1: Pull, deadlift — which has no max yet.
  await page.clock.setSystemTime(new Date(2026, 9, 27, 10, 0, 0));
  await page.goto("/train");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Pull/);
  await expect(page.getByRole("link", { name: "Program: Week 1 of 5" })).toBeVisible();
  const mainLift = page.locator("section").filter({ has: page.getByRole("heading", { level: 2, name: "Main lift" }) });
  await expect(mainLift).toContainText("Set a max for Deadlift and the working sets calculate themselves.");
  await expect(page.getByText(/Your program start/)).toHaveCount(0);
  await mainLift.getByRole("button", { name: /Set max/ }).tap();
  await expect(page.getByRole("dialog", { name: "Deadlift" })).toBeVisible();
});

test("Program opened from a past day returns to that day", async ({ page }) => {
  await page.goto("/train/2026-10-25");
  await expect(page.getByRole("link", { name: /^Program: / })).toBeVisible();
  await page.getByRole("link", { name: /^Program: / }).tap();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Program");
  await page.getByRole("link", { name: /Back/ }).tap();
  await expect(page).toHaveURL(/\/train\/2026-10-25$/);
});

test("Edit exercise → weekly layout: lands on Program's section with the sheet closed, and Back returns to Train", async ({ page }) => {
  // Deadlift is Tuesday's main lift; done as an accessory today, its options still offer Edit exercise — locked.
  await page.getByRole("button", { name: "Exercise", exact: true }).tap();
  const add = page.getByRole("dialog", { name: "Add exercise" });
  await add.getByRole("textbox", { name: "Search or create exercise" }).fill("Deadlift");
  await add.getByRole("button", { name: /^Deadlift/ }).tap();
  await expect(add).toHaveCount(0);

  await page.getByRole("button", { name: "Deadlift options" }).tap();
  await page
    .getByRole("dialog", { name: "Deadlift" })
    .getByRole("button", { name: /^Edit exercise/ })
    .tap();
  const sheet = page.getByRole("dialog", { name: "Edit Deadlift" });
  await expect(sheet.getByRole("textbox", { name: "Name" })).toHaveValue("Deadlift");
  await sheet.getByRole("link", { name: "weekly layout" }).tap();

  await expect(page).toHaveURL(/\/program#layout$/);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const heading = page.getByRole("heading", { level: 2, name: "Weekly layout" });
  await expect(heading).toBeInViewport();
  await expect(heading).toBeFocused();
  // Nothing was saved by leaving.
  expect((await serverData(page)).exercises.find((e) => e.name === "Deadlift")).toMatchObject({ archived: false, category: "primary" });

  await page.getByRole("link", { name: /Back/ }).tap();
  await expect(page).toHaveURL(/\/train$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Push/);
});
