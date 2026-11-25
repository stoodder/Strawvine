/**
 * Swapping the main lift for one session (SPEC §6.5): on Tuesday of week 1 (Pull, deadlift) the
 * back squat is done instead — its sets from the squat's max, Pull's accessories kept — logged
 * (the AMRAP bump goes to the squat) and finished; Wednesday (Legs, back squat) then offers the
 * deadlift ("Back squat was done Tue. Do Deadlift today?"), derived and never stored; next
 * Tuesday is the deadlift again with Tuesday's accessories. Plus the swap's Undo and its refusal
 * once a main-lift set is logged. Wednesday's line holds while a note is typed (the field doesn't
 * move). A lift without a max gets one on the way ("Set max and swap"); "Another exercise" skips the
 * main lift and adds one. Friday of the deload week (Carries & pull, no main lift) takes Thursday's
 * Strict press, from its max. At 320 px a long name gives way to "swap" and "skip rest". Onboarded
 * Sunday 2026-10-25 (bench 225); squat 315 and deadlift 405 are added here, with a Pull and a Legs
 * session the week before to carry accessories from.
 */
import type { Page } from "@playwright/test";
import type { Bootstrap, Session } from "../src/shared/schemas";
import { expect, expectSynced, notifications, onboardedOn, serverData, test, toastMessage } from "./helpers";

const TUE = "2026-10-27";
const WED = "2026-10-28";
const NEXT_TUE = "2026-11-03";
/** Friday of week 5, the deload (Thanksgiving week): Carries & pull, no main lift planned. */
const DELOAD_FRI = "2026-11-27";
const at = (iso: string) => new Date(`${iso}T10:00:00`);

/** A call to the app's API as the signed-in page. */
async function callApi(page: Page, method: string, path: string, body?: unknown) {
  const res = await page.request.fetch(path, { method, ...(body !== undefined ? { data: body } : {}) });
  expect(res.ok(), `${method} ${path} → ${res.status()} ${await res.text()}`).toBe(true);
  return res.status() === 204 ? null : res.json();
}

/** Squat and deadlift maxes; a barbell row on last week's Pull, a walking lunge on its Legs. */
async function seed(page: Page) {
  const call = (method: string, path: string, body?: unknown) => callApi(page, method, path, body);
  const boot = (await call("GET", "/api/bootstrap")) as Bootstrap;
  const id = (name: string) => boot.exercises.find((e) => e.name === name)!.id;
  await call("POST", `/api/exercises/${id("Back squat")}/maxes`, { date: "2026-10-25", valueLb: 315, source: "manual", note: null });
  await call("POST", `/api/exercises/${id("Deadlift")}/maxes`, { date: "2026-10-25", valueLb: 405, source: "manual", note: null });
  const row = (await call("POST", "/api/exercises", { name: "Barbell row", category: "accessory", measure: "reps", weighted: true })) as {
    id: number;
  };
  const lunge = (await call("POST", "/api/exercises", {
    name: "Walking lunge",
    category: "accessory",
    measure: "reps",
    weighted: true,
  })) as { id: number };
  const done = (sid: string, reps: number, weight: number) => ({
    id: sid,
    targetReps: reps,
    targetWeight: weight,
    reps,
    weight,
    done: true,
    amrap: false,
    appliedProgressionLb: null,
  });
  const session = (date: string, label: string, exerciseId: number, weight: number): Session => ({
    date,
    label,
    cycle: null,
    week: null,
    deload: false,
    primaryMaxLb: null,
    blocks: [
      {
        id: `a-${date}`,
        kind: "accessory",
        exercises: [{ exerciseId, measure: "reps", sets: [done(`${date}-1`, 10, weight), done(`${date}-2`, 10, weight)] }],
      },
    ],
    notes: "",
    completedAt: `${date}T18:00:00.000Z`,
    planSig: null,
  });
  await call("PUT", "/api/sessions/2026-10-20", session("2026-10-20", "Pull", row.id, 135));
  await call("PUT", "/api/sessions/2026-10-21", session("2026-10-21", "Legs", lunge.id, 50));
}

