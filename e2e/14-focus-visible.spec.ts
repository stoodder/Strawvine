/**
 * Focus not obscured (WCAG 2.4.11): Tab through a whole screen and, at every stop, the focused
 * control must be on screen and not under the fixed bottom nav or the dock (rest pill, toasts,
 * sync pill) — `document.elementFromPoint` at its centre is the control itself (or something
 * inside it). The app keeps focus clear with `html { scroll-padding-bottom: var(--dock-clearance) }`,
 * which the dock keeps up to date with its own height.
 */
import type { Page } from "@playwright/test";
import { expect, MONDAY, onboardedOn, test } from "./helpers";

interface Stop {
  what: string;
  /** null when fine; otherwise why the focused control can't be seen */
  problem: string | null;
}

/** The focused element, described, and whether its centre is visibly it. */
const inspectFocus = (page: Page) =>
  page.evaluate(async (): Promise<Stop | null> => {
    // Let the focus scroll land (two frames).
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body || el === document.documentElement) return null;
    const describe = (e: Element) => {
      const label = e.getAttribute("aria-label") ?? (e as HTMLElement).innerText?.trim().split("\n")[0]?.slice(0, 40) ?? "";
      return `${e.tagName.toLowerCase()}${label ? ` "${label}"` : ""}`;
    };
    const what = describe(el);
    const r = el.getBoundingClientRect();
    // Visually hidden controls (a switch's sr-only input) are represented by something else.
    if (r.width <= 1 || r.height <= 1) return { what, problem: null };
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    if (y < 0 || y > window.innerHeight || x < 0 || x > window.innerWidth)
      return {
        what,
        problem: `centre (${Math.round(x)}, ${Math.round(y)}) is outside the ${window.innerWidth}×${window.innerHeight} viewport`,
      };
    const hit = document.elementFromPoint(x, y);
    if (!hit) return { what, problem: "nothing at its centre" };
    if (hit === el || el.contains(hit)) return { what, problem: null };
    const label = el instanceof HTMLInputElement && el.labels ? [...el.labels].some((l) => l.contains(hit)) : false;
    if (label) return { what, problem: null };
    const chrome = hit.closest('nav[aria-label="Primary"], [data-dock]');
    return {
      what,
      problem: `covered at its centre (y ${Math.round(y)} of ${window.innerHeight}) by ${describe(hit)}${chrome ? ` in ${chrome.matches("nav") ? "the bottom nav" : "the dock"}` : ""}`,
    };
  });

/** Tab from the top of the page until focus comes back around; every stop is inspected. */
async function tabWalk(page: Page, maxStops = 250): Promise<{ stops: Stop[]; problems: string[] }> {
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    window.scrollTo(0, 0);
  });
  const stops: Stop[] = [];
  const seen = new Map<string, number>();
  let outside = 0;
  let last: string | null = null;
  for (let i = 0; i < maxStops; i++) {
    await page.keyboard.press("Tab");
    const stop = await inspectFocus(page);
    if (!stop) {
      // Focus left the document (past the last control) — or, once, a control re-rendered away.
      if (stops.length && ++outside >= 3) break;
      continue;
    }
    outside = 0;
    // Back at the first stop: done.
    const key = await page.evaluate(() => {
      const el = document.activeElement!;
      if (!el.hasAttribute("data-tabwalk")) el.setAttribute("data-tabwalk", String(document.querySelectorAll("[data-tabwalk]").length));
      return el.getAttribute("data-tabwalk")!;
    });
    // A date input keeps focus while Tab moves through its month / day / year fields.
    if (key === last) continue;
    last = key;
    if (seen.has(key)) break;
    seen.set(key, i);
    stops.push(stop);
  }
  return { stops, problems: stops.filter((s) => s.problem).map((s) => `${s.what}: ${s.problem}`) };
}

test.describe("Tab never lands under the bottom nav or the dock", () => {
  test.beforeEach(async ({ page }) => {
    await onboardedOn(page, MONDAY);
  });

  test("Train (Monday, a full session)", async ({ page }) => {
    await page.goto("/train");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Push/);
    const { stops, problems } = await tabWalk(page);
    expect(stops.length, "Tab stops on Train").toBeGreaterThan(15);
    expect(problems).toEqual([]);
  });

  test("Train with the rest timer running", async ({ page }) => {
    await page.goto("/train");
    await page.getByRole("button", { name: /^Bench press set 1:/ }).click();
    await expect(page.getByRole("group", { name: "Rest timer" })).toBeVisible();
    const { stops, problems } = await tabWalk(page);
    expect(stops.length, "Tab stops on Train").toBeGreaterThan(15);
    expect(problems).toEqual([]);
  });

  test("Settings", async ({ page }) => {
    await page.goto("/settings");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const { stops, problems } = await tabWalk(page);
    expect(stops.length, "Tab stops on Settings").toBeGreaterThan(30);
    expect(problems).toEqual([]);
  });

  test("Program", async ({ page }) => {
    await page.goto("/program");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const { stops, problems } = await tabWalk(page);
    expect(stops.length, "Tab stops on Program").toBeGreaterThan(60);
    expect(problems).toEqual([]);
  });
});
