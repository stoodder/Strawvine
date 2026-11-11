/**
 * Done exercises fold to a summary row on Train (docs/SPEC.md §6.5, "Done exercises fold").
 *
 * A 15-set Monday (bench 4 with the AMRAP, two accessories of 3, a superset of 3 + 2), by touch, at
 * phone sizes. Nothing ever moves under a thumb and no tap is ever dropped: logging a block's last
 * set folds nothing, and a tap aimed at the next thing right after it lands. Done blocks fold, in
 * one step, when the day is opened (a reload, another date), when the Train tab is come back to,
 * and when the app returns to the foreground — the page held in place around what was on screen —
 * and by hand (the folded row opens, the open block's header folds). The state is the view's
 * alone: nothing of it reaches the session, the outbox or the server.
 */
import AxeBuilder from "@axe-core/playwright";
import type { Locator, Page } from "@playwright/test";
import {
  expect,
  expectSynced,
  foldedRow as folded,
  foldToggle as toggle,
  hideAmbientGlow,
  MONDAY,
  MONDAY_ISO,
  notifications,
  onboardedOn,
  openFolded,
  pageOverflow,
  serverData,
  test,
  unsentEdits,
} from "./helpers";

type Part = "all" | "one-left" | "none";
interface Seed {
  /** Bench press, 6 / 8 / 10 / 12+ (AMRAP). "two": the first two logged. */
  main?: Part | "two";
  /** Dumbbell incline press, 3 × 10 at 60 lb. */
  inc?: Part;
  /** Lateral raise, 3 × 12 at 20 lb ("all": the last one done for 10). */
  lat?: Part;
  /** Superset A: Plank 3 × 30 s, Hanging leg raise 2 × 12 (both unweighted). "one-left": all but the leg raise's last set. */
  core?: Part;
  completed?: boolean;
}

/** Write Monday's session straight to the server (the page loads it next). */
async function seed(page: Page, { main = "none", inc = "none", lat = "none", core = "none", completed = false }: Seed) {
  const call = async (method: string, path: string, data?: unknown) => {
    const res = await page.request.fetch(path, {
      method,
      headers: { "cache-control": "no-cache" },
      ...(data !== undefined ? { data } : {}),
    });
    expect(res.ok(), `${method} ${path} → ${res.status()}`).toBe(true);
    return res.json();
  };
  const boot = await call("GET", "/api/bootstrap");
  const ensure = async (name: string, body: object): Promise<{ id: number }> =>
    boot.exercises.find((e: { name: string }) => e.name === name) ?? (await call("POST", "/api/exercises", { name, ...body }));
  const bench = boot.exercises.find((e: { name: string }) => e.name === "Bench press");
  const incline = await ensure("Dumbbell incline press", { category: "accessory", measure: "reps", weighted: true });
  const raise = await ensure("Lateral raise", { category: "accessory", measure: "reps", weighted: true });
  const plank = await ensure("Plank", { category: "core", measure: "seconds", weighted: false });
  const legRaise = await ensure("Hanging leg raise", { category: "core", measure: "reps", weighted: false });
  type S = {
    id: string;
    targetReps: number;
    targetWeight: number | null;
    reps: number | null;
    weight: number | null;
    done: boolean;
    amrap: boolean;
    appliedProgressionLb: null;
  };
  const set = (id: string, reps: number, weight: number | null, amrap = false): S => ({
    id,
    targetReps: reps,
    targetWeight: weight,
    reps: null,
    weight: null,
    done: false,
    amrap,
    appliedProgressionLb: null,
  });
  const log = (s: S, reps = s.targetReps): S => ({ ...s, done: true, reps, weight: s.targetWeight });
  const part = (sets: S[], p: Part | "two") =>
    sets.map((s, i) => (p === "all" || (p === "one-left" && i < sets.length - 1) || (p === "two" && i < 2) ? log(s) : s));
  const latSets = part([set("l1", 12, 20), set("l2", 12, 20), set("l3", 12, 20)], lat);
  await call("PUT", `/api/sessions/${MONDAY_ISO}`, {
    date: MONDAY_ISO,
    label: "Push",
    cycle: 1,
    week: 1,
    deload: false,
    primaryMaxLb: 225,
    blocks: [
      {
        id: "main",
        kind: "primary",
        exercises: [
          {
            exerciseId: bench.id,
            measure: "reps",
            sets: part([set("m1", 6, 170), set("m2", 8, 160), set("m3", 10, 150), set("m4", 12, 140, true)], main),
          },
        ],
      },
      {
        id: "inc",
        kind: "accessory",
        exercises: [
          { exerciseId: incline.id, measure: "reps", sets: part([set("i1", 10, 60), set("i2", 10, 60), set("i3", 10, 60)], inc) },
        ],
      },
      // Done in full, the last set came up short: 12 / 12 / 10.
      {
        id: "lat",
        kind: "accessory",
        exercises: [
          {
            exerciseId: raise.id,
            measure: "reps",
            sets: lat === "all" ? [latSets[0]!, latSets[1]!, { ...latSets[2]!, reps: 10 }] : latSets,
          },
        ],
      },
      {
        id: "core",
        kind: "accessory",
        exercises: [
          {
            exerciseId: plank.id,
            measure: "seconds",
            sets: part([set("c1", 30, null), set("c2", 30, null), set("c3", 30, null)], core === "none" ? "none" : "all"),
          },
          { exerciseId: legRaise.id, measure: "reps", sets: part([set("h1", 12, null), set("h2", 12, null)], core) },
        ],
      },
    ],
    notes: "",
    completedAt: completed ? `${MONDAY_ISO}T18:30:00.000Z` : null,
    planSig: null,
  });
}

