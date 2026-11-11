/**
 * No sideways scrolling with real data (e2e/13 checks the screens freshly onboarded): weeks of
 * history, accessories with long names — one with no break opportunity at all — in a superset,
 * four-digit loads and step counts, long benchmark names, notes with URLs. Train, its sheets,
 * Progress's maxes and the PR celebration (which names the lift or benchmark) are where long names
 * used to push the page — or a sheet's panel — wider than the phone. A narrow phone (320 px), a
 * common one (375 px) and a 390 px phone at 200% zoom (195 px). Measured with the html/body clip
 * lifted (`pageOverflow`), so the safety net in styles.css can't hide a regression.
 */
import type { Page } from "@playwright/test";
import {
  expect,
  login,
  MONDAY,
  MONDAY_ISO,
  onboardedOn,
  outsideViewport,
  pageOverflow,
  seedHistory,
  startClockAt,
  SUNDAY,
  test,
} from "./helpers";

const LONG = "Chest-supported incline dumbbell row with 3-second eccentric";
/** A name without a single break opportunity (pasted, or typed without spaces). */
const UNBREAKABLE = "KettlebellBottomsUpTurkishGetUpToWindmillComplex";
const URL = "https://example.com/workouts/a-really-long-url-without-any-spaces-in-it-at-all-0123456789";

/** Eight weeks of history, then the heavy bits on top (through the API, with this page's session). */
async function seedRealData(page: Page) {
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await page.request.fetch(path, { method, ...(body !== undefined ? { data: body } : {}) });
    if (!res.ok()) throw new Error(`${method} ${path} → ${res.status()} ${await res.text()}`);
    return res.status() === 204 ? null : res.json();
  };
  await seedHistory(page, { weeks: 8 });
  const long = await call("POST", "/api/exercises", { name: LONG, category: "accessory", measure: "reps", weighted: true });
  const blob = await call("POST", "/api/exercises", { name: UNBREAKABLE, category: "accessory", measure: "reps", weighted: true });
  const boot = await call("GET", "/api/bootstrap");
  const bench = boot.exercises.find((e: { name: string }) => e.name === "Bench press");
  const set = (id: string, reps: number, weight: number) => ({
    id,
    targetReps: reps,
    targetWeight: weight,
    reps,
    weight,
    done: true,
    amrap: false,
    appliedProgressionLb: null,
  });
  // Last Monday's session, carried into today's: the superset of long names comes back.
  await call("PUT", "/api/sessions/2026-10-19", {
    date: "2026-10-19",
    label: "Push",
    cycle: null,
    week: null,
    deload: false,
    primaryMaxLb: 225,
    blocks: [
      { id: "p", kind: "primary", exercises: [{ exerciseId: bench.id, measure: "reps", sets: [set("p1", 5, 185), set("p2", 5, 185)] }] },
      {
        id: "s",
        kind: "accessory",
        exercises: [
          { exerciseId: long.id, measure: "reps", sets: [set("s1", 12, 1000), set("s2", 1000, 1000)] },
          { exerciseId: blob.id, measure: "reps", sets: [set("s3", 5, 35), set("s4", 5, 35)] },
        ],
      },
    ],
    notes: `Shoulder a bit cranky. ${URL}`,
    completedAt: "2026-10-19T18:30:00.000Z",
    planSig: null,
  });
  // A max on the unbreakable lift: a PR whose achievement title is that name.
  await call("PATCH", `/api/exercises/${blob.id}`, { tracksMax: true });
  await call("POST", `/api/exercises/${blob.id}/maxes`, { date: "2026-10-20", valueLb: 1000, source: "manual", note: URL });
  // Today, with big numbers and a long benchmark name.
  await call("PUT", `/api/days/${MONDAY_ISO}`, {
    weightLb: 999.9,
    calories: 3250,
    proteinG: 1234,
    carbsG: 2345,
    fatG: 456,
    steps: 24876,
    metconDone: true,
    metconBenchmark: "Murph (with a 20 lb vest, partitioned 5-10-15)",
    metconScore: "55:10",
    metconNotes: `EMOM 24: burpees, KB swings, wall balls, 200 m row. ${URL}`,
    journal: `Long reflection. ${URL}`,
  });
  const { settings } = await call("GET", "/api/bootstrap");
  await call("PUT", "/api/settings", {
    ...settings,
    strengthTargets: [...settings.strengthTargets, { id: "t-blob", exerciseId: blob.id, targetLb: 1500, setOn: "2026-10-01" }],
  });
}

