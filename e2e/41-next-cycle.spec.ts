/**
 * The end of a cycle (docs/SPEC.md §6.4, §6.6, §7): keep the plan, or set up a new one.
 *
 * The template's program starts Mon Oct 26 (five-week cycles): cycle 1 runs to Sun Nov 29 — its
 * last week, the deload, is Nov 23–29 — and cycle 2 starts Mon Nov 30. Last cycle's Monday and
 * Tuesday (Nov 16, 17) were done with accessories: Push with dumbbell flyes, Pull with barbell rows.
 *
 * - In the last week Train shows a quiet note. Keep this plan acknowledges with a toast (Change goes
 *   to Program › Now) and focus on the title: the note goes, after a reload and on another device too.
 * - Set up a new plan copies the plan from Mon Nov 30 and opens Program on it (on the next cycle).
 *   Two days swapped (Pull on Monday, Push on Tuesday), a main lift changed (front squat on
 *   Wednesday), the steps target and the Zone 2 / metcon days changed: this week's Train and Today
 *   read as before; Program opened again mid-cycle shows this cycle. On Mon Nov 30 the new plan is
 *   in force — cycle 2, Pull on Monday pre-filled from last Tuesday's Pull — and last week's days
 *   still read as they did. Cancel and its Undo on the way.
 * - In a later cycle's last week with nothing saved in it, the note's new plan starts the Monday
 *   after the cycle — never that cycle's own Monday, weeks back.
 * - One This cycle / Next cycle switch: tapping it never moves it.
 * - Delay a week in the new plan's first week: that week is a pause (no cycle), the plan before
 *   doesn't run on, and no "Cycle 2 complete" follows for it.
 * - Opened on the new cycle's Monday with nothing saved in it, "Cycle 1 complete" offers the choice
 *   too; the new plan starts that Monday and can be cancelled while nothing is saved under it.
 */