/**
 * Open Train on the seeded Monday. The session comes from the server after the page has loaded, and
 * nothing folds while a page is in use — so the Train tab is left and come back to (a moment at
 * which done blocks fold): what was seeded as done is folded, the rest open.
 */
async function openTrain(page: Page) {
  await page.goto("/train");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Push/);
  await expect(page.locator('[data-block="core"]')).toBeVisible();
  await expectSynced(page);
  await leaveAndReturn(page);
}

/** To another tab and back to Train: the same page, the screen shown anew. */
async function leaveAndReturn(page: Page) {
  await page.getByRole("link", { name: "Today" }).tap();
  await expect(page.getByRole("link", { name: "Today" })).toHaveAttribute("aria-current", "page");
  await page.getByRole("link", { name: "Train" }).tap();
  await expect(page.locator('[data-block="core"]')).toBeVisible();
}

/** The app comes back to the foreground (the phone unlocked between sets). */
const foreground = (page: Page) => page.evaluate(() => void document.dispatchEvent(new Event("visibilitychange")));

/** A set's check ("Lateral raise set 3: …"). */
const check = (page: Page, name: string, n: number) => page.getByRole("button", { name: new RegExp(`^${name} set ${n}:`) });
const rows = (page: Page, name: string) => page.getByRole("list", { name: `${name} sets` });
const restTimer = (page: Page) => page.getByRole("group", { name: "Rest timer" });
const dockFinish = (page: Page) => notifications(page).getByRole("button", { name: /^Finish · / });

/** Scroll the page so that `target`'s centre is at viewport y — where a thumb would be. */
async function placeAt(page: Page, target: Locator, y: number) {
  await target.evaluate((el, at) => {
    const r = el.getBoundingClientRect();
    window.scrollBy(0, r.top + r.height / 2 - at);
  }, y);
  await page.waitForTimeout(150);
}

/** Where the blocks are: each one's top edge and height in the viewport, with the page's scroll position. */
const layout = (page: Page) =>
  page.evaluate(() => ({
    scrollY: Math.round(window.scrollY),
    blocks: Object.fromEntries(
      [...document.querySelectorAll<HTMLElement>("[data-fold]")].map((el) => {
        const r = el.getBoundingClientRect();
        return [el.dataset.fold!, { top: Math.round(r.top), height: Math.round(r.height), folded: el.hasAttribute("data-folded") }];
      }),
    ),
  }));

/**
 * Watch the blocks every frame for `ms`: the distinct sets of heights seen, in order. (Heights, not
 * positions: after a set is logged the page may scroll by itself to keep the next one clear of the
 * dock — that moves the page, it doesn't change a block.)
 */
function watchHeights(page: Page, ms: number) {
  return page.evaluate(
    (ms) =>
      new Promise<string[]>((resolve) => {
        const seen: string[] = [];
        const t0 = performance.now();
        const sample = () => {
          const now = [...document.querySelectorAll<HTMLElement>("[data-fold]")]
            .map((el) => `${el.dataset.fold}:${Math.round(el.getBoundingClientRect().height)}${el.hasAttribute("data-folded") ? "f" : ""}`)
            .join(" ");
          if (seen.at(-1) !== now) seen.push(now);
          if (performance.now() - t0 < ms) requestAnimationFrame(sample);
          else resolve(seen);
        };
        requestAnimationFrame(sample);
      }),
    ms,
  );
}

/** Tap `completing` (a block's last open set), then `next` `ms` later — the delay measured from the first tap. */
async function tapThenTap(page: Page, completing: Locator, next: Locator, ms: number) {
  await completing.tap();
  const t0 = Date.now();
  await expect(completing).toHaveAttribute("aria-pressed", "true");
  await page.waitForTimeout(Math.max(0, ms - (Date.now() - t0)));
  await next.tap();
}

