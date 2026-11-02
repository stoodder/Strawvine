/**
 * Loads and progression hints of weighted and unweighted accessories: a weighted hold done at its
 * full duration with a load suggests a heavier one next week; a tap never logs a weighted set
 * without a load (the editor opens); an exercise made unweighted logs no load and gets no hint,
 * even though its older sets have one.
 */
import type { Page } from "@playwright/test";
import { expect, expectSynced, MONDAY, MONDAY_ISO, onboardedOn, serverData, test } from "./helpers";

/** The Monday after the suite's first one: week 2, Push again. */
const NEXT_MONDAY = new Date(2026, 10, 2, 10, 0, 0);

test.beforeEach(async ({ page }) => {
  await onboardedOn(page, MONDAY);
  await page.getByRole("link", { name: "Train" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Push/);
});

async function create(page: Page, name: string, measure: string) {
  await page.getByRole("button", { name: "Exercise", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Add exercise" });
  await sheet.getByRole("textbox", { name: "Search or create exercise" }).fill(name);
  await sheet.getByRole("button", { name: measure, exact: true }).click();
  await expect(sheet.getByRole("switch", { name: "Weighted" })).toHaveAttribute("aria-checked", "true");
  await sheet.getByRole("button", { name: /Create & add/ }).click();
  await expect(sheet).toHaveCount(0);
}

const chip = (page: Page, name: string, n: number) => page.getByRole("button", { name: new RegExp(`^${name} set ${n}:`) });

/** Tap a weighted set that has no load yet: the editor opens instead of logging; log it at `lb`. */
async function logFirstWithLoad(page: Page, name: string, lb: number) {
  const first = chip(page, name, 1);
  await expect(first).toHaveAccessibleName(/\(no load\)$/);
  await first.click();
  const editor = page.getByRole("dialog", { name: `${name} · set 1` });
  await expect(editor).toBeVisible();
  await expect(first).toHaveAttribute("aria-pressed", "false"); // the tap logged nothing
  for (let i = 0; i < lb / 5; i++) await editor.getByRole("button", { name: "Increase load" }).click();
  await editor.getByRole("button", { name: "Log set" }).click();
  await expect(editor).toHaveCount(0);
  await expect(first).toHaveAttribute("aria-pressed", "true");
}

async function nextMonday(page: Page) {
  await expectSynced(page);
  await page.clock.setSystemTime(NEXT_MONDAY);
  await page.goto("/train");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Push/);
}

test("a weighted hold at full duration suggests a heavier load next week", async ({ page }) => {
  await create(page, "Weighted dead hang", "Time");
  await logFirstWithLoad(page, "Weighted dead hang", 25);
  // The load carried to the open sets: one tap each logs them at 30 s with 25 lb.
  for (const n of [2, 3]) {
    await expect(chip(page, "Weighted dead hang", n)).toHaveAccessibleName(/30\s?s\s+at\s+25\s+lb$/);
    await chip(page, "Weighted dead hang", n).click();
    await expect(chip(page, "Weighted dead hang", n)).toHaveAttribute("aria-pressed", "true");
  }

  await nextMonday(page);
  const hint = page.getByTitle("Full duration at 25 lb on Oct 26 → +5 lb");
  await expect(hint).toBeVisible();
  await expect(hint).toContainText("full duration");
  await expect(hint).not.toContainText("full time");
  const apply = page.getByRole("button", { name: "Apply 30 lb to the open Weighted dead hang sets" });
  await apply.click();
  for (const n of [1, 2, 3]) await expect(chip(page, "Weighted dead hang", n)).toHaveAccessibleName(/30\s?s\s+at\s+30\s+lb$/);
});

test("an exercise made unweighted logs no load and gets no hint from its old loads", async ({ page }) => {
  await create(page, "Ring row", "Reps");
  await logFirstWithLoad(page, "Ring row", 25);
  await expect(chip(page, "Ring row", 2)).toHaveAccessibleName(/10\s?reps\s+at\s+25\s+lb$/); // pre-filled while weighted

  // Made unweighted while the session is in progress.
  await expectSynced(page);
  await page.goto("/settings");
  const toggle = page.getByRole("button", { name: "Ring row: track load" });
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await page.goto("/train");

  // One tap logs the next set without the load it was pre-filled with; the set logged before keeps its load.
  await chip(page, "Ring row", 2).click();
  await expect(chip(page, "Ring row", 2)).toHaveAttribute("aria-pressed", "true");
  await expectSynced(page);
  const ringRow = async () => {
    const { sessions, exercises } = await serverData(page);
    const id = exercises.find((e) => e.name === "Ring row")!.id;
    return sessions
      .find((s) => s.date === MONDAY_ISO)!
      .blocks.flatMap((b) => b.exercises)
      .find((e) => e.exerciseId === id)!.sets;
  };
  await expect.poll(async () => (await ringRow()).map((s) => [s.done, s.weight])).toEqual([
    [true, 25],
    [true, null],
    [false, null],
  ]);

  // Next week: pre-filled without a load, and no progression hint from the old 25 lb.
  await nextMonday(page);
  await expect(chip(page, "Ring row", 1)).toHaveAccessibleName(/^Ring row set 1: 10\s?reps$/);
  await expect(page.getByRole("button", { name: /^Apply .* Ring row sets$/ })).toHaveCount(0);
  await expect(page.getByTitle(/on Oct 26/)).toHaveCount(0);
  await expect(page.getByText(/on Oct 26 · hold/)).toHaveCount(0);
});
