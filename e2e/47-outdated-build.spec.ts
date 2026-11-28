/**
 * Outdated builds and rehab (SPEC §8): a build below the server's minimum level — every build from before the gate,
 * which sends no `x-strawvine-build-level` — may not write a workout or settings involving rehab. Its save is
 * answered 409 `upgrade-required`; it stays on the device, not saved, and nothing on the server changes. Everything
 * else it writes is accepted (settings keep the rehab blocks it doesn't know).
 *
 * Two runs, picked by what the server serves:
 *
 * - The normal run (this build's app) strips the header from the app's requests (as an outdated build sends them):
 *   the change is kept, the dock asks to "Update the app", and once updated the app sends it on its own.
 * - Served a build from before the gate (b4999a8) against this server, the real old app is refused:
 *
 *       npm run build                                   # this server
 *       OLD=$(mktemp -d) && git archive b4999a8 | tar -x -C "$OLD" && (cd "$OLD" && npm ci && npm run build)
 *       APP=$(mktemp -d) && mkdir "$APP/dist" && cp -r dist/server dist/build-id.txt "$APP/dist/" \
 *         && cp -r "$OLD/dist/web" "$APP/dist/web" && cp -r drizzle "$APP/" && ln -s "$PWD/node_modules" "$APP/node_modules"
 *       E2E_APP_DIR="$APP" npm run e2e -- 47-outdated-build
 */
import type { Page, Request } from "@playwright/test";
import { BUILD_LEVEL_HEADER, UPGRADE_REQUIRED, UPGRADE_REQUIRED_MESSAGE } from "../src/shared/buildLevel";
import type { Bootstrap, Session } from "../src/shared/schemas";
import {
  APP_HEADERS,
  expect,
  expectSynced,
  MONDAY,
  MONDAY_ISO,
  notifications,
  onboardedOn,
  serverData,
  test,
  toastMessage,
} from "./helpers";

const KNEE = {
  id: "knee",
  name: "Knee rehab",
  start: "2026-10-19",
  weeks: 6,
  days: [false, true, false, true, false, true, false],
  carry: "last",
};
const SESSION_URL = `/api/sessions/${MONDAY_ISO}`;

/** Whether the app served is a build from before the gate (its bundle never sends a build level). */
async function servesOutdatedApp(page: Page): Promise<boolean> {
  const { assets } = (await (await page.request.get("/build.json")).json()) as { assets: string[] };
  const scripts = assets.filter((a) => a.endsWith(".js"));
  expect(scripts.length, "the app's scripts (build.json)").toBeGreaterThan(0);
  for (const a of scripts) if ((await (await page.request.get(`/${a}`)).text()).includes(BUILD_LEVEL_HEADER)) return false;
  return true;
}

const isSessionPut = (r: Request) => r.method() === "PUT" && new URL(r.url()).pathname === SESSION_URL;

/** Every workout save the page sends from now on. */
function watchSessionPuts(page: Page): Request[] {
  const puts: Request[] = [];
  page.on("request", (r) => void (isSessionPut(r) && puts.push(r)));
  return puts;
}

/** Today's workout is saved (set 1 of the main lift logged), with no rehab in it yet. */
async function logFirstSet(page: Page) {
  await page.getByRole("link", { name: "Train" }).click();
  await page.getByRole("button", { name: /^Bench press set 1:/ }).click();
  await expectSynced(page);
  await expect.poll(async () => (await serverData(page)).sessions.some((s) => s.date === MONDAY_ISO)).toBe(true);
}

/**
 * A current device adds rehab: a rehab block in force (settings.rehab) and, in today's workout, a rehab block with a
 * logged set. Returns what the server then holds; the page reloads and shows it.
 */
async function seedRehab(page: Page): Promise<Bootstrap> {
  const before = await serverData(page);
  const put = async (url: string, data: unknown) => {
    const res = await page.request.put(url, { data, headers: APP_HEADERS });
    expect(res.ok(), `PUT ${url} → ${res.status()} ${await res.text()}`).toBe(true);
  };
  await put("/api/settings", { ...before.settings, rehab: { programs: [KNEE] } });
  const session = before.sessions.find((s) => s.date === MONDAY_ISO)!;
  const ex = before.exercises.find((e) => !e.tracksMax && e.measure === "reps")!;
  const set = {
    id: "rehab-s1",
    targetReps: 15,
    targetWeight: null,
    reps: 15,
    weight: null,
    done: true,
    amrap: false,
    appliedProgressionLb: null,
  };
  const withRehab: Session = {
    ...session,
    blocks: [
      ...session.blocks,
      { id: "rehab-1", kind: "rehab", rehab: "knee", exercises: [{ exerciseId: ex.id, measure: "reps", sets: [set] }] },
    ],
  };
  await put(SESSION_URL, withRehab);
  const seeded = await serverData(page);
  expect(seeded.sessions.find((s) => s.date === MONDAY_ISO)!.blocks.at(-1)).toMatchObject({ kind: "rehab", rehab: "knee" });
  await page.reload();
  await expect(page.getByRole("button", { name: /^Bench press set 2:/ })).toBeVisible();
  return seeded;
}

/** The server still holds exactly what `seeded` says about rehab: the workout and the rehab blocks. */
async function expectUnchanged(page: Page, seeded: Bootstrap) {
  const now = await serverData(page);
  expect(now.sessions.find((s) => s.date === MONDAY_ISO)).toEqual(seeded.sessions.find((s) => s.date === MONDAY_ISO));
  expect(now.revs?.sessions[MONDAY_ISO]).toBe(seeded.revs?.sessions[MONDAY_ISO]);
  expect(now.settings.rehab).toEqual({ programs: [KNEE] });
}