const mainLift = (page: Page) => page.locator("section").filter({ has: page.getByRole("heading", { level: 2, name: "Main lift" }) });
const swapSheet = (page: Page) => page.getByRole("dialog", { name: "Swap the main lift" });
const saved = async (page: Page, date: string) => (await serverData(page)).sessions.find((s) => s.date === date);
const mainOf = (s: Session) => s.blocks.find((b) => b.kind === "primary")!.exercises[0]!;
const idOf = async (page: Page, name: string) => (await serverData(page)).exercises.find((e) => e.name === name)!.id;

/** Log every main-lift set of `lift` (the AMRAP two reps over, with the bump applied) and every accessory set, then Finish. */
async function logAndFinish(page: Page, lift: string) {
  const sets = page.getByRole("button", { name: new RegExp(`^${lift} set \\d+:`) });
  const count = await sets.count();
  for (let i = 1; i < count; i++) await page.getByRole("button", { name: new RegExp(`^${lift} set ${i}:`) }).click();
  await page.getByRole("button", { name: new RegExp(`^${lift} set ${count}:.*AMRAP`) }).click();
  const amrap = page.getByRole("dialog", { name: /AMRAP/ });
  for (let i = 0; i < 2; i++) await amrap.getByRole("button", { name: "Increase reps" }).click();
  await amrap.getByRole("button", { name: /^Log \d+ reps$/ }).click();
  await amrap.getByRole("button", { name: "Apply" }).click();
  await expect(amrap).toHaveCount(0);
  const open = page.getByRole("button", { name: /^Barbell row set \d+:/, pressed: false });
  await expect(open).toHaveCount(2);
  for (let n = 2; n > 0; n--) {
    await open.first().click();
    await expect(open).toHaveCount(n - 1);
  }
  await page.getByRole("button", { name: "Finish session" }).click();
  await expect(page.getByRole("heading", { name: "Session complete" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expectSynced(page);
}

test.beforeEach(async ({ page }) => {
  await onboardedOn(page, at(TUE));
  await seed(page);
  await page.goto("/train");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Pull");
  await expect(page.getByRole("button", { name: /^Deadlift set \d+:/ })).toHaveCount(4);
});

test("Tuesday's deadlift swapped for the squat: Undo, then refused once a squat set is logged", async ({ page }) => {
  await page.getByRole("button", { name: "Swap Deadlift for another lift" }).click();
  const sheet = swapSheet(page);
  await expect(sheet.getByText("For this session only: Pull keeps its accessories, and the plan doesn't change.")).toBeVisible();
  await expect(sheet.locator("[data-swap-to]")).toHaveText([
    /^Bench press\s*Mon$/,
    /^Back squat\s*Wed$/,
    /^Strict press\s*Thu · set max$/,
    /^Front squat\s*set max$/,
  ]);
  await sheet.getByRole("button", { name: "Back squat · Wed" }).click();
  await expect(sheet).toHaveCount(0);

  // The squat's sets (315 max, week 1), Pull's accessories, a note of what it replaces.
  await expect(page.getByRole("button", { name: /^Back squat set \d+:/ })).toHaveCount(4);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Pull");
  await expect(mainLift(page).locator("[data-swapped]")).toHaveText("In place of Deadlift · this session only");
  await expect(page.getByRole("button", { name: /^Barbell row set 1:/ })).toBeVisible();
  await expectSynced(page);
  expect(mainOf((await saved(page, TUE))!).sets.map((s) => s.targetWeight)).toEqual([240, 225, 215, 200]);

  // Undo: the swap was the day's only change, so the day is its plan again (nothing saved).
  await expect(toastMessage(page, "Back squat in place of Deadlift today")).toBeVisible();
  await notifications(page).getByRole("button", { name: "Undo" }).click();
  await expect(page.getByRole("button", { name: /^Deadlift set \d+:/ })).toHaveCount(4);
  await expect(page.locator("[data-swapped]")).toHaveCount(0);
  await expectSynced(page);
  expect(await saved(page, TUE)).toBeUndefined();

  // Swapped again and a squat set logged: the swap is refused, saying why — and nothing is thrown away.
  await page.getByRole("button", { name: "Swap Deadlift for another lift" }).click();
  await swapSheet(page).getByRole("button", { name: "Back squat · Wed" }).click();
  await page.getByRole("button", { name: /^Back squat set 1:/ }).click();
  await page.getByRole("button", { name: "Swap Back squat for another lift" }).click();
  await expect(swapSheet(page).getByRole("status")).toHaveText(/^A set of Back squat is logged\. Logged sets are never thrown away/);
  await expect(swapSheet(page).locator("[data-swap-to], [data-swap-back]")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(swapSheet(page)).toHaveCount(0);
  await expectSynced(page);
  const s = (await saved(page, TUE))!;
  expect(mainOf(s).exerciseId).toBe(await idOf(page, "Back squat"));
  expect(mainOf(s).sets[0]!.done).toBe(true);
});

test("a week of swaps: squat on Tuesday (logged, finished), the deadlift offered on Wednesday, next Tuesday as planned", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Swap Deadlift for another lift" }).click();
  await swapSheet(page).getByRole("button", { name: "Back squat · Wed" }).click();
  await expect(page.getByRole("button", { name: /^Back squat set \d+:/ })).toHaveCount(4);
  await logAndFinish(page, "Back squat");

  const squat = await idOf(page, "Back squat");
  const deadlift = await idOf(page, "Deadlift");
  let data = await serverData(page);
  const tue = data.sessions.find((s) => s.date === TUE)!;
  expect(tue.label).toBe("Pull");
  expect(tue.completedAt).not.toBeNull();
  expect(mainOf(tue).exerciseId).toBe(squat);
  expect(
    tue.blocks
      .filter((b) => b.kind === "accessory")
      .map((b) => b.exercises.map((e) => data.exercises.find((x) => x.id === e.exerciseId)!.name)),
  ).toEqual([["Barbell row"]]);
  // The AMRAP was the squat's: +2 reps → squat 317 (deadlift untouched).
  const latest = (id: number) =>
    data.maxEntries
      .filter((m) => m.exerciseId === id)
      .sort((a, b) => (a.date !== b.date ? (a.date < b.date ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1))[0]!;
  expect([latest(squat).valueLb, latest(squat).source]).toEqual([317, "amrap"]);
  expect(latest(deadlift).valueLb).toBe(405);

  // Wednesday (Legs, back squat — already done Tuesday): the deadlift is offered, nothing is saved for it yet.
  await page.clock.setSystemTime(at(WED));
  await page.goto("/train");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Legs");
  const line = page.locator("[data-swap-suggestion]");
  await expect(line).toHaveText("Back squat was done Tue. Do Deadlift today?");
  expect(await saved(page, WED)).toBeUndefined();
  await line.getByRole("button", { name: "Do Deadlift today?" }).click();
  await expect(page.getByRole("button", { name: /^Deadlift set \d+:/ })).toHaveCount(4);
  await expect(mainLift(page).locator("[data-swapped]")).toHaveText("In place of Back squat · this session only");
  await expect(page.getByRole("button", { name: /^Walking lunge set 1:/ })).toBeVisible();
  await expect(line).toHaveCount(0);
  await expectSynced(page);
  const wed = (await saved(page, WED))!;
  expect(wed.label).toBe("Legs");
  expect(mainOf(wed).exerciseId).toBe(deadlift);
  expect(mainOf(wed).sets.map((s) => s.targetWeight)).toEqual([310, 290, 275, 255]);

  // Next Tuesday: the plan's deadlift again (week 2), with Tuesday's accessories — the swap was one session's.
  await page.clock.setSystemTime(at(NEXT_TUE));
  await page.goto("/train");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Pull");
  await expect(page.getByRole("button", { name: /^Deadlift set \d+:/ })).toHaveCount(4);
  await expect(page.locator("[data-swapped]")).toHaveCount(0);
  await expect(page.locator("[data-swap-suggestion]")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Barbell row set 1:/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Back squat set/ })).toHaveCount(0);
  data = await serverData(page);
  expect(data.sessions.find((s) => s.date === NEXT_TUE)).toBeUndefined();
});

test("Wednesday's line holds while a note is typed (the day saves under it): the field doesn't move", async ({ page }) => {
  await page.getByRole("button", { name: "Swap Deadlift for another lift" }).click();
  await swapSheet(page).getByRole("button", { name: "Back squat · Wed" }).click();
  await page.getByRole("button", { name: /^Back squat set 1:/ }).click();
  await expectSynced(page);
  await page.clock.setSystemTime(at(WED));
  await page.goto("/train");
  const line = page.locator("[data-swap-suggestion]");
  await expect(line).toHaveText("Back squat was done Tue. Do Deadlift today?");
  const notes = page.getByRole("textbox", { name: "Session notes" });
  await notes.scrollIntoViewIfNeeded();
  await notes.tap();
  const docTop = () => notes.evaluate((el) => el.getBoundingClientRect().top + window.scrollY);
  const before = await docTop();
  await page.keyboard.type("hotel gym", { delay: 30 });
  // The note saved the day: the suggestion no longer applies, but the line stays (nothing to tap) while typing.
  await expect.poll(async () => (await saved(page, WED))?.notes).toBe("hotel gym");
  await expect(line).toHaveText("Back squat was done Tue. Do Deadlift today?");
  await expect(line.getByRole("button")).toHaveCount(0);
  await expect(notes).toBeFocused();
  expect(Math.abs((await docTop()) - before), "the notes field moved while typing").toBeLessThanOrEqual(0.5);
  // Done typing: it goes.
  await notes.blur();
  await expect(line).toHaveCount(0);
});

test("a lift without a max: its row opens the max sheet, and the swap follows the saved max (Undo still there)", async ({ page }) => {
  await page.getByRole("button", { name: "Swap Deadlift for another lift" }).click();
  await swapSheet(page).getByRole("button", { name: "Strict press · Thu · no max yet: set it first" }).click();
  const maxSheet = page.getByRole("dialog", { name: "Strict press" });
  await expect(swapSheet(page)).toHaveCount(0);
  await maxSheet.getByRole("textbox", { name: "New max" }).fill("135");
  await maxSheet.getByRole("button", { name: "Set max and swap" }).click();
  await expect(maxSheet).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Strict press set \d+:/ })).toHaveCount(4);
  await expect(mainLift(page).locator("[data-swapped]")).toHaveText("In place of Deadlift · this session only");
  await expect(toastMessage(page, "Strict press in place of Deadlift today")).toBeVisible();
  await expectSynced(page);
  const s = (await saved(page, TUE))!;
  expect(mainOf(s).exerciseId).toBe(await idOf(page, "Strict press"));
  expect(mainOf(s).sets.map((x) => [x.targetWeight, x.amrap])).toEqual([
    [105, false],
    [95, false],
    [90, false],
    [85, true],
  ]);
  expect(s.primaryMaxLb).toBe(135);
  // Undo puts the deadlift back; the max stays.
  await notifications(page).getByRole("button", { name: "Undo" }).click();
  await expect(page.getByRole("button", { name: /^Deadlift set \d+:/ })).toHaveCount(4);
  await expectSynced(page);
  const data = await serverData(page);
  expect(data.maxEntries.some((m) => m.exerciseId === mainOf(s).exerciseId && m.valueLb === 135)).toBe(true);
});

