import { test as base, expect, type BrowserContext, type Locator, type Page } from "@playwright/test";
import type { Bootstrap } from "../src/shared/schemas";
import { seedHistory as seedHistoryVia } from "../scripts/lib/seed-history.mjs";

export { expect };
export const PASSWORD = process.env.E2E_PASSWORD ?? "e2e-password-not-secret";

/**
 * Playwright's clock (`page.clock.install`) fakes `performance.now()` and the timestamps given to
 * `requestAnimationFrame`, but not the document timeline Web Animations run on. Motion starts its
 * WAAPI animations at its own (fake) time, which drifts ahead of the real timeline under load:
 * an animation then starts seconds "in the future" — a sheet stays off screen, a fade stays at
 * opacity 0 — and tests time out on an element that never arrives. Starting times in the future
 * are clamped to the timeline's now. (Only the test clock causes this; a real browser has one
 * clock.) Contexts a test opens itself (a second device) call it themselves.
 */
export async function keepAnimationsOnTheRealTimeline(context: BrowserContext) {
  await context.addInitScript(() => {
    const desc = Object.getOwnPropertyDescriptor(Animation.prototype, "startTime");
    if (!desc?.set || !desc.get) return;
    Object.defineProperty(Animation.prototype, "startTime", {
      ...desc,
      set(this: Animation, value: CSSNumberish | null) {
        const now = document.timeline?.currentTime;
        desc.set!.call(this, typeof value === "number" && typeof now === "number" && value > now ? now : value);
      },
    });
  });
}

/** What the runner's control endpoint (scripts/e2e.mjs) has counted: CSP report-only violations logged by the server. */
async function cspLog(control: string): Promise<{ count: number; lines: string[] }> {
  const res = await fetch(`${control}/csp`);
  return res.ok ? res.json() : { count: 0, lines: [] };
}

/**
 * CSP reports during a test fail it: the app must run under its policy without tripping it (e.g.
 * zod compiling validators with `new Function`). Counted twice — POSTs to /api/csp-report seen
 * from this test's context, and the server's log (which also covers extra contexts a test opens).
 * E2E_CSP_REPORTS=warn downgrades a report to an annotation (a known, tracked violation).
 */
const CSP_REPORTS: "fail" | "warn" = process.env.E2E_CSP_REPORTS === "warn" ? "warn" : "fail";

/**
 * The suite's `test`: before each test (and each retry) the runner (scripts/e2e.mjs) restarts
 * the server on a known database, so every test is self-sufficient and nothing leaks between
 * them. That database is the onboarded template (onboarded Sunday 2026-10-25 with bench press
 * 225, see global-setup.ts): `login()` just signs in. A test that exercises onboarding itself
 * declares `test.use({ emptyDatabase: true })`. Without E2E_CONTROL_URL (running Playwright by
 * hand) the database is left alone.
 */
export const test = base.extend<{ emptyDatabase: boolean; freshDatabase: void; noCspReports: void }>({
  context: async ({ context }, use) => {
    await keepAnimationsOnTheRealTimeline(context);
    await use(context);
  },
  emptyDatabase: [false, { option: true }],
  freshDatabase: [
    async ({ emptyDatabase }, use) => {
      const control = process.env.E2E_CONTROL_URL;
      if (control) {
        const res = await fetch(`${control}/reset${emptyDatabase ? "?fresh=1" : ""}`, { method: "POST" });
        if (!res.ok) throw new Error(`Resetting the e2e database failed: ${res.status} ${await res.text()}`);
      }
      await use();
    },
    { auto: true },
  ],
  noCspReports: [
    async ({ context, freshDatabase: _ }, use, testInfo) => {
      const control = process.env.E2E_CONTROL_URL;
      const fromPage: string[] = [];
      context.on("request", (req) => {
        if (req.method() === "POST" && new URL(req.url()).pathname === "/api/csp-report")
          fromPage.push(req.postData()?.slice(0, 300) ?? "");
      });
      const before = control ? (await cspLog(control)).count : 0;
      await use();
      // report-uri reports are sent right away, but asynchronously: give the last ones a moment.
      await new Promise((r) => setTimeout(r, 300));
      const fromServer = control ? (await cspLog(control)).lines.slice(before) : [];
      if (!fromPage.length && !fromServer.length) return;
      const detail = [...new Set(fromServer.length ? fromServer : fromPage)].slice(0, 5).join("\n  ");
      const message = `${Math.max(fromPage.length, fromServer.length)} CSP report(s) during the test:\n  ${detail}`;
      if (CSP_REPORTS === "warn") testInfo.annotations.push({ type: "warning", description: message });
      else throw new Error(message);
    },
    { auto: true },
  ],
});

