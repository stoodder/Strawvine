/**
 * Program › Rehab (behind the `rehab` flag, set on this device in localStorage): set up "Knee
 * rehab · 6 weeks · M/W/F" from the empty state; "+ A week" says what it will do, does it, and
 * Undo takes it back; End today sends it to the earlier blocks (and drops today's unlogged rehab
 * draft from today's session, which its Undo puts back); a new block that would overlap is
 * refused with the reason; an Undo after another device's edit puts back only its own field. With
 * the flag off there is no Rehab section; `?flags=rehab` turns it on for the device.
 */
import type { Page } from "@playwright/test";
import { expect, expectSynced, MONDAY, MONDAY_ISO, notifications, onboardedOn, serverData, test, toastMessage } from "./helpers";

const FLAGS_KEY = "strawvine:flags";
const MWF = [false, true, false, true, false, true, false];
/** Knee rehab from the Monday before the suite's (Oct 19): today, Mon Oct 26, is in its week 2. */
const KNEE = { id: "knee", name: "Knee rehab", start: "2026-10-19", weeks: 6, days: MWF, carry: "last" };

const rehab = (page: Page) => page.locator("#rehab");
const card = (page: Page) => rehab(page).locator("[data-rehab-block]").first();
const status = (page: Page) => card(page).locator("[data-rehab-status]");
/** The newest toast's Undo. */
const undoButton = (page: Page) => notifications(page).getByRole("button", { name: "Undo" }).last();
const programs = async (page: Page) => (await serverData(page)).settings.rehab?.programs ?? [];
/** Another device (or this one's dispatch) returns the page to the foreground: it catches up with the server. */
const foreground = (page: Page) => page.evaluate(() => void document.dispatchEvent(new Event("visibilitychange")));

async function api(page: Page, method: string, path: string, data?: unknown) {
  const res = await page.request.fetch(path, { method, headers: { "cache-control": "no-cache" }, ...(data !== undefined ? { data } : {}) });
  expect(res.ok(), `${method} ${path} → ${res.status()}`).toBe(true);
  return res.status() === 204 ? null : res.json();
}

/** Saves `programs` as the rehab blocks on the server, as another device would, and opens Program. */
async function seedRehab(page: Page, programs: unknown[]) {
  const { settings } = await serverData(page);
  const res = await page.request.put("/api/settings", { data: { ...settings, rehab: { programs } } });
  expect(res.ok(), `PUT /api/settings → ${res.status()}`).toBe(true);
  await page.goto("/program");
  await expect(rehab(page).getByRole("heading", { level: 2, name: "Rehab" })).toBeVisible();
}

