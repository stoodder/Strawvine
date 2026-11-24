/**
 * Swapping the main lift for one session (SPEC §6.5): on Tuesday of week 1 (Pull, deadlift) the
 * back squat is done instead — its sets from the squat's max, Pull's accessories kept — logged
 * (the AMRAP bump goes to the squat) and finished; Wednesday (Legs, back squat) then offers the
 * deadlift ("Back squat was done Tue. Do Deadlift today?"), derived and never stored; next
 * Tuesday is the deadlift again with Tuesday's accessories. Plus the swap's Undo and its refusal
 * once a main-lift set is logged. Onboarded Sunday 2026-10-25 (bench 225); squat 315 and deadlift
 * 405 are added here, with a Pull and a Legs session the week before to carry accessories from.
 */
import type { Page } from "@playwright/test";
import type { Bootstrap, Session } from "../src/shared/schemas";
import { expect, expectSynced, notifications, onboardedOn, serverData, test, toastMessage } from "./helpers";

const TUE = "2026-10-27";
const WED = "2026-10-28";
const NEXT_TUE = "2026-11-03";
const at = (iso: string) => new Date(`${iso}T10:00:00`);

/** Squat and deadlift maxes; a barbell row on last week's Pull, a walking lunge on its Legs. */
async function seed(page: Page) {
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await page.request.fetch(path, { method, ...(body !== undefined ? { data: body } : {}) });
    expect(res.ok(), `${method} ${path} → ${res.status()} ${await res.text()}`).toBe(true);
    return res.status() === 204 ? null : res.json();
  };
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
    /^Strict press\s*Thu · no max yet$/,
    /^Front squat\s*no max yet$/,
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