/**
 * Local-time instants (the browser runs in the machine's zone). The suite pins the clock so the
 * program calendar is predictable: onboarding on Sunday 2026-10-25 starts the cycle on Monday the
 * 26th, which is week 1 (Push — bench, AMRAP last set).
 */
export const SUNDAY = new Date(2026, 9, 25, 9, 0, 0);
export const MONDAY = new Date(2026, 9, 26, 10, 0, 0);
export const MONDAY_ISO = "2026-10-26";

/**
 * Celebrations (day closed, PRs, streaks) are modal and can appear at any moment: whenever one
 * shows up, press "Continue" until none is left. Returns the titles seen, in order.
 */
export async function dismissCelebrations(page: Page): Promise<string[]> {
  const seen: string[] = [];
  // The newest overlay (a dismissed one may still be fading out underneath).
  const dialog = page
    .getByRole("dialog")
    .filter({ has: page.getByRole("button", { name: /^Continue/ }) })
    .last();
  const cont = dialog.getByRole("button", { name: /^Continue/ });
  await page.addLocatorHandler(
    cont,
    async () => {
      for (let i = 0; i < 10; i++) {
        const title = await dialog
          .getByRole("heading", { level: 2 })
          .textContent({ timeout: 1000 })
          .catch(() => null);
        if (!title) break;
        if (seen.at(-1) !== title) seen.push(title);
        if (process.env.E2E_DEBUG) console.log(`celebration: ${title}`);
        // The overlay ignores taps for its first instant (they were meant for what was underneath).
        await page.waitForTimeout(500);
        await cont.click({ timeout: 2000 }).catch(() => {});
        await page.waitForTimeout(400);
      }
    },
    { noWaitAfter: true },
  );
  return seen;
}

/**
 * Sign in (unless a session cookie already does) and, on a fresh database, skip through
 * onboarding (bench press max 225; the cycle starts the Monday after the browser's today).
 */
export async function login(page: Page) {
  await page.goto("/");
  const pw = page.getByLabel("Password");
  const nav = page.getByRole("navigation", { name: "Primary" });
  const onboarding = page.getByRole("heading", { name: "Let's calibrate." });
  await expect(pw.or(nav).or(onboarding)).toBeVisible();
  if (await pw.isVisible()) {
    await pw.fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
  }
  await expect(nav.or(onboarding)).toBeVisible();
  if (await onboarding.isVisible()) {
    await page.getByRole("button", { name: "Continue" }).click();
    await fillNumber(page, "Bench press", "225");
    for (let i = 0; i < 2; i++) await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: "Begin" }).click();
    await expect(nav).toBeVisible();
  }
}

/** Fill a commit-on-blur number field. */
export async function fillNumber(page: Page, name: string | RegExp, value: string) {
  const input = page.getByRole("textbox", { name, exact: typeof name === "string" }).first();
  await input.click();
  await input.fill(value);
  await input.press("Enter");
  await expect(input).not.toBeFocused();
}

/**
 * Wait until this device has a trusted copy of the data (IndexedDB "strawvine" / kv: the
 * "b:meta" record of the split copy, or the older single "base" record — written a few seconds
 * after a load), and no "strawvine:cache-invalid" mark from the sign-out that preceded sign-in,
 * so the app can open offline.
 */