/** What the server holds for Monday: each block's sets, logged (x) or open (o). */
async function serverSets(page: Page) {
  const { sessions } = await serverData(page);
  const session = sessions.find((s) => s.date === MONDAY_ISO)!;
  return Object.fromEntries(
    session.blocks.map((b) => [b.id, b.exercises.map((e) => e.sets.map((s) => (s.done ? "x" : "o")).join("")).join("|")]),
  );
}

/** What a tap at a point would reach: the control there (its name), or the tag of what is. */
const controlAt = (page: Page, at: { x: number; y: number }) =>
  page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y);
    const control = el?.closest("button, a, textarea, input");
    return control
      ? (control.getAttribute("aria-label") ?? control.textContent ?? "").trim().slice(0, 60)
      : (el?.tagName.toLowerCase() ?? null);
  }, at);

test.beforeEach(async ({ page }) => {
  await onboardedOn(page, MONDAY);
});

for (const [width, height] of [
  [390, 844],
  [320, 568],
] as const) {
  test.describe(`${width}×${height}`, () => {
    test.use({ viewport: { width, height } });

    test("logging an exercise's last set folds nothing — and the taps that follow it land, at any moment", async ({ page }) => {
      await seed(page, { main: "two", inc: "one-left", lat: "one-left" });
      await openTrain(page);
      // Nothing is done yet: nothing is folded.
      await expect(page.locator("[data-folded]")).toHaveCount(0);
      const before = await layout(page);

      // The lateral raise's last set, where a thumb would be; then the next exercise's first set 700 ms later: logged.
      await placeAt(page, check(page, "Lateral raise", 3), Math.round(height * 0.4));
      await tapThenTap(page, check(page, "Lateral raise", 3), check(page, "Plank", 1), 700);
      await expect(check(page, "Plank", 1)).toHaveAttribute("aria-pressed", "true");
      // Two seconds on, the exercise that was just completed is as it was: its rows, nothing folded, no block a pixel taller or shorter.
      const heights = await watchHeights(page, 2000);
      expect(heights, `block heights over two seconds: ${heights.join("  →  ")}`).toHaveLength(1);
      await expect(page.locator("[data-folded]")).toHaveCount(0);
      await expect(rows(page, "Lateral raise").getByRole("listitem")).toHaveCount(3);
      expect((await layout(page)).blocks.lat!.height).toBe(before.blocks.lat!.height);
      // Done and open, it offers its fold: the name in its header is the toggle.
      await expect(toggle(page, "Lateral raise", true)).toBeVisible();

      // The incline press's last set; the superset's second set 850 ms later: logged.
      await placeAt(page, check(page, "Dumbbell incline press", 3), Math.round(height * 0.4));
      await tapThenTap(page, check(page, "Dumbbell incline press", 3), check(page, "Plank", 2), 850);
      await expect(check(page, "Plank", 2)).toHaveAttribute("aria-pressed", "true");

      // The superset's last set (it completes the whole superset); a main-lift set a second later: logged.
      for (const [name, n] of [
        ["Plank", 3],
        ["Hanging leg raise", 1],
      ] as const)
        await check(page, name, n).tap();
      await tapThenTap(page, check(page, "Hanging leg raise", 2), check(page, "Bench press", 3), 1000);
      await expect(check(page, "Bench press", 3)).toHaveAttribute("aria-pressed", "true");

      // And the page's own Finish button, 900 ms after a completing tap: it answers (the AMRAP is still open, so it asks).
      await check(page, "Hanging leg raise", 2).tap();
      await expect(check(page, "Hanging leg raise", 2)).toHaveAttribute("aria-pressed", "false");
      await tapThenTap(page, check(page, "Hanging leg raise", 2), page.getByRole("button", { name: "Finish session" }), 900);
      await expect(page.getByRole("group", { name: /Finish with 1 set unlogged\?/ })).toBeVisible();

      // Three exercises done on this page, and not one folded.
      await expect(page.locator("[data-folded]")).toHaveCount(0);
      await expectSynced(page);
      expect(await serverSets(page)).toEqual({ main: "xxxo", inc: "xxx", lat: "xxx", core: "xxx|xx" });
    });

    test("back in the foreground the done exercises fold in one step, and what was on screen stays where it was", async ({ page }) => {
      await seed(page, { main: "two", inc: "one-left", lat: "one-left" });
      await openTrain(page);
      await check(page, "Dumbbell incline press", 3).tap();
      await check(page, "Lateral raise", 3).tap();
      // On to the superset: its first set where a thumb would be, the two done exercises above it (partly off screen).
      await placeAt(page, check(page, "Plank", 1), Math.round(height * 0.5));
      const before = await layout(page);
      expect(before.blocks.inc!.folded || before.blocks.lat!.folded).toBe(false);

      // The phone was locked for the rest, and is unlocked again.
      const during = watchHeights(page, 600);
      await foreground(page);
      const seen = await during;
      const after = await layout(page);
      // Both done exercises are their summary rows now (≥ 44 px, a fraction of what they were) …
      await expect(folded(page, "Dumbbell incline press")).toContainText("3 × 10 · 60 lb");
      await expect(folded(page, "Lateral raise")).toContainText("3 × 12 · 20 lb");
      for (const id of ["inc", "lat"]) {
        expect(after.blocks[id]!.folded).toBe(true);
        expect(after.blocks[id]!.height).toBeGreaterThanOrEqual(44);
        expect(after.blocks[id]!.height).toBeLessThan(before.blocks[id]!.height / 3);
      }
      // … in one step: the page was only ever as before, or as after.
      expect(seen.length, `layouts seen: ${seen.join("  →  ")}`).toBeLessThanOrEqual(2);
      // The superset — what the athlete was looking at — hasn't moved: the page scrolled up by what folded away above it.
      const gone = before.blocks.inc!.height - after.blocks.inc!.height + (before.blocks.lat!.height - after.blocks.lat!.height);
      expect(Math.abs(after.blocks.core!.top - before.blocks.core!.top)).toBeLessThanOrEqual(1);
      expect(Math.abs(before.scrollY - after.scrollY - gone)).toBeLessThanOrEqual(1);
      // The main lift, not done, is open as ever; and the very next tap lands.
      expect(after.blocks.main!.folded).toBe(false);
      await check(page, "Plank", 1).tap();
      await expect(check(page, "Plank", 1)).toHaveAttribute("aria-pressed", "true");
      // A second return with nothing new to fold changes nothing.
      const again = watchHeights(page, 400);
      await foreground(page);
      expect(await again).toHaveLength(1);
    });

    test("a superset folds as one — by hand from its header once its last member is done; nothing folds by itself, and Finish is offered", async ({
      page,
    }) => {
      await seed(page, { main: "all", inc: "all", lat: "all", core: "one-left" });
      await openTrain(page);
      // What was done before the day was opened is folded; the superset, one set short, is open — members and all.
      for (const name of ["Bench press", "Dumbbell incline press", "Lateral raise"]) await expect(folded(page, name)).toBeVisible();
      await expect(folded(page, "Lateral raise")).toContainText("12/12/10 · 20 lb");
      await expect(rows(page, "Plank").getByRole("listitem")).toHaveCount(3);
      await expect(folded(page, "Plank")).toHaveCount(0);
      await expect(toggle(page, "Superset A", true)).toHaveCount(0);

      // Its last set. Every set is logged now: Finish is offered — from the dock, or by the page's own button if that is on screen.
      await placeAt(page, check(page, "Hanging leg raise", 2), Math.round(height * 0.45));
      await check(page, "Hanging leg raise", 2).tap();
      await expect(check(page, "Hanging leg raise", 2)).toHaveAttribute("aria-pressed", "true");
      const pageFinish = page.getByRole("button", { name: "Finish session" });
      const onScreen = () =>
        pageFinish.evaluate((el) => {
          const r = el.getBoundingClientRect();
          const nav = document.querySelector('nav[aria-label="Primary"]')!.getBoundingClientRect();
          return r.bottom > 0 && r.top < nav.top;
        });
      await expect(async () => expect(await dockFinish(page).isVisible()).toBe(!(await onScreen()))).toPass();
      // Nothing folded by itself: the superset is open, and now offers its fold.
      await expect(rows(page, "Hanging leg raise").getByRole("listitem")).toHaveCount(2);
      await expect(toggle(page, "Superset A", true)).toBeVisible();

      // Folded by hand it is one row: its members, each with its result.
      await toggle(page, "Superset A", true).tap();
      const row = folded(page, "Superset A");
      await expect(row).toBeVisible();
      await expect(row).toContainText(/A1\s*Plank/);
      await expect(row).toContainText("3 × 30 s");
      await expect(row).toContainText(/A2\s*Hanging leg raise/);
      await expect(row).toContainText("2 × 12 reps");
      await expect(rows(page, "Plank")).toHaveCount(0);

      // Open again at once, the superset is all there: its own sheet, each member's options.
      await row.tap();
      await expect(rows(page, "Hanging leg raise").getByRole("listitem")).toHaveCount(2);
      await page.getByRole("button", { name: "Manage Superset A" }).tap();
      const manage = page.getByRole("dialog", { name: "Superset A" });
      await expect(manage.getByRole("button", { name: /^Remove Plank/ })).toBeVisible();
      await manage.getByRole("button", { name: "Close" }).tap();
      await expect(manage).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Hanging leg raise options" })).toBeVisible();

      await expectSynced(page);
      expect(await serverSets(page)).toEqual({ main: "xxxx", inc: "xxx", lat: "xxx", core: "xxx|xx" });
    });
  });
}