test.describe("with the rehab flag", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript((key) => window.localStorage.setItem(key, "rehab"), FLAGS_KEY);
    await onboardedOn(page, MONDAY);
  });

  test("set up Knee rehab · 6 weeks · M/W/F from the empty state; + A week and its Undo", async ({ page }) => {
    await page.goto("/program");
    await page.getByRole("navigation", { name: "Program sections" }).getByRole("link", { name: "Rehab" }).click();
    await expect(page).toHaveURL(/\/program#rehab$/);
    await expect(rehab(page).getByText("No rehab block yet")).toBeVisible();

    await rehab(page).getByRole("button", { name: "Set up a rehab block" }).click();
    await rehab(page).getByRole("textbox", { name: "Name", exact: true }).fill("Knee rehab");
    const days = rehab(page).getByRole("group", { name: "New rehab block days" });
    for (const d of ["Mon", "Wed", "Fri"]) await expect(days.getByRole("button", { name: d })).toHaveAttribute("aria-pressed", "true");
    await expect(rehab(page).getByRole("group", { name: "New rehab block length" })).toContainText("6 weeks");
    await rehab(page).getByRole("button", { name: "Start it" }).click();

    await expect(toastMessage(page, "Knee rehab set up from Mon Oct 26")).toBeVisible();
    await expect(status(page)).toHaveText("Week 1 of 6 · Oct 26 – Dec 60 of 18 sessions logged");
    await expectSynced(page);
    const [knee] = await programs(page);
    expect(knee).toMatchObject({ name: "Knee rehab", start: "2026-10-26", weeks: 6, days: MWF, carry: "last" });
    expect(knee!.end).toBeUndefined();

    // + A week says what it will do, and does it.
    const extend = card(page).getByRole("button", { name: "A week" });
    await expect(extend).toHaveAccessibleDescription("“+ A week” ends it Sun Dec 13 instead of Dec 6.");
    await extend.click();
    await expect(toastMessage(page, "Knee rehab ends Sun Dec 13")).toBeVisible();
    await expect(card(page).getByText("Ends Dec 13")).toBeVisible();
    await expect.poll(async () => (await programs(page))[0]?.weeks).toBe(7);

    // Undo: six weeks again, on the server too — and focus is back on the button.
    await undoButton(page).click();
    await expect(card(page).getByText("Ends Dec 6")).toBeVisible();
    await expect.poll(async () => (await programs(page))[0]?.weeks).toBe(6);
    await expect(extend).toBeFocused();
    await page.reload();
    await expect(status(page)).toHaveText("Week 1 of 6 · Oct 26 – Dec 60 of 18 sessions logged");
  });

  test("End today: it ended yesterday and moves to the earlier blocks; Undo brings it back", async ({ page }) => {
    await seedRehab(page, [KNEE]);
    await expect(status(page)).toHaveText("Week 2 of 6 · Oct 19 – Nov 290 of 18 sessions logged");
    await card(page).getByRole("button", { name: "End today" }).click();
    await expect(toastMessage(page, "Knee rehab ended: its last day was yesterday")).toBeVisible();
    await expect(rehab(page).locator("[data-rehab-block]")).toHaveCount(0);
    await expect(rehab(page).locator("[data-rehab-history] li")).toHaveText("Knee rehabOct 19 – Oct 25 · 0 sessions");
    await expect(rehab(page).getByRole("button", { name: "New rehab block" })).toHaveAccessibleDescription("Starts today.");
    await expect.poll(async () => (await programs(page))[0]?.end).toBe("2026-10-25");

    await undoButton(page).click();
    await expect(status(page)).toHaveText("Week 2 of 6 · Oct 19 – Nov 290 of 18 sessions logged");
    await expectSynced(page);
    expect(await programs(page)).toEqual([KNEE]);
  });

  test("End today drops today's unlogged rehab draft from today's session on the server; Undo puts back only it", async ({ page }) => {
    await seedRehab(page, [KNEE]);
    const ex = await api(page, "POST", "/api/exercises", {
      name: "Spanish squat",
      category: "accessory",
      measure: "seconds",
      weighted: false,
    });
    const set = (id: string) => ({
      id,
      targetReps: 45,
      targetWeight: null,
      reps: null,
      weight: null,
      done: false,
      amrap: false,
      appliedProgressionLb: null,
    });
    const draft = {
      id: "knee-draft",
      kind: "rehab",
      rehab: "knee",
      exercises: [{ exerciseId: ex.id, measure: "seconds", sets: [set("r1"), set("r2")] }],
    };
    const strength = { id: "acc", kind: "accessory", exercises: [{ exerciseId: ex.id, measure: "seconds", sets: [set("a1")] }] };
    const today = { date: MONDAY_ISO, label: "Push", cycle: 1, week: 1, deload: false, primaryMaxLb: null, notes: "", completedAt: null };
    const todays = async () => (await serverData(page)).sessions.find((s) => s.date === MONDAY_ISO) ?? null;
    const blockIds = async () => (await todays())?.blocks.map((b) => b.id) ?? null;

    // Today's session as the first rehab edit saved it: a strength block and the knee draft, nothing logged.
    await api(page, "PUT", `/api/sessions/${MONDAY_ISO}`, { ...today, blocks: [strength, draft] });
    await page.reload();
    await card(page).getByRole("button", { name: "End today" }).click();
    await expect(toastMessage(page, "Knee rehab ended: its last day was yesterday")).toBeVisible();
    await expect.poll(blockIds).toEqual(["acc"]);
    await undoButton(page).click();
    await expect(status(page)).toHaveText("Week 2 of 6 · Oct 19 – Nov 290 of 18 sessions logged");
    await expect.poll(blockIds).toEqual(["acc", "knee-draft"]);
    await expectSynced(page);
    expect(await programs(page)).toEqual([KNEE]);
    expect((await todays())!.blocks[1]).toEqual(draft);

    // Only the draft in it: End today deletes today's session, and Undo saves it again.
    await api(page, "PUT", `/api/sessions/${MONDAY_ISO}`, { ...today, blocks: [draft] });
    await page.reload();
    await card(page).getByRole("button", { name: "End today" }).click();
    await expect(toastMessage(page, "Knee rehab ended: its last day was yesterday")).toBeVisible();
    await expect.poll(todays).toBeNull();
    await undoButton(page).click();
    await expect.poll(blockIds).toEqual(["knee-draft"]);
    await expectSynced(page);
    expect(await programs(page)).toEqual([KNEE]);
  });

  test("a new block overlapping Knee rehab is refused with the reason; after it, it is set up", async ({ page }) => {
    await seedRehab(page, [KNEE]);
    const add = rehab(page).getByRole("button", { name: "New rehab block" });
    await expect(add).toHaveAccessibleDescription("Starts Mon Nov 30, the day after Knee rehab ends — or today, if you end it first.");
    await add.click();
    await rehab(page).getByRole("textbox", { name: "Name", exact: true }).fill("Hip rehab");
    const starts = rehab(page).getByLabel("Starts", { exact: true });
    await expect(starts).toHaveValue("2026-11-30");
    await starts.fill("2026-10-26");
    await rehab(page).getByRole("button", { name: "Start it" }).click();
    await expect(rehab(page).getByRole("alert")).toHaveText("Knee rehab runs until Nov 29: end it or start this one after.");
    await expectSynced(page);
    expect(await programs(page)).toEqual([KNEE]);

    await starts.fill("2026-11-30");
    await rehab(page).getByRole("button", { name: "Start it" }).click();
    await expect(toastMessage(page, "Hip rehab set up from Mon Nov 30")).toBeVisible();
    await expect(rehab(page).getByRole("heading", { level: 3, name: "Next rehab block" })).toBeVisible();
    await expect.poll(async () => (await programs(page)).map((p) => p.name)).toEqual(["Knee rehab", "Hip rehab"]);
  });

  test("Undo after another device's edit puts back only its own field", async ({ page }) => {
    await seedRehab(page, [KNEE]);
    await card(page).getByRole("button", { name: "Increase Knee rehab length" }).click();
    await expect(toastMessage(page, "Knee rehab ends Sun Dec 6")).toBeVisible();
    await expectSynced(page);
    // Keep the Undo on offer while the other device's edit arrives (a toast with focus stays).
    await undoButton(page).focus();

    // Another device renames the block and changes a preference.
    const { settings } = await serverData(page);
    expect(settings.rehab!.programs[0]!.weeks).toBe(7);
    const other = {
      ...settings,
      nutrition: { ...settings.nutrition, kcalPerLb: 3600 },
      rehab: { programs: [{ ...settings.rehab!.programs[0]!, name: "Left knee rehab" }] },
    };
    const res = await page.request.put("/api/settings", { data: other });
    expect(res.ok()).toBe(true);
    // This device catches up on a return to the foreground (at most every 5 s).
    await page.clock.fastForward(6000);
    await foreground(page);
    await expect(card(page).getByRole("textbox", { name: "Rehab block name" })).toHaveValue("Left knee rehab");

    await undoButton(page).click();
    await expect(card(page).getByText("Ends Nov 29")).toBeVisible();
    await expectSynced(page);
    const after = (await serverData(page)).settings;
    expect(after.rehab!.programs).toEqual([{ ...KNEE, name: "Left knee rehab" }]);
    expect(after.nutrition.kcalPerLb).toBe(3600);
    await expect(toastMessage(page, /Merged changes/)).toHaveCount(0);
  });
});

test("flag off: Program has no Rehab section; ?flags=rehab turns it on for this device, ?flags= off again", async ({ page }) => {
  await onboardedOn(page, MONDAY);
  await page.goto("/program");
  await expect(page.getByRole("heading", { level: 2, name: "Cycle weeks" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Rehab" })).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Program sections" }).getByRole("link", { name: "Rehab" })).toHaveCount(0);
  await page.goto("/settings");
  await expect(page.locator('[data-program-link="rehab"]')).toHaveCount(0);

  // Opened with ?flags=rehab: on, and the address bar loses the parameter.
  await page.goto("/program?flags=rehab");
  await expect(page.getByRole("heading", { level: 2, name: "Rehab" })).toBeVisible();
  expect(new URL(page.url()).search).toBe("");
  expect(await page.evaluate((key) => localStorage.getItem(key), FLAGS_KEY)).toBe("rehab");
  await page.goto("/settings");
  await expect(page.locator('[data-program-link="rehab"]')).toBeVisible();

  await page.goto("/program?flags=");
  await expect(page.getByRole("heading", { level: 2, name: "Cycle weeks" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Rehab" })).toHaveCount(0);
});