export async function waitForDeviceCopy(page: Page) {
  const trusted = () =>
    page.evaluate(
      () =>
        new Promise<boolean>((resolve) => {
          if (localStorage.getItem("strawvine:cache-invalid") !== null) return resolve(false);
          const req = indexedDB.open("strawvine");
          req.onerror = () => resolve(false);
          req.onsuccess = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains("kv")) return (db.close(), resolve(false));
            const store = db.transaction("kv").objectStore("kv");
            const meta = store.get("b:meta");
            const legacy = store.get("base");
            legacy.onsuccess = () => (db.close(), resolve(meta.result != null || legacy.result != null));
            legacy.onerror = () => (db.close(), resolve(false));
          };
        }),
    );
  await expect.poll(trusted, { timeout: 20_000, intervals: [500] }).toBe(true);
}

/**
 * Start the page's clock at `time` and let it run in real time. (A fixed clock would freeze
 * `Date.now()`, which the app's animations and idle checks rely on.)
 */
export async function startClockAt(page: Page, time: Date) {
  await page.clock.install({ time });
  await page.clock.resume();
}

/**
 * Onboard on Sunday 2026-10-25 (fresh database) with a running clock, then move the clock to
 * `day` (default: stay on Sunday) and open the app there. Celebrations are dismissed as they come.
 */
export async function onboardedOn(page: Page, day: Date = SUNDAY): Promise<string[]> {
  await startClockAt(page, SUNDAY);
  const celebrated = await dismissCelebrations(page);
  await login(page);
  if (day !== SUNDAY) {
    await page.clock.setSystemTime(day);
    await page.goto("/");
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
  }
  return celebrated;
}

/** What the server holds now (GET /api/bootstrap with this page's session cookie). */
export async function serverData(page: Page): Promise<Bootstrap> {
  const res = await page.request.get("/api/bootstrap", { headers: { "cache-control": "no-cache" } });
  expect(res.ok(), `GET /api/bootstrap → ${res.status()}`).toBe(true);
  return res.json();
}

/** Open Settings and an exercise's Edit exercise sheet from the exercise library; returns the sheet. */
export async function openExerciseEditor(page: Page, name: string) {
  await page.goto("/settings");
  await page.getByRole("button", { name: `Edit ${name}`, exact: true }).click();
  const sheet = page.getByRole("dialog", { name: `Edit ${name}` });
  await expect(sheet.getByRole("textbox", { name: "Name" })).toHaveValue(name);
  return sheet;
}

/** Wait until nothing is waiting to sync on this page (the dock's pending pill is gone). */
export async function expectSynced(page: Page) {
  await expect(page.getByRole("button", { name: /pending/ })).toHaveCount(0, { timeout: 20_000 });
}

/**
 * Focus must land somewhere useful after an action that replaces the control that was pressed:
 * polls until `document.activeElement` is neither <body> nor missing, and returns a short
 * description of it (tag, accessible name) for further checks.
 */
export async function expectFocusNotOnBody(page: Page, what: string): Promise<string> {
  const describe = () =>
    page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body || el === document.documentElement) return "body";
      const name = el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 60) ?? "";
      return `${el.tagName.toLowerCase()} "${name}"`;
    });
  let last = "body";
  await expect
    .poll(async () => (last = await describe()), { message: `focus after ${what} should not be on <body>`, timeout: 5_000 })
    .not.toBe("body");
  return last;
}

/** The dock's toasts (outside #root, so they stay usable while a sheet is open). */
export const notifications = (page: Page) => page.getByRole("region", { name: "Notifications" });

/**
 * A visible toast's message. (The same text is also in the sr-only live region — a `status` —
 * which this skips.)
 */
export const toastMessage = (page: Page, text: string | RegExp) =>
  notifications(page).locator(":not([role=status]) > span").filter({ hasText: text });

/**
 * Three weeks of history before the template's onboarding day (day logs with every field, a
 * missed day a week, completed Monday / Wednesday sessions, older maxes, a weight goal and a
 * strength target), written through the API with this page's session — so screens are tested
 * with charts, trends and carried-over accessories instead of empty states. Reload afterwards.
 */