test("'Another exercise': the main lift is skipped and a dumbbell press added with hand-entered loads", async ({ page }) => {
  await page.getByRole("button", { name: "Swap Deadlift for another lift" }).click();
  await swapSheet(page).getByRole("button", { name: /^Another exercise/ }).click();
  const add = page.getByRole("dialog", { name: "Add exercise" });
  await expect(swapSheet(page)).toHaveCount(0);
  await add.getByRole("textbox", { name: "Search or create exercise" }).fill("DB shoulder press");
  await add.getByRole("button", { name: /Create & add/ }).click();
  await expect(add).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Unskip Deadlift" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^DB shoulder press set 1:/ })).toBeVisible();
  await expectSynced(page);
  const s = (await saved(page, TUE))!;
  const main = s.blocks.find((b) => b.kind === "primary")!;
  expect([main.skipped, main.exercises[0]!.exerciseId]).toEqual([true, await idOf(page, "Deadlift")]);
  const press = await idOf(page, "DB shoulder press");
  expect(s.blocks.some((b) => b.kind === "accessory" && b.exercises.some((e) => e.exerciseId === press))).toBe(true);
});

test("Friday of the deload week: Thursday's Strict press added for the session, 4 × 10 from its max; removed again", async ({ page }) => {
  await callApi(page, "POST", `/api/exercises/${await idOf(page, "Strict press")}/maxes`, {
    date: "2026-10-25",
    valueLb: 135,
    source: "manual",
    note: null,
  });
  await page.clock.setSystemTime(at(DELOAD_FRI));
  await page.goto("/train");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Carries & pull");
  await page.getByRole("button", { name: "Add one for this session" }).click();
  const sheet = page.getByRole("dialog", { name: "Add a main lift" });
  await expect(sheet.getByRole("heading", { level: 4 }).first()).toHaveText("Still to do this week");
  // Nothing done this week: every lift is still to do, the latest day first.
  await expect(sheet.locator("[data-swap-to]").first()).toHaveAccessibleName("Strict press · Thu");
  await sheet.getByRole("button", { name: "Strict press · Thu" }).click();
  await expect(sheet).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Strict press set \d+:/ })).toHaveCount(4);
  await expect(mainLift(page).locator("[data-added]")).toHaveText("Added for this session");
  await expect(toastMessage(page, "Strict press added for this session")).toBeVisible();
  await expectSynced(page);
  const s = (await saved(page, DELOAD_FRI))!;
  expect([s.label, s.deload, s.planSig]).toEqual(["Carries & pull", true, null]);
  expect(mainOf(s).sets.map((x) => [x.targetReps, x.targetWeight, x.amrap])).toEqual(Array.from({ length: 4 }, () => [10, 85, false]));
  expect(s.primaryMaxLb).toBe(135);

  // Removed from its header (nothing logged), and it comes back with Undo.
  await page.getByRole("button", { name: "Remove Strict press from this session" }).click();
  await expect(page.getByRole("button", { name: /^Strict press set/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add one for this session" })).toBeVisible();
  await expect(toastMessage(page, "Strict press removed")).toBeVisible();
  // The add's toast gave way to it.
  await expect(toastMessage(page, "Strict press added for this session")).toHaveCount(0);
  await notifications(page).getByRole("button", { name: "Undo" }).click();
  await expect(page.getByRole("button", { name: /^Strict press set \d+:/ })).toHaveCount(4);
  await expectSynced(page);
  expect(mainOf((await saved(page, DELOAD_FRI))!).exerciseId).toBe(await idOf(page, "Strict press"));
});

test.describe("at 320 px", () => {
  test.use({ viewport: { width: 320, height: 640 } });

  test("a long name gives way: swap and skip rest stay on one line beside it", async ({ page }) => {
    await callApi(page, "PATCH", `/api/exercises/${await idOf(page, "Back squat")}`, { name: "Safety bar squat" });
    await page.goto("/train");
    await page.getByRole("button", { name: "Swap Deadlift for another lift" }).click();
    await swapSheet(page).getByRole("button", { name: "Safety bar squat · Wed" }).click();
    await page.getByRole("button", { name: /^Safety bar squat set 1:/ }).click();
    const name = mainLift(page).locator("[data-main-name]");
    await expect(name).toHaveText("Safety bar squat");
    const swap = page.locator('[data-main-control="swap"]');
    const skipRest = page.locator('[data-main-control="skip-rest"]');
    await expect(swap).toHaveText("swap");
    const [n, a, b] = await Promise.all([name.boundingBox(), swap.boundingBox(), skipRest.boundingBox()]);
    // One line: the controls' centres level with the name's, the name ending before swap begins.
    expect(Math.abs(a!.y + a!.height / 2 - (n!.y + n!.height / 2))).toBeLessThan(4);
    expect(Math.abs(b!.y + b!.height / 2 - (a!.y + a!.height / 2))).toBeLessThan(1);
    expect(n!.x + n!.width).toBeLessThanOrEqual(a!.x + 1);
    expect(b!.x + b!.width).toBeLessThanOrEqual(320);
  });
});
