/**
 * The end of a cycle (docs/SPEC.md §6.4, §6.6, §7): repeat it, or set up a new one.
 *
 * The template's program starts Mon Oct 26 (five-week cycles): cycle 1 runs to Sun Nov 29 — its
 * last week, the deload, is Nov 23–29 — and cycle 2 starts Mon Nov 30. Last cycle's Monday and
 * Tuesday (Nov 16, 17) were done with accessories: Push with dumbbell flyes, Pull with barbell rows.
 *
 * - In the last week Train shows a quiet note. Repeat acknowledges: the note goes, after a reload
 *   and on another device too.
 * - Set up a new cycle copies the plan from Mon Nov 30 and opens Program on it. Two days swapped
 *   (Pull on Monday, Push on Tuesday), a main lift changed (front squat on Wednesday), the steps
 *   target and the Zone 2 / metcon days changed: this week's Train and Today read as before. On Mon
 *   Nov 30 the new plan is in force — cycle 2, Pull on Monday pre-filled from last Tuesday's Pull —
 *   and last week's days still read as they did. Cancel and its Undo on the way.
 * - Opened on the new cycle's Monday with nothing saved in it, "Cycle 1 complete" offers the choice
 *   too, and the new cycle starts that Monday.
 */
import type { Browser, Page } from "@playwright/test";
import {
  dismissCelebrations,
  expect,
  expectSynced,
  fillNumber,
  keepAnimationsOnTheRealTimeline,
  onboardedOn,
  serverData,
  test,
  toastMessage,
} from "./helpers";

const at = (iso: string, hour = 10) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y!, m! - 1, d!, hour, 0, 0);
};
const LAST_WEEK_WED = at("2026-11-25");
const NEW_CYCLE_MON = at("2026-11-30");

async function api(page: Page, method: string, path: string, data?: unknown) {
  const res = await page.request.fetch(path, { method, headers: { "cache-control": "no-cache" }, ...(data !== undefined ? { data } : {}) });
  expect(res.ok(), `${method} ${path} → ${res.status()}`).toBe(true);
  return res.status() === 204 ? null : res.json();
}

/** Last cycle's week-4 Monday (Push) and Tuesday (Pull), done, each with one accessory. */
async function seedLastCycle(page: Page) {
  const fly = await api(page, "POST", "/api/exercises", { name: "Dumbbell fly", category: "accessory", measure: "reps", weighted: true });
  const row = await api(page, "POST", "/api/exercises", { name: "Barbell row", category: "accessory", measure: "reps", weighted: true });
  for (const [date, label, ex, lb] of [
    ["2026-11-16", "Push", fly.id, 30],
    ["2026-11-17", "Pull", row.id, 95],
  ] as const)
    await api(page, "PUT", `/api/sessions/${date}`, {
      date,
      label,
      cycle: 1,
      week: 4,
      deload: false,
      primaryMaxLb: null,
      blocks: [
        {
          id: `acc-${date}`,
          kind: "accessory",
          exercises: [
            {
              exerciseId: ex,
              measure: "reps",
              sets: [1, 2, 3].map((n) => ({
                id: `${date}-${n}`,
                targetReps: 10,
                targetWeight: lb,
                reps: 10,
                weight: lb,
                done: true,
                amrap: false,
                appliedProgressionLb: null,
              })),
            },
          ],
        },
      ],
      notes: "",
      completedAt: `${date}T18:00:00.000Z`,
      planSig: null,
    });
}

const note = (page: Page) => page.locator("[data-cycle-end]");
const programLink = (page: Page) => page.locator("[data-program-link]");
/** Today's (or a past day's) checklist, as it reads. */
const checklistText = (page: Page) =>
  page
    .locator("section")
    .filter({ has: page.getByRole("heading", { level: 2, name: /^(Close the day|The day)$/ }) })
    .innerText();
/** A day's Today page: the header line and the checklist. */
async function dayReading(page: Page, path: string) {
  await page.goto(path);
  await expect(page.getByRole("heading", { level: 2, name: /^(Close the day|The day)$/ })).toBeVisible();
  const header = await page.locator("header").first().innerText();
  return { header, checklist: await checklistText(page) };
}
/** Train on a day: title, the program link and the exercises shown. */
async function trainReading(page: Page, path: string) {
  await page.goto(path);
  await expect(page.locator("[data-train-title]")).toBeVisible();
  return {
    title: await page.locator("[data-train-title]").innerText(),
    link: await programLink(page).innerText(),
    exercises: (await page.locator("main").innerText()).match(/Dumbbell fly|Barbell row|Bench press|Deadlift|Back squat|Front squat/g) ?? [],
  };
}