/** Logs set 2 of the main lift; resolves with the server's answer to that save. */
async function logSecondSet(page: Page) {
  const answer = page.waitForResponse((r) => isSessionPut(r.request()));
  await page.getByRole("button", { name: /^Bench press set 2:/ }).click();
  return answer;
}

const pill = (page: Page) => notifications(page).getByRole("button", { name: "1 not saved" });

test("a build from before the gate can't save a workout holding rehab: refused, kept on the device, nothing changed; its other saves go through", async ({
  page,
}) => {
  test.skip(!(await servesOutdatedApp(page)), "needs E2E_APP_DIR serving a build from before the gate (see the header)");
  await onboardedOn(page, MONDAY);
  await logFirstSet(page); // no rehab anywhere yet: saved as before
  const seeded = await seedRehab(page);
  const puts = watchSessionPuts(page);

  const res = await logSecondSet(page);
  expect(res.request().headers()[BUILD_LEVEL_HEADER]).toBeUndefined();
  expect(res.status()).toBe(409);
  expect(await res.json()).toMatchObject({ code: UPGRADE_REQUIRED, error: UPGRADE_REQUIRED_MESSAGE });
  // The old app keeps the change, not saved, with the server's words.
  await expect(toastMessage(page, /^Couldn't save your workout.*: This version of the app is out of date/)).toBeVisible();
  await expect(pill(page)).toBeVisible();
  await expect(page.getByRole("button", { name: /^Bench press set 2:/ })).toHaveAttribute("aria-pressed", "true");
  await expectUnchanged(page, seeded);

  // Nothing re-sends it on its own (no merge-and-retry loop): Retry sends it once more, refused again, still kept.
  await page.waitForTimeout(3000);
  expect(puts).toHaveLength(1);
  await pill(page).click();
  await notifications(page).getByRole("button", { name: "Retry" }).first().click();
  await expect.poll(() => puts.length).toBe(2);
  await expect(pill(page)).toBeVisible();
  await page.waitForTimeout(2000);
  expect(puts).toHaveLength(2);
  await expectUnchanged(page, seeded);

  // Its settings save (it doesn't know rehab blocks) goes through and keeps them.
  await page.goto("/settings");
  await page.getByRole("switch", { name: "High contrast" }).click();
  await expect.poll(async () => (await serverData(page)).settings.display?.highContrast).toBe(true);
  await expectUnchanged(page, seeded);
  // And after a reload the change is still there, not saved.
  await page.reload();
  await expect(pill(page)).toBeVisible();
});

test("this build refused as outdated: the change is kept, the dock asks to update, and the updated app sends it on its own", async ({
  page,
}) => {
  test.skip(await servesOutdatedApp(page), "the run of this build's app");
  await onboardedOn(page, MONDAY);
  await logFirstSet(page);
  const seeded = await seedRehab(page);
  const puts = watchSessionPuts(page);
  // As an outdated build sends them: no build level.
  await page.route("**/api/**", (route) => {
    const headers = { ...route.request().headers() };
    delete headers[BUILD_LEVEL_HEADER];
    return route.continue({ headers });
  });

  const res = await logSecondSet(page);
  expect(res.status()).toBe(409);
  expect(await res.json()).toMatchObject({ code: UPGRADE_REQUIRED });
  const prompt = notifications(page).getByRole("alert").filter({ hasText: "Update needed" });
  await expect(prompt).toHaveText(/This version can't save a change; it's kept on this device\./);
  await expect(pill(page)).toBeVisible();
  await expect(toastMessage(page, /^Couldn't save/)).toHaveCount(0);
  await expectUnchanged(page, seeded);
  await page.waitForTimeout(3000);
  expect(puts).toHaveLength(1);

  // Updated: the app's requests carry a level the server accepts again. (The refusal is marked as this build's; an
  // update brings a later one. Stored as a build before levels marks it — the server's message alone — so this
  // build counts as the later one.)
  await page.unroute("**/api/**");
  await page.evaluate(() => {
    const outbox = JSON.parse(localStorage.getItem("strawvine:outbox")!) as { entries: Array<Record<string, unknown>> };
    for (const e of outbox.entries) delete e.outdatedLevel;
    localStorage.setItem("strawvine:outbox", JSON.stringify(outbox));
  });
  const reloaded = page.waitForEvent("load");
  await prompt.getByRole("button", { name: "Update the app" }).click();
  await reloaded;
  await expect.poll(() => puts.length).toBe(2);
  await expectSynced(page);
  await expect(pill(page)).toHaveCount(0);
  await expect(notifications(page).getByRole("alert").filter({ hasText: "Update needed" })).toHaveCount(0);
  // Saved, the rehab block (and its logged set) as it was.
  const saved = (await serverData(page)).sessions.find((s) => s.date === MONDAY_ISO)!;
  const before = seeded.sessions.find((s) => s.date === MONDAY_ISO)!;
  expect(saved.blocks[0]!.exercises[0]!.sets.slice(0, 2).map((s) => s.done)).toEqual([true, true]);
  expect(saved.blocks.at(-1)).toEqual(before.blocks.at(-1));
  expect(saved.blocks.length).toBe(before.blocks.length);
});