export async function seedHistory(page: Page, opts?: { through?: string; weeks?: number }) {
  await seedHistoryVia(async (method, path, body) => {
    const res = await page.request.fetch(path, { method, ...(body !== undefined ? { data: body } : {}) });
    if (!res.ok()) throw new Error(`${method} ${path} → ${res.status()} ${await res.text()}`);
    return res.status() === 204 ? null : res.json();
  }, opts);
}

/**
 * Hide the ambient glow (body::before, a gradient behind everything): with it, axe can't tell any
 * text's background and reports every color-contrast check as "incomplete" instead of passing or
 * failing it. The glow is at most 7% lime over ink-950, so contrast is measured on the plain surface.
 */
export async function hideAmbientGlow(page: Page) {
  // A constructed stylesheet rather than a <style> tag, which the report-only CSP (no inline
  // styles) would report.
  await page.evaluate(() => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync("body::before { display: none !important; }");
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  });
}

/**
 * Horizontal overflow, measured without the safety net: html and body clip sideways overflow
 * (styles.css), which hides what sticks out from `scrollWidth` — so the clip is lifted first.
 * null when the page fits; otherwise the widths and the first few elements that stick out.
 */
export function pageOverflow(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const doc = document.documentElement;
    if (!doc.hasAttribute("data-overflow-probe")) {
      doc.setAttribute("data-overflow-probe", "");
      const sheet = new CSSStyleSheet();
      sheet.replaceSync("html[data-overflow-probe], html[data-overflow-probe] body { overflow-x: visible !important; }");
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    }
    if (doc.scrollWidth <= doc.clientWidth) return null;
    const wide = [...document.querySelectorAll<HTMLElement>("body *")]
      .filter((el) => el.getBoundingClientRect().right > doc.clientWidth + 0.5)
      .slice(0, 5)
      .map(
        (el) =>
          `${el.tagName.toLowerCase()}.${[...el.classList].slice(0, 4).join(".")} "${(el.textContent ?? "").trim().slice(0, 30)}" → ${Math.round(el.getBoundingClientRect().right)}px`,
      );
    return `scrollWidth ${doc.scrollWidth} > clientWidth ${doc.clientWidth}\n    ${wide.join("\n    ")}`;
  });
}

/**
 * Fixed layers (the dock, a sheet) don't widen the page, so the page check can't see them: every
 * visible element inside `layer` must lie within the viewport, unless an ancestor inside the layer
 * clips it; and nothing in it may scroll sideways (a sheet's panel scrolls vertically, which makes
 * it a horizontal scroller as well). Returns what sticks out.
 */
export function outsideViewport(layer: Locator): Promise<string[]> {
  return layer.evaluate((root) => {
    const vw = document.documentElement.clientWidth;
    const out: string[] = [];
    const describe = (el: Element) =>
      `${el.tagName.toLowerCase()}.${[...el.classList].slice(0, 4).join(".")} "${(el.textContent ?? "").trim().slice(0, 30)}"`;
    for (const el of [root, ...root.querySelectorAll<HTMLElement>("*")]) {
      const style = getComputedStyle(el);
      if ((style.overflowX === "auto" || style.overflowX === "scroll") && el.scrollWidth > el.clientWidth + 1)
        out.push(`${describe(el)} scrolls sideways: ${el.scrollWidth} > ${el.clientWidth} px`);
      // The layer itself is a full-width fixed box (on a phone it follows the layout viewport,
      // which a too-wide page stretches): what matters is what is drawn in it.
      if (el === root) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || style.visibility === "hidden") continue;
      if (r.left >= -0.5 && r.right <= vw + 0.5) continue;
      let clipped = false;
      for (let a = el.parentElement; a && a !== root.parentElement; a = a.parentElement)
        if (getComputedStyle(a).overflowX !== "visible") {
          const ar = a.getBoundingClientRect();
          if (ar.left >= -0.5 && ar.right <= vw + 0.5) clipped = true;
          break;
        }
      if (!clipped) out.push(`${describe(el)} spans ${Math.round(r.left)}–${Math.round(r.right)}px of ${vw}`);
      if (out.length >= 5) break;
    }
    return out;
  });
}