async function secondDevice(page: Page, browser: Browser, time: Date, path: string) {
  const context = await browser.newContext({ baseURL: new URL(page.url()).origin, storageState: await page.context().storageState() });
  await keepAnimationsOnTheRealTimeline(context);
  const b = await context.newPage();
  await b.clock.install({ time });
  await b.clock.resume();
  await dismissCelebrations(b);
  await b.goto(path);
  await expect(b.getByRole("navigation", { name: "Primary" })).toBeVisible();
  return { b, close: () => context.close() };
}

test("in the last week: Repeat acknowledges, and the note stays gone — after a reload and on another device", async ({ page, browser }) => {
  await onboardedOn(page, LAST_WEEK_WED);
  await seedLastCycle(page);
  await page.goto("/train");
  await expect(note(page)).toContainText("Cycle 1 ends Sun Nov 29.");
  await expect(note(page)).toContainText("Next: Repeat cycle 1 · Set up a new cycle");
  // Program's Now has it too; Today doesn't.
  await page.goto("/program");
  await expect(note(page)).toContainText("Cycle 1 ends Sun Nov 29.");
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(note(page)).toHaveCount(0);

  await page.goto("/train");
  await page.getByRole("button", { name: "Repeat cycle 1" }).click();
  await expect(note(page)).toHaveCount(0);
  await expectSynced(page);
  expect((await serverData(page)).seenAchievements).toContain("repeat-cycle-1");
  // Nothing about the program changed: Repeat is what happens anyway.
  expect((await serverData(page)).settings.program).not.toHaveProperty("earlierPlans");
  await page.reload();
  await expect(page.locator("[data-train-title]")).toBeVisible();
  await expect(note(page)).toHaveCount(0);

  const other = await secondDevice(page, browser, LAST_WEEK_WED, "/train");
  await expect(other.b.locator("[data-train-title]")).toBeVisible();
  await expect(other.b.locator("[data-cycle-end]")).toHaveCount(0);
  await other.close();
});