import type { Browser, Page } from "@playwright/test";
import {
  dismissCelebrations,
  expect,
  expectSynced,
  fillNumber,
  keepAnimationsOnTheRealTimeline,
  notifications,
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

/** A completed session on `date` (no sets: what Train saves for a day that was opened and finished). */
async function saveDone(page: Page, date: string, label: string, cycle: number) {
  await api(page, "PUT", `/api/sessions/${date}`, {
    date,
    label,
    cycle,
    week: 1,
    deload: false,
    primaryMaxLb: null,
    blocks: [],
    notes: "",
    completedAt: `${date}T18:00:00.000Z`,
    planSig: null,
  });
}

/** A new plan from Mon Nov 30, set up from the note in the last week (as the second test does through the UI). */
async function setUpNextFromNote(page: Page) {
  await page.goto("/train");
  await note(page).getByRole("button", { name: "Set up a new plan" }).click();
  await expect(page).toHaveURL(/\/program#layout$/);
  await expect(toastMessage(page, "New plan set up from Mon Nov 30")).toBeVisible();
  await expectSynced(page);
}

const planSwitch = (page: Page) => page.getByRole("group", { name: "Plan to edit" });

test("in the last week: Keep this plan acknowledges, says so, and the note stays gone — after a reload and on another device", async ({
  page,
  browser,
}) => {
  await onboardedOn(page, LAST_WEEK_WED);
  await seedLastCycle(page);
  await page.goto("/train");
  await expect(note(page)).toContainText("Cycle 1 ends Sun Nov 29.");
  await expect(note(page)).toContainText("For cycle 2: Keep this plan · Set up a new plan");
  // Program's Now has it too (and no second "Set up a new plan" beside it); Today doesn't.
  await page.goto("/program");
  await expect(note(page)).toContainText("Cycle 1 ends Sun Nov 29.");
  await expect(page.getByRole("button", { name: "Set up a new plan" })).toHaveCount(1);
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(note(page)).toHaveCount(0);

  await page.goto("/train");
  await expect(note(page)).toBeVisible();
  const scrolled = await page.evaluate(() => window.scrollY);
  await page.getByRole("button", { name: "Keep this plan" }).click();
  await expect(note(page)).toHaveCount(0);
  // Feedback: a toast with a way to change it; focus on the title below where the note was, and no scroll.
  await expect(toastMessage(page, "Cycle 2 keeps this plan")).toBeVisible();
  await expect(page.locator("[data-train-title]")).toBeFocused();
  expect(await page.evaluate(() => window.scrollY)).toBe(scrolled);
  await expectSynced(page);
  expect((await serverData(page)).seenAchievements).toContain("repeat-cycle-1");
  // Nothing about the program changed: Keep is what happens anyway.
  expect((await serverData(page)).settings.program).not.toHaveProperty("earlierPlans");
  // "Change" leads to Program › Now, where a new plan can still be set up.
  await notifications(page).getByRole("button", { name: "Change" }).click();
  await expect(page).toHaveURL(/\/program#now$/);
  await expect(page.locator("#now").getByRole("button", { name: "Set up a new plan" })).toBeVisible();
  await page.goto("/train");
  await page.reload();
  await expect(page.locator("[data-train-title]")).toBeVisible();
  await expect(note(page)).toHaveCount(0);

  const other = await secondDevice(page, browser, LAST_WEEK_WED, "/train");
  await expect(other.b.locator("[data-train-title]")).toBeVisible();
  await expect(other.b.locator("[data-cycle-end]")).toHaveCount(0);
  await other.close();
});

test("set up a new plan: the next plan changes nothing this week, then rules from its Monday; cancel and Undo", async ({ page }) => {
  await onboardedOn(page, LAST_WEEK_WED);
  await seedLastCycle(page);
  // How this week and last week's days read before anything is set up.
  const todayBefore = await dayReading(page, "/");
  const lastTuesday = await dayReading(page, "/day/2026-11-24");
  const lastFriday = await dayReading(page, "/day/2026-11-20");
  const trainBefore = await trainReading(page, "/train");

  await page.getByRole("button", { name: "Set up a new plan" }).click();
  await expect(page).toHaveURL(/\/program#layout$/);
  await expect(toastMessage(page, "New plan set up from Mon Nov 30")).toBeVisible();
  await expect(page.locator("[data-next-cycle]")).toContainText("Next: a new plan from Mon Nov 30 · Review");
  // Opened to review it: one switch, on the next cycle, and the sections say so.
  await expect(planSwitch(page)).toHaveCount(1);
  await expect(planSwitch(page).getByRole("button", { name: "Next cycle" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("heading", { level: 2, name: "Weekly layout · Next cycle" })).toBeVisible();

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
  // This cycle's plan, kept as it was (set up to end where the next one starts).
  expect(s.program.earlierPlans).toHaveLength(1);
  expect(s.program.earlierPlans![0]).toMatchObject({ start: "2026-10-26", end: "2026-11-30", targets: { steps: 15000 } });
  expect(s.program.earlierPlans![0]!.days["1"]).toMatchObject({ label: "Push" });

  // Cancel, then Undo: the next cycle comes back with its edits.
  await page.getByRole("button", { name: "Cancel the new plan" }).click();
  await expect(toastMessage(page, "New plan cancelled — cycle 2 keeps this plan")).toBeVisible();
  await expect(page.locator("[data-next-cycle]")).toHaveCount(0);
  await expectSynced(page);
  expect((await serverData(page)).settings.program).not.toHaveProperty("earlierPlans");
  // The newest toast's Undo (the set-up's may still be on offer above it).
  await notifications(page).getByRole("button", { name: "Undo" }).last().click();
  await expect(page.locator("[data-next-cycle]")).toContainText("Next: a new plan from Mon Nov 30 · Review");
  await expectSynced(page);
  expect((await serverData(page)).settings).toEqual(s);

  // Opened again mid-cycle (not to review the next one): the plan sections are this cycle's.
  await page.goto("/program");
  await expect(planSwitch(page).getByRole("button", { name: "This cycle" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("heading", { level: 2, name: "Targets & days · This cycle" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Steps", exact: true })).toHaveValue("15,000");

  // This week reads as before: Train, Today, last week's days.
  expect(await trainReading(page, "/train")).toEqual(trainBefore);
  // The note now says what comes next.
  await expect(note(page)).toContainText("Next: a new plan from Mon Nov 30 · Review");
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

test("the note in a later cycle's last week, with nothing saved in that cycle: the new plan starts the Monday after it, never weeks back", async ({
  page,
}) => {
  await onboardedOn(page, LAST_WEEK_WED);
  await seedLastCycle(page);
  // Wed Dec 30: the last week of cycle 2 (Nov 30 – Jan 3), nothing saved in it.
  await page.clock.setSystemTime(at("2026-12-30"));
  await page.goto("/train");
  await expect(note(page)).toContainText("Cycle 2 ends Sun Jan 3.");
  await expect(note(page)).toContainText("For cycle 3:");
  await note(page).getByRole("button", { name: "Set up a new plan" }).click();
  await expect(toastMessage(page, "New plan set up from Mon Jan 4")).toBeVisible();
  await expectSynced(page);
  const s = (await serverData(page)).settings;
  expect(s.program.cycleStartDate).toBe("2027-01-04");
  expect(s.program.earlierPlans!.map((p) => [p.start, p.end])).toEqual([["2026-10-26", "2027-01-04"]]);
  // The note says what comes next instead of asking again.
  await page.goto("/train");
  await expect(note(page)).toContainText("Next: a new plan from Mon Jan 4 · Review");
  await expect(note(page).getByRole("button", { name: "Set up a new plan" })).toHaveCount(0);
});

test("one This cycle / Next cycle switch, under Now: tapping it never moves it", async ({ page }) => {
  await onboardedOn(page, LAST_WEEK_WED);
  await seedLastCycle(page);
  await setUpNextFromNote(page);
  await page.goto("/program");
  await expect(planSwitch(page)).toHaveCount(1);
  const thisCycle = planSwitch(page).getByRole("button", { name: "This cycle" });
  const nextCycle = planSwitch(page).getByRole("button", { name: "Next cycle" });
  await expect(thisCycle).toHaveAttribute("aria-pressed", "true");
  await planSwitch(page).scrollIntoViewIfNeeded();
  const before = await planSwitch(page).boundingBox();
  await nextCycle.click();
  await expect(nextCycle).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("heading", { level: 2, name: "Cycle weeks · Next cycle" })).toBeVisible();
  expect(await planSwitch(page).boundingBox()).toEqual(before);
  await thisCycle.click();
  await expect(thisCycle).toHaveAttribute("aria-pressed", "true");
  expect(await planSwitch(page).boundingBox()).toEqual(before);
  // The rules are the same for both.
  await expect(page.locator("#rules")).toContainText("Same for every cycle.");
});

test("Delay a week in a new plan's first week: a pause, not another cycle of the plan before; a session saved then reads like one before week 1", async ({
  page,
}) => {
  await onboardedOn(page, LAST_WEEK_WED);
  await seedLastCycle(page);
  await setUpNextFromNote(page);
  // Monday Nov 30: the new plan's first day; a session done.
  await page.clock.setSystemTime(NEW_CYCLE_MON);
  await saveDone(page, "2026-11-30", "Push", 2);
  // Tuesday: not ready for it — Delay a week.
  await page.clock.setSystemTime(at("2026-12-01"));
  await page.goto("/program");
  await expect(page.locator("[data-cycle-now]")).toContainText("Cycle 2 · Week 1 of 5");
  await expect(page.getByRole("button", { name: "Delay a week" })).toBeEnabled();
  await expect(page.locator("#now")).toContainText("this week is a pause before cycle 2");
  await page.getByRole("button", { name: "Delay a week" }).click();
  await expect(toastMessage(page, "Program delayed a week")).toBeVisible();
  await expect(page.locator("[data-cycle-now]")).toContainText("Cycle 2 starts next Monday");
  await expectSynced(page);
  const s = (await serverData(page)).settings;
  expect(s.program.cycleStartDate).toBe("2026-12-07");
  // The plan before still ends where it was set up to.
  expect(s.program.earlierPlans!.map((p) => [p.start, p.end])).toEqual([["2026-10-26", "2026-11-30"]]);
  // This week: no cycle, no lift planned. Monday's session is kept and reads like one saved before week 1.
  const monday = await trainReading(page, "/train/2026-11-30");
  expect(monday.link).toBe("Cycle 2 starts Mon Dec 7");
  const tuesday = await trainReading(page, "/train");
  expect(tuesday.link).toBe("Cycle 2 starts Mon Dec 7");
  // Monday Dec 7: cycle 2, week 1 — and no "Cycle 2 complete" for the week that paused.
  await page.clock.setSystemTime(at("2026-12-07"));
  const celebrated = await dismissCelebrations(page);
  const dec7 = await trainReading(page, "/train");
  expect(dec7.link).toMatch(/^Cycle 2 · Week 1( of 5)?/);
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.waitForTimeout(2500);
  expect(celebrated.filter((t) => /Cycle 2/.test(t))).toEqual([]);
  expect((await serverData(page)).seenAchievements).not.toContain("cycle-2");
});

test("opened on the new cycle's Monday with nothing saved in it: Cycle 1 complete offers the choice; the new plan starts that Monday and can be cancelled while nothing is saved under it", async ({
  page,
}) => {
  await onboardedOn(page);
  await seedLastCycle(page);
  await page.clock.setSystemTime(NEW_CYCLE_MON);
  await page.goto("/train");
  const choice = page.locator("[data-cycle-choice]");
  await expect(choice).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("dialog")).toContainText("Cycle 1 complete");
  await expect(choice).toContainText("For cycle 2:");
  await expect(choice.getByRole("button", { name: "Keep this plan" })).toBeFocused();
  // The overlay ignores taps for its first instant.
  await page.waitForTimeout(600);
  await choice.getByRole("button", { name: "Set up a new plan" }).click();
  await expect(page).toHaveURL(/\/program#layout$/);
  await expect(toastMessage(page, "New plan set up from Mon Nov 30")).toBeVisible();
  await expectSynced(page);
  const s = (await serverData(page)).settings;
  expect(s.program.cycleStartDate).toBe("2026-11-30");
  expect(s.program.earlierPlans!.map((p) => p.start)).toEqual(["2026-10-26"]);
  expect((await serverData(page)).seenAchievements).toContain("cycle-1");
  // In force already: this cycle is the new plan (no switch), still cycle 2 — and it can still be cancelled.
  await expect(planSwitch(page)).toHaveCount(0);
  await expect(page.locator("[data-cycle-now]")).toContainText("Cycle 2 · Week 1 of 5");
  await expect(page.locator("[data-next-cycle]")).toContainText("This cycle follows a new plan from Mon Nov 30.");
  await page.getByRole("combobox", { name: "Mon main lift" }).selectOption({ label: "Deadlift" });
  await expectSynced(page);
  await page.goto("/train");
  await expect(page.locator("main")).toContainText("Deadlift");
  await expect(programLink(page)).toContainText("Cycle 2");

  // Cancel it: back to the plan before, exactly; focus goes to Set up a new plan.
  await page.goto("/program");
  await page.getByRole("button", { name: "Cancel the new plan" }).click();
  await expect(toastMessage(page, "New plan cancelled — cycle 2 keeps this plan")).toBeVisible();
  await expect(page.locator("#now").getByRole("button", { name: "Set up a new plan" })).toBeFocused();
  await expectSynced(page);
  const after = (await serverData(page)).settings;
  expect(after.program).not.toHaveProperty("earlierPlans");
  expect(after.program).not.toHaveProperty("planId");
  expect(after.program.cycleStartDate).toBe("2026-10-26");
  expect(after.program.days).toEqual(s.program.earlierPlans![0]!.days);
  // Once a session is saved under a new plan, it is history: nothing to cancel.
  await page.locator("#now").getByRole("button", { name: "Set up a new plan" }).click();
  await expect(toastMessage(page, "New plan set up from Mon Nov 30")).toBeVisible();
  await expectSynced(page);
  await saveDone(page, "2026-11-30", "Push", 2);
  await page.goto("/program");
  await expect(page.locator("[data-cycle-now]")).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel the new plan" })).toHaveCount(0);
});