for (const [width, height] of [
  [320, 568],
  [375, 667],
] as const)
  test(`the dock's Finish stays put after the last set, and doesn't come or go under a tap that follows a fold by hand (${width}×${height})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await seed(page, { main: "all", inc: "all", lat: "all", core: "one-left" });
    await openTrain(page);
    const pageFinish = page.getByRole("button", { name: "Finish session" });
    /** Whether the page's own Finish button is on screen (above the nav). */
    const onScreen = () =>
      pageFinish.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const nav = document.querySelector('nav[aria-label="Primary"]')!.getBoundingClientRect();
        return r.bottom > 0 && r.top < nav.top;
      });
    const centre = async (l: Locator) => {
      const b = (await l.boundingBox())!;
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    };

    await placeAt(page, check(page, "Hanging leg raise", 2), Math.round(height * 0.45));
    await check(page, "Hanging leg raise", 2).tap();
    // The page's own Finish is off screen: the dock offers it, under the rest pill.
    await expect(dockFinish(page)).toBeVisible();
    await expect(restTimer(page)).toBeVisible();
    let at = await centre(dockFinish(page));
    // For a second and a half after the last set's tap the pill is what is at that spot — nothing takes its place.
    const under: string[] = [];
    for (const until = Date.now() + 1500; Date.now() < until; await page.waitForTimeout(50)) under.push((await controlAt(page, at)) ?? "");
    expect([...new Set(under)]).toEqual(["Finish · 15/15 sets"]);

    // Folding the superset by hand, near the top of the screen, makes the page short enough for its own Finish button to be on screen …
    let rest = Math.round((await restTimer(page).boundingBox())!.y);
    await placeAt(page, toggle(page, "Superset A", true), 40);
    await toggle(page, "Superset A", true).tap();
    await expect(folded(page, "Superset A")).toBeVisible();
    expect(await onScreen(), "the page's Finish button after the fold").toBe(true);
    // … and still the dock is as it was for a tap that follows: the pill there, the rest pill above it where it was.
    await page.waitForTimeout(300);
    expect(await controlAt(page, at)).toBe("Finish · 15/15 sets");
    expect(Math.round((await restTimer(page).boundingBox())!.y)).toBe(rest);
    // Only once that moment has passed does the dock leave Finish to the page's button.
    await expect(dockFinish(page)).toHaveCount(0, { timeout: 5000 });

    // The other way round. The dock holds the rest pill alone; opening the superset pushes the page's button off screen …
    rest = Math.round((await restTimer(page).boundingBox())!.y);
    const restAt = await centre(restTimer(page));
    await folded(page, "Superset A").tap();
    await expect(rows(page, "Plank").getByRole("listitem")).toHaveCount(3);
    expect(await onScreen(), "the page's Finish button after opening").toBe(false);
    // … and the dock doesn't take Finish in under a tap aimed at the rest pill: that tap reaches the rest pill.
    await page.waitForTimeout(300);
    expect(Math.round((await restTimer(page).boundingBox())!.y)).toBe(rest);
    expect(await controlAt(page, restAt)).not.toMatch(/^Finish/);
    await page.touchscreen.tap(restAt.x, restAt.y);
    await expect(page.getByRole("heading", { name: "Session complete" })).toHaveCount(0);
    await expect(dockFinish(page)).toBeVisible({ timeout: 5000 });

    // And a tap aimed at the dock's Finish right after a fold by hand finishes the session.
    at = await centre(dockFinish(page));
    await toggle(page, "Superset A", true).tap();
    await expect(folded(page, "Superset A")).toBeVisible();
    await page.waitForTimeout(250);
    await page.touchscreen.tap(at.x, at.y);
    await expect(page.getByRole("heading", { name: "Session complete" })).toBeVisible();
    await expectSynced(page);
    expect((await serverData(page)).sessions.find((s) => s.date === MONDAY_ISO)!.completedAt).not.toBeNull();
  });

test("by hand: a folded row opens and an open header folds, in one step — and a tap on a set right after lands", async ({ page }) => {
  await seed(page, { main: "all", inc: "all", lat: "one-left" });
  await openTrain(page);
  const row = folded(page, "Dumbbell incline press");
  await expect(row).toBeVisible();
  await placeAt(page, row, 300);

  // Open it: one step (two layouts at most), its top edge where the row's was.
  const before = await layout(page);
  const opening = watchHeights(page, 500);
  await row.tap();
  const steps = await opening;
  expect(steps.length, `layouts seen: ${steps.join("  →  ")}`).toBeLessThanOrEqual(2);
  const open = await layout(page);
  expect(open.blocks.inc!.top).toBe(before.blocks.inc!.top);
  expect(open.scrollY).toBe(before.scrollY);
  await expect(rows(page, "Dumbbell incline press").getByRole("listitem")).toHaveCount(3);
  // Straight away (well inside 400 ms), a set's check: it unlogs — the tap landed. And logs again.
  await check(page, "Dumbbell incline press", 2).tap();
  await expect(check(page, "Dumbbell incline press", 2)).toHaveAttribute("aria-pressed", "false");
  await expect(toggle(page, "Dumbbell incline press", true)).toHaveCount(0);
  await check(page, "Dumbbell incline press", 2).tap();
  await expect(check(page, "Dumbbell incline press", 2)).toHaveAttribute("aria-pressed", "true");
  // Everything it had is there: "+ set", and the options with all their actions (nothing left to log).
  await expect(page.getByRole("button", { name: "Add Dumbbell incline press set" })).toBeVisible();
  await page.getByRole("button", { name: "Dumbbell incline press options" }).tap();
  const sheet = page.getByRole("dialog", { name: "Dumbbell incline press" });
  for (const name of [
    /^Edit set 3: /,
    "Delete set 3",
    /^Superset with another exercise/,
    /^Skip today/,
    /^Edit exercise/,
    /^Remove — also from future Mondays/,
  ])
    await expect(sheet.getByRole("button", { name })).toBeVisible();
  await expect(sheet.getByRole("button", { name: /^Log remaining sets/ })).toHaveCount(0);
  await sheet.getByRole("button", { name: "Close" }).tap();
  await expect(sheet).toHaveCount(0);

  // Its name folds it again, in one step, around its top edge — and the next exercise's set, tapped right after, is logged.
  await placeAt(page, toggle(page, "Dumbbell incline press", true), 200);
  const reopened = await layout(page);
  const folding = watchHeights(page, 500);
  await toggle(page, "Dumbbell incline press", true).tap();
  expect((await folding).length).toBeLessThanOrEqual(2);
  await expect(folded(page, "Dumbbell incline press")).toBeVisible();
  const refolded = await layout(page);
  expect(refolded.blocks.inc!.top).toBe(reopened.blocks.inc!.top);
  expect(refolded.scrollY).toBe(reopened.scrollY);
  await check(page, "Lateral raise", 3).tap();
  await expect(check(page, "Lateral raise", 3)).toHaveAttribute("aria-pressed", "true");

  // Unlogging a set of an opened exercise leaves it open, and stops the rest that set started.
  await expect(restTimer(page)).toBeVisible();
  await check(page, "Lateral raise", 3).tap();
  await expect(check(page, "Lateral raise", 3)).toHaveAttribute("aria-pressed", "false");
  await expect(restTimer(page)).toHaveCount(0);
  await expect(rows(page, "Lateral raise").getByRole("listitem")).toHaveCount(3);
  await expectSynced(page);
  expect(await serverSets(page)).toEqual({ main: "xxxx", inc: "xxx", lat: "xxo", core: "ooo|oo" });
});

test("a set logged on another device arrives: its exercise doesn't fold while this page is in use — only at the next return", async ({
  page,
}) => {
  await seed(page, { main: "two", inc: "all", lat: "one-left" });
  await openTrain(page);
  // The incline press, done before, is a folded row; the superset is what is being worked on.
  await expect(folded(page, "Dumbbell incline press")).toBeVisible();
  await placeAt(page, check(page, "Plank", 1), 420);
  await expect(check(page, "Lateral raise", 3)).toHaveAttribute("aria-pressed", "false");
  // The other device logs the last lateral raise; this one hears of it (it revalidates on a return to the app).
  await seed(page, { main: "two", inc: "all", lat: "all" });
  await page.waitForTimeout(5200);
  await foreground(page);
  await expect(check(page, "Lateral raise", 3)).toHaveAttribute("aria-pressed", "true");
  // Done now — and open, where it was. Two seconds on, still; and a tap on the next set lands.
  const still = await watchHeights(page, 2000);
  expect(still, `layouts seen: ${still.join("  →  ")}`).toHaveLength(1);
  await expect(folded(page, "Lateral raise")).toHaveCount(0);
  await expect(rows(page, "Lateral raise").getByRole("listitem")).toHaveCount(3);
  await check(page, "Plank", 1).tap();
  await expect(check(page, "Plank", 1)).toHaveAttribute("aria-pressed", "true");
  // The next return to the foreground folds it — and the superset stays where it is: the page is held around
  // the block being worked on, not around the folded row above it.
  const before = await layout(page);
  await foreground(page);
  await expect(folded(page, "Lateral raise")).toBeVisible();
  const after = await layout(page);
  expect(Math.abs(after.blocks.core!.top - before.blocks.core!.top)).toBeLessThanOrEqual(1);
});

test("the done exercises fold when the day is opened: a reload, the Train tab come back to, another date — one opened by hand is kept while the page lives", async ({
  page,
}) => {
  await seed(page, { main: "two", inc: "one-left", lat: "one-left" });
  await openTrain(page);
  await check(page, "Dumbbell incline press", 3).tap();
  await check(page, "Lateral raise", 3).tap();
  await expect(page.locator("[data-folded]")).toHaveCount(0);

  // To another tab and back: both are folded.
  await leaveAndReturn(page);
  await expect(folded(page, "Dumbbell incline press")).toBeVisible();
  await expect(folded(page, "Lateral raise")).toBeVisible();
  await expect(rows(page, "Bench press").getByRole("listitem")).toHaveCount(4);

  // One opened by hand stays open through another tab, and through a return to the foreground.
  await openFolded(page, "Dumbbell incline press");
  await leaveAndReturn(page);
  await expect(rows(page, "Dumbbell incline press").getByRole("listitem")).toHaveCount(3);
  await foreground(page);
  await expect(rows(page, "Dumbbell incline press").getByRole("listitem")).toHaveCount(3);
  await expect(folded(page, "Lateral raise")).toBeVisible();

  // Another date and back, in the same screen: the day is opened anew — and a tap right after the switch lands.
  await openFolded(page, "Lateral raise");
  await toggle(page, "Dumbbell incline press", true).tap();
  await page.getByRole("button", { name: "Previous day" }).tap();
  await expect(page.locator('[data-block="core"]')).toHaveCount(0);
  await page.getByRole("button", { name: "Next day" }).tap();
  await check(page, "Bench press", 3).tap();
  await expect(check(page, "Bench press", 3)).toHaveAttribute("aria-pressed", "true");
  // What was opened by hand is open, what was folded by hand is folded.
  await expect(rows(page, "Lateral raise").getByRole("listitem")).toHaveCount(3);
  await expect(folded(page, "Dumbbell incline press")).toBeVisible();

  // Nothing of this was queued, sent or stored: the server holds the sets, and only the sets.
  await expectSynced(page);
  expect(await unsentEdits(page)).toBe(0);
  const stored = await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]));
  expect(stored).not.toMatch(/fold|collaps|expand/i);
  const session = (await serverData(page)).sessions.find((s) => s.date === MONDAY_ISO)!;
  expect(JSON.stringify(session)).not.toMatch(/fold|collaps|expand|"open"/i);
  expect(await serverSets(page)).toEqual({ main: "xxxo", inc: "xxx", lat: "xxx", core: "ooo|oo" });

  // A reload is a new page: every done exercise starts folded, whatever was open.
  await page.reload();
  await expect(folded(page, "Dumbbell incline press")).toBeVisible();
  await expect(folded(page, "Lateral raise")).toBeVisible();
  await expect(rows(page, "Lateral raise")).toHaveCount(0);
  await expect(rows(page, "Bench press").getByRole("listitem")).toHaveCount(4);
});

test("the main lift: nothing folds after its AMRAP; folded, a beaten target keeps its gold — tag and check", async ({ page }) => {
  await seed(page, { main: "one-left" });
  await openTrain(page);
  await check(page, "Bench press", 4).tap();
  const amrap = page.getByRole("dialog", { name: /AMRAP/ });
  for (let i = 0; i < 2; i++) await amrap.getByRole("button", { name: "Increase reps" }).tap();
  await amrap.getByRole("button", { name: /^Log \d+ reps$/ }).tap();
  await expect(amrap.getByText("Target beaten")).toBeVisible();
  await amrap.getByRole("button", { name: "Apply" }).tap();
  await expect(amrap).toHaveCount(0);
  // Done — and open as it was, with its rows and the fold in its header; the first accessory's first set, tapped at once, is logged.
  await check(page, "Dumbbell incline press", 1).tap();
  await expect(check(page, "Dumbbell incline press", 1)).toHaveAttribute("aria-pressed", "true");
  await page.waitForTimeout(1500);
  await expect(rows(page, "Bench press").getByRole("listitem")).toHaveCount(4);
  await expect(toggle(page, "Bench press", true)).toBeVisible();

  // At the very top of the page, back in the foreground: it folds, with nothing to scroll.
  await page.evaluate(() => window.scrollTo(0, 0));
  await foreground(page);
  const row = folded(page, "Bench press");
  await expect(row).toBeVisible();
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await expect(row).toContainText("170 × 6 · 160 × 8 · 150 × 10 · 140 × 14");
  const tag = row.getByText("+2 reps · +2 lb");
  await expect(tag).toBeVisible();
  const gold = await page.evaluate(() => {
    const probe = document.body.appendChild(document.createElement("span"));
    probe.style.color = "var(--color-gold)";
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  });
  expect(await tag.evaluate((el) => getComputedStyle(el).color)).toBe(gold);
  await expect(row.locator("[data-tone]")).toHaveAttribute("data-tone", "gold");
  await expect(page.getByRole("button", { name: "max 227" })).toBeVisible();
});

test("a main lift whose rest was skipped stays open with its notice; folded, the row says the sets were skipped", async ({ page }) => {
  await seed(page, { main: "two" });
  await openTrain(page);
  await page.getByRole("button", { name: "Skip rest of Bench press today" }).tap();
  // Every set it still holds is logged — but it doesn't fold, and "2 sets skipped · Restore" is right there.
  const notice = page.locator('[data-fold="main"]').getByText("2 sets skipped", { exact: true });
  const restore = page.getByRole("button", { name: "Restore 2 skipped sets of Bench press" });
  await expect(notice).toBeVisible();
  await expect(restore).toBeVisible();
  await page.waitForTimeout(1500);
  await expect(rows(page, "Bench press").getByRole("listitem")).toHaveCount(2);
  await expect(restore).toBeVisible();

  // The day opened again: one row — which doesn't read as everything logged, to the eye or by name.
  await leaveAndReturn(page);
  await expect(folded(page, "Bench press")).toHaveCount(0);
  const row = folded(page, "Bench press", "2 sets skipped");
  await expect(row).toBeVisible();
  await expect(row).toContainText("170 × 6 · 160 × 8");
  await expect(row.getByText("2 sets skipped", { exact: true })).toBeVisible();
  // A check in the accent, not gold: no AMRAP was beaten.
  await expect(row.locator("[data-tone]")).toHaveAttribute("data-tone", "accent");
  // Restore is one tap further.
  await row.tap();
  await restore.tap();
  await expect(rows(page, "Bench press").getByRole("listitem")).toHaveCount(4);
  await expectSynced(page);
  expect((await serverSets(page)).main).toBe("xxoo");
});

test("a finished session opens as a recap at 320 px: a fraction of its open length, nothing sticking out, toggles sound", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await seed(page, { main: "all", inc: "all", lat: "all", core: "all", completed: true });
  await openTrain(page);
  const names = ["Bench press", "Dumbbell incline press", "Lateral raise", "Superset A"];
  for (const name of names) await expect(folded(page, name)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Session complete" })).toBeVisible();
  expect(await pageOverflow(page)).toBeNull();

  /** The height of the exercises: from the main lift's first row to the end of the last accessory. */
  const exercisesHeight = () =>
    page.evaluate(() => {
      const top = document.querySelector('[data-fold="main"]')!.getBoundingClientRect().top;
      const bottom = document.querySelector('[data-block="core"]')!.getBoundingClientRect().bottom;
      return Math.round(bottom - top);
    });
  const foldedHeight = await exercisesHeight();
  // Every folded row is a full touch target.
  for (const name of names) expect((await folded(page, name).boundingBox())!.height).toBeGreaterThanOrEqual(44);

  await hideAmbientGlow(page);
  await page.waitForTimeout(1200); // the recap's entrances
  const rules = [
    "label-content-name-mismatch",
    "nested-interactive",
    "aria-allowed-attr",
    "aria-valid-attr-value",
    "button-name",
    "color-contrast",
  ];
  const axe = async () => {
    const results = await new AxeBuilder({ page }).withRules(rules).analyze();
    return results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
  };
  expect(await axe()).toEqual([]);

  // Open every one of them, one tap after the other: the session as it was while it was being done.
  for (const name of names) await folded(page, name).tap();
  await expect(page.getByRole("list", { name: / sets$/ }).getByRole("listitem")).toHaveCount(15);
  const openHeight = await exercisesHeight();
  expect(await pageOverflow(page)).toBeNull();
  expect(await axe()).toEqual([]);
  test
    .info()
    .annotations.push({ type: "heights", description: `15 sets at 320 px: exercises ${openHeight} px open, ${foldedHeight} px folded` });
  console.log(
    `fold: 15 sets at 320 px — exercises ${openHeight} px open, ${foldedHeight} px folded (${Math.round((foldedHeight / openHeight) * 100)}%)`,
  );
  expect(foldedHeight).toBeLessThan(openHeight * 0.35);
});