test("a PR celebration naming an unbreakable benchmark fits a 320 px phone", async ({ page }) => {
  // No automatic dismissing (unlike onboardedOn): the test measures the overlay itself.
  await page.setViewportSize({ width: 320, height: 640 });
  await startClockAt(page, SUNDAY);
  await login(page);
  const day = (date: string, score: string) =>
    page.request.put(`/api/days/${date}`, { data: { metconDone: true, metconBenchmark: UNBREAKABLE, metconScore: score } });
  // A week-old score (filed away quietly), then a better one today: a benchmark PR.
  expect((await day("2026-10-19", "5:00")).ok()).toBe(true);
  expect((await day(MONDAY_ISO, "4:30")).ok()).toBe(true);
  await page.clock.setSystemTime(MONDAY);
  await page.goto("/");
  const overlay = page.getByRole("dialog").filter({ has: page.getByRole("button", { name: /^Continue/ }) });
  await expect(overlay.getByRole("heading", { level: 2 })).toHaveText(`${UNBREAKABLE} PR`, { timeout: 15_000 });
  await page.waitForTimeout(800); // its entrance
  expect(await outsideViewport(overlay), "the celebration at 320 px").toEqual([]);
});

// 195 px: a 390 px phone at 200% zoom (WCAG reflow, as in e2e/13).
for (const width of [195, 320, 375]) {
  test.describe(`with weeks of data, nothing scrolls sideways at ${width} px`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width, height: width === 195 ? 422 : 740 });
      await onboardedOn(page, MONDAY);
      await seedRealData(page);
    });

    test("every screen, and Today's editors", async ({ page }) => {
      const progressViews = ["body", "fuel", "activity", "strength"].map((view) => `/progress?view=${view}`);
      for (const path of ["/", "/train", "/progress", ...progressViews, "/goals", "/settings", "/program", "/train/2026-10-19"]) {
        await page.goto(path);
        await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
        await page.waitForTimeout(500);
        expect(await pageOverflow(page), `${path} at ${width} px`).toBeNull();
      }
      await page.goto("/");
      for (const row of ["Nutrition", "Steps", "Metcon"]) {
        await page
          .locator("button[aria-controls]")
          .filter({ hasText: new RegExp(`^${row}`) })
          .first()
          .click();
        await page.waitForTimeout(400);
        expect(await pageOverflow(page), `Today with ${row} open at ${width} px`).toBeNull();
      }
      // The swipe that used to pan the page: nothing moves sideways.
      await page.goto("/train");
      await expect(page.getByRole("button", { name: `${UNBREAKABLE} options` })).toBeVisible();
      await page.evaluate(() => window.scrollTo(200, window.scrollY));
      expect(await page.evaluate(() => window.scrollX), "Train pans sideways").toBe(0);
    });

    test("sheets with long names and four-digit numbers", async ({ page }) => {
      await page.goto("/train");
      for (const name of [LONG, UNBREAKABLE]) {
        await page.getByRole("button", { name: `${name} options` }).click();
        const sheet = page.getByRole("dialog", { name });
        await expect(sheet).toBeVisible();
        await page.waitForTimeout(400);
        expect(await outsideViewport(sheet), `${name} options at ${width} px`).toEqual([]);
        await page.keyboard.press("Escape");
        await expect(sheet).toHaveCount(0);
      }

      // The superset's own sheet: its members' names beside the move and remove buttons.
      await page.getByRole("button", { name: "Manage Superset A" }).click();
      const superset = page.getByRole("dialog", { name: "Superset A" });
      await expect(superset.getByRole("button", { name: `Remove ${UNBREAKABLE} from Superset A` })).toBeVisible();
      await page.waitForTimeout(400);
      expect(await outsideViewport(superset), `superset sheet at ${width} px`).toEqual([]);
      await page.keyboard.press("Escape");
      await expect(superset).toHaveCount(0);

      await page.getByRole("button", { name: "Exercise", exact: true }).click();
      const add = page.getByRole("dialog");
      const search = add.getByRole("textbox", { name: "Search or create exercise" });
      await expect(search).toBeVisible();
      await page.waitForTimeout(400);
      expect(await outsideViewport(add), `add exercise sheet at ${width} px`).toEqual([]);
      await search.fill(`${UNBREAKABLE}AndThenSomeMoreLetters`);
      await expect(add.getByRole("button", { name: /Create & add/ })).toBeVisible();
      expect(await outsideViewport(add), `add exercise sheet, creating a long name, at ${width} px`).toEqual([]);
      expect(await pageOverflow(page)).toBeNull();
      await page.keyboard.press("Escape");
      await expect(add).toHaveCount(0);

      // A 1,000 lb max beside its sparkline, and the max form.
      await page.goto("/progress?view=strength");
      await page.getByRole("button", { name: new RegExp(`^${UNBREAKABLE}`) }).click();
      const max = page.getByRole("dialog", { name: UNBREAKABLE });
      await expect(max.getByRole("textbox", { name: "New max" })).toBeVisible();
      await page.waitForTimeout(400);
      expect(await outsideViewport(max), `max sheet at ${width} px`).toEqual([]);
    });
  });
}