test("set up a new cycle: the next plan changes nothing this week, then rules from its Monday; cancel and Undo", async ({ page }) => {
  await onboardedOn(page, LAST_WEEK_WED);
  await seedLastCycle(page);
  // How this week and last week's days read before anything is set up.
  const todayBefore = await dayReading(page, "/");
  const lastTuesday = await dayReading(page, "/day/2026-11-24");
  const lastFriday = await dayReading(page, "/day/2026-11-20");
  const trainBefore = await trainReading(page, "/train");

  await page.getByRole("button", { name: "Set up a new cycle" }).click();
  await expect(page).toHaveURL(/\/program#layout$/);
  await expect(toastMessage(page, "New cycle set up from Mon Nov 30")).toBeVisible();
  await expect(page.locator("[data-next-cycle]")).toContainText("Next cycle · from Mon Nov 30");
  const layout = page.locator("section#layout");
  await expect(layout.getByRole("group", { name: "Plan to edit" }).getByRole("button", { name: "Next cycle" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  // Swap Monday and Tuesday, and Wednesday's lift becomes the front squat.
  await page.getByRole("combobox", { name: "Mon main lift" }).selectOption({ label: "Deadlift" });
  const mon = page.getByRole("textbox", { name: "Mon session name" });
  await mon.fill("Pull");
  await mon.press("Enter");
  await page.getByRole("combobox", { name: "Tue main lift" }).selectOption({ label: "Bench press" });
  const tue = page.getByRole("textbox", { name: "Tue session name" });
  await tue.fill("Push");
  await tue.press("Enter");
  await page.getByRole("combobox", { name: "Wed main lift" }).selectOption({ label: "Front squat" });
  // The targets and training days of the next cycle: 9,000 steps, no Zone 2 on Monday, no metcon on Saturday.
  await fillNumber(page, "Steps", "9000");
  await page.getByRole("group", { name: "Zone 2 days" }).getByRole("button", { name: "Mon" }).click();
  await page.getByRole("group", { name: "Metcon days" }).getByRole("button", { name: "Sat" }).click();
  await expectSynced(page);
  const s = (await serverData(page)).settings;
  expect(s.program.cycleStartDate).toBe("2026-11-30");
  expect(s.program.days["1"]).toMatchObject({ label: "Pull" });
  expect(s.targets.steps).toBe(9000);
  // This cycle's plan, kept as it was.
  expect(s.program.earlierPlans).toHaveLength(1);
  expect(s.program.earlierPlans![0]).toMatchObject({ start: "2026-10-26", targets: { steps: 15000 } });
  expect(s.program.earlierPlans![0]!.days["1"]).toMatchObject({ label: "Push" });

  // Cancel, then Undo: the next cycle comes back with its edits.
  await page.getByRole("button", { name: "Cancel the new cycle" }).click();
  await expect(toastMessage(page, "New cycle cancelled — this cycle repeats")).toBeVisible();
  await expect(page.locator("[data-next-cycle]")).toHaveCount(0);
  await expectSynced(page);
  expect((await serverData(page)).settings.program).not.toHaveProperty("earlierPlans");
  // The newest toast's Undo (the set-up's may still be on offer above it).
  await page.getByRole("region", { name: "Notifications" }).getByRole("button", { name: "Undo" }).last().click();
  await expect(page.locator("[data-next-cycle]")).toContainText("Next cycle · from Mon Nov 30");
  await expectSynced(page);
  expect((await serverData(page)).settings).toEqual(s);

  // This week reads as before: Train, Today, last week's days.
  expect(await trainReading(page, "/train")).toEqual(trainBefore);
  // The note now says what comes next.
  await expect(note(page)).toContainText("Next: a new cycle from Mon Nov 30 · Review");
  expect(await dayReading(page, "/")).toEqual(todayBefore);
  expect(await dayReading(page, "/day/2026-11-24")).toEqual(lastTuesday);

  // Monday Nov 30: the new plan is in force.
  await page.clock.setSystemTime(NEW_CYCLE_MON);
  const monday = await trainReading(page, "/train");
  expect(monday.title).toBe("Pull");
  expect(monday.link).toMatch(/^Cycle 2 · Week 1( of 5)?/);
  // Pre-filled from the last Pull day (last Tuesday's rows), not from last Monday's flyes.
  expect(monday.exercises).toContain("Barbell row");
  expect(monday.exercises).not.toContain("Dumbbell fly");
  const tuesday = await trainReading(page, "/train/2026-12-01");
  expect(tuesday.title).toBe("Push");
  expect(tuesday.exercises).toContain("Dumbbell fly");
  // Wednesday: the front squat (no max yet: Train asks for one), a lift new to the program.
  await page.goto("/train/2026-12-02");
  await expect(page.locator("main")).toContainText("Front squat");
  // Today: the new targets — 9,000 steps (9k), no Zone 2 on a Monday.
  await page.goto("/");
  await expect(page.locator("main")).toContainText("Target 9k");
  const todayNow = await checklistText(page);
  expect(todayNow).not.toMatch(/Zone 2/);
  // Last cycle's days still read as they did.
  expect(await dayReading(page, "/day/2026-11-24")).toEqual(lastTuesday);
  expect(await dayReading(page, "/day/2026-11-20")).toEqual(lastFriday);
  const lastTuesdayTrain = await trainReading(page, "/train/2026-11-24");
  expect(lastTuesdayTrain.title).toBe("Pull");
  expect(lastTuesdayTrain.link).toMatch(/^Deload/);
});

test("opened on the new cycle's Monday with nothing saved in it: Cycle 1 complete offers the choice, and the new cycle starts that Monday", async ({
  page,
}) => {
  await onboardedOn(page);
  await seedLastCycle(page);
  await page.clock.setSystemTime(NEW_CYCLE_MON);
  await page.goto("/train");
  const choice = page.locator("[data-cycle-choice]");
  await expect(choice).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("dialog")).toContainText("Cycle 1 complete");
  await expect(choice.getByRole("button", { name: "Repeat cycle 1" })).toBeVisible();
  // The overlay ignores taps for its first instant.
  await page.waitForTimeout(600);
  await choice.getByRole("button", { name: "Set up a new cycle" }).click();
  await expect(page).toHaveURL(/\/program#layout$/);
  await expect(toastMessage(page, "New cycle set up from Mon Nov 30")).toBeVisible();
  await expectSynced(page);
  const s = (await serverData(page)).settings;
  expect(s.program.cycleStartDate).toBe("2026-11-30");
  expect(s.program.earlierPlans!.map((p) => p.start)).toEqual(["2026-10-26"]);
  expect((await serverData(page)).seenAchievements).toContain("cycle-1");
  // In force already: this cycle is the new plan (no switch, nothing to cancel), still cycle 2.
  await expect(page.locator("[data-next-cycle]")).toHaveCount(0);
  await expect(page.locator("[data-cycle-now]")).toContainText("Cycle 2 · Week 1 of 5");
  await page.getByRole("combobox", { name: "Mon main lift" }).selectOption({ label: "Deadlift" });
  await expectSynced(page);
  await page.goto("/train");
  await expect(page.locator("main")).toContainText("Deadlift");
  await expect(programLink(page)).toContainText("Cycle 2");
});
