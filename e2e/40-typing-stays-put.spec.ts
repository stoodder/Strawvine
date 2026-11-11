/**
 * The field being typed in stays where it is: nothing the app does for a keystroke, for a value
 * saved as its field is left for the next one, for a save or a sync landing mid-typing, or for a
 * phone keyboard changing size may move it — only the field's own growth moves anything, and the
 * browser then keeps the caret in view by itself. On Today, what a saved value would add or take
 * away above a field (a signal, a row's second line, the steps bar) waits until no field has
 * focus — while everything that is shown says the day as it is. And a number typed but not yet
 * committed is not lost with its field (the app hidden, the editor closed, another day shown).
 *
 * Chromium has no iOS keyboard, so each cause is played the way it reaches the page:
 * - a page scrolled to its end (where it is when the keyboard is up and the field is the last
 *   thing on it), typed into key by key: the scroll position is read in the `input` event itself,
 *   after the app's handlers and before the browser brings the caret into view (which, in
 *   Chromium, hides a scroll the app caused when the caret sits at the end of the text);
 * - an engine without scroll anchoring (`overflow-anchor: none` on everything): Chromium quietly
 *   compensates for some layout changes above the screen, which hides them here and not there;
 * - the keyboard itself as iOS Safari has it for sheets: the layout viewport keeps its height
 *   while `visualViewport` shrinks above the keyboard, is panned (`offsetTop`), and changes by
 *   the height of the suggestion bar (~45 px) while typing — its getters stubbed, its `resize` /
 *   `scroll` events fired.
 * What only an iPhone can show (Safari's own pan to a focused field, the real keyboard, whether a
 * tap on a button takes focus from a field) is not tested here; where browsers may differ on the
 * last, both ways are played.
 */
import type { BrowserContext, Locator, Page } from "@playwright/test";
import { expect, expectSynced, MONDAY, MONDAY_ISO, onboardedOn, seedHistory, serverData, test } from "./helpers";

/** An engine without scroll anchoring (Chromium's would compensate for changes above the screen). */
async function withoutScrollAnchoring(page: Page) {
  await page.evaluate(() => {
    // A constructed sheet: a <style> tag would trip the CSP report.
    const sheet = new CSSStyleSheet();
    sheet.replaceSync("html, body, body * { overflow-anchor: none !important; }");
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  });
}

interface AtInput {
  scrollY: number;
  top: number;
}
/**
 * Records, in every `input` event (a window listener: after the app's own handlers and their
 * effects, before the browser scrolls the caret into view), where the page and the field are.
 */
async function watchInput(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __atInput: AtInput[] };
    w.__atInput = [];
    window.addEventListener("input", (e) => {
      const r = (e.target as HTMLElement).getBoundingClientRect();
      w.__atInput.push({ scrollY: window.scrollY, top: r.top });
    });
  });
}
const takeInputs = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __atInput: AtInput[] };
    const seen = w.__atInput;
    w.__atInput = [];
    return seen;
  });

interface Place {
  top: number;
  left: number;
  bottom: number;
  height: number;
  scrollY: number;
  /** The field's top in the document: moves only when something above it changes size. */
  docTop: number;
  /** The bottom edge of the field's last line of text (its box less the padding under it). */
  lastLine: number;
  /** The height of a line of its text. */
  line: number;
  /** The bottom edge of what the nav and dock leave visible: the dock's top (an empty dock starts at the nav). */
  clear: number;
  focused: boolean;
  caret: number | null;
  value: string;
}
const place = (field: Locator): Promise<Place> =>
  field.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const input = el as HTMLInputElement | HTMLTextAreaElement;
    const dock = document.querySelector("[data-dock]")!.getBoundingClientRect();
    return {
      top: r.top,
      left: r.left,
      bottom: r.bottom,
      height: r.height,
      scrollY: window.scrollY,
      docTop: r.top + window.scrollY,
      lastLine: r.bottom - parseFloat(getComputedStyle(el).paddingBottom),
      line: parseFloat(getComputedStyle(el).lineHeight),
      clear: dock.top,
      focused: document.activeElement === el,
      caret: input.selectionStart,
      value: input.value,
    };
  });

/**
 * Every op the app queues from here on, as it is written to the outbox (new entries in
 * localStorage "strawvine:outbox"). Call before the app loads.
 */
async function watchOps(context: BrowserContext) {
  await context.addInitScript(() => {
    const w = window as unknown as { __ops: unknown[]; __seenOps: Set<number> };
    w.__ops = [];
    w.__seenOps = new Set();
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k: string, v: string) {
      if (k === "strawvine:outbox") {
        try {
          const outbox = JSON.parse(v) as { entries?: Array<{ seq: number; op: unknown }> };
          for (const e of outbox.entries ?? [])
            if (!w.__seenOps.has(e.seq)) {
              w.__seenOps.add(e.seq);
              w.__ops.push(e.op);
            }
        } catch {
          /* not the outbox's JSON */
        }
      }
      return set.call(this, k, v);
    };
  });
}
type DayOp = { kind: string; date?: string; patch?: Record<string, unknown> };
/** The day ops queued so far that write `key`. */
const opsWriting = async (page: Page, key: string) =>
  (await page.evaluate(() => (window as unknown as { __ops: DayOp[] }).__ops)).filter(
    (op) => op.kind === "day" && op.patch && key in op.patch,
  );

/** The app goes to the background (`true`) or comes back, as the page hears of it. */
async function hidden(page: Page, on: boolean) {
  await page.evaluate((on) => {
    if (on) Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    else delete (document as unknown as Record<string, unknown>).visibilityState;
    document.dispatchEvent(new Event("visibilitychange"));
    if (on) window.dispatchEvent(new Event("pagehide"));
  }, on);
}

/** Where `field` is in the page, every frame for `ms`: the distinct places seen, in order. */
const placesOver = (field: Locator, ms: number) =>
  field.evaluate(
    (el, ms) =>
      new Promise<number[]>((resolve) => {
        const seen: number[] = [];
        const t0 = performance.now();
        const tick = () => {
          const top = Math.round((el.getBoundingClientRect().top + window.scrollY) * 10) / 10;
          if (seen[seen.length - 1] !== top) seen.push(top);
          if (performance.now() - t0 < ms) requestAnimationFrame(tick);
          else resolve(seen);
        };
        tick();
      }),
    ms,
  );

/** A tap that takes no focus from the field that has it (a click with no focus change) — one of the two ways a browser may play a tap on a button. */
const tapKeepingFocus = (control: Locator) => control.evaluate((el: HTMLElement) => el.click());

const toPageEnd = (page: Page) => page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
const settled = (page: Page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

async function press(page: Page, ch: string) {
  if (ch === "\n") await page.keyboard.press("Enter");
  else await page.keyboard.type(ch);
}

/**
 * Twelve lines into an auto-growing text area at the end of the page, key by key. After every
 * line the page is scrolled back to its very end (as it is on a phone: the keyboard takes the
 * room below). No keystroke may scroll the page by itself or move the field; the field grows a
 * line at a time, the browser follows the caret, and the caret line stays clear of the nav.
 */
async function typeTwelveLines(page: Page, field: Locator) {
  await field.tap();
  await expect(field).toBeFocused();
  await watchInput(page);
  const start = await place(field);
  const { line } = start;
  let before = start;
  for (let n = 1; n <= 12; n++) {
    for (const ch of `${n === 1 ? "" : "\n"}line ${n}`) {
      await press(page, ch);
      const [at] = await takeInputs(page);
      const what = `"${ch === "\n" ? "\\n" : ch}" of line ${n}`;
      expect(at, `an input event for ${what}`).toBeTruthy();
      // The app scrolled nothing and moved nothing for the keystroke.
      expect(at!.scrollY, `scroll position in the input event of ${what}`).toBe(before.scrollY);
      expect(Math.abs(at!.top - before.top), `the field's top in the input event of ${what}`).toBeLessThanOrEqual(0.5);
      await settled(page);
      const after = await place(field);
      // Nothing above the field changed, the field grew by at most a line, and the page only followed the caret.
      expect(Math.abs(after.docTop - start.docTop), `the field's place in the page after ${what}`).toBeLessThanOrEqual(0.5);
      expect(after.height - before.height, `growth for ${what}`).toBeGreaterThanOrEqual(0);
      expect(after.height - before.height, `growth for ${what}`).toBeLessThanOrEqual(line + 2);
      expect(after.scrollY, `the page never scrolls back for ${what}`).toBeGreaterThanOrEqual(before.scrollY);
      expect(after.scrollY - before.scrollY, `the page follows the caret by no more than the growth for ${what}`).toBeLessThanOrEqual(
        after.height - before.height + 1,
      );
      // The caret is on the last line: it is on screen, above the nav and the dock.
      expect(after.lastLine, `the caret line clear of the nav after ${what}`).toBeLessThanOrEqual(after.clear + 1);
      expect(after.focused, `focus after ${what}`).toBe(true);
      before = after;
    }
    await toPageEnd(page);
    await settled(page);
    before = await place(field);
  }
  expect(before.value.split("\n")).toHaveLength(12);
  // As tall as its twelve lines (and the padding under them).
  expect(Math.abs(before.lastLine - before.top - 12 * line), "the field is as tall as its text").toBeLessThanOrEqual(2);
  expect(before.height).toBeGreaterThan(start.height + 6 * line);

  // Back in the middle of the text (the end of line 10), the page at its end: typing there moves nothing at all.
  await field.evaluate((el: HTMLTextAreaElement) => {
    const i = el.value.indexOf("\nline 11");
    el.setSelectionRange(i, i);
  });
  await toPageEnd(page);
  await settled(page);
  before = await place(field);
  for (const ch of " ok") {
    await press(page, ch);
    const [at] = await takeInputs(page);
    expect(at!.scrollY, `scroll position in the input event of "${ch}" (mid-text)`).toBe(before.scrollY);
    await settled(page);
    const after = await place(field);
    expect(after.scrollY, `scroll position after "${ch}" (mid-text)`).toBe(before.scrollY);
    expect(Math.abs(after.top - before.top), `the field's top after "${ch}" (mid-text)`).toBeLessThanOrEqual(0.5);
  }
  await expect(field).toHaveValue(/line 10 ok\nline 11/);
}

/**
 * An on-screen keyboard as iOS Safari has one (see e2e/29): the visual viewport is `height` tall
 * and panned down by `offsetTop`, the layout viewport stays the whole window. `null` puts the
 * real getters back. Fires the events iOS fires: `resize` when the height changed, `scroll` when
 * the pan did.
 */
async function keyboard(page: Page, kb: { height: number; offsetTop: number } | null) {
  await page.evaluate((kb) => {
    const vv = window.visualViewport!;
    const was = { height: vv.height, offsetTop: vv.offsetTop };
    for (const key of ["height", "offsetTop", "pageTop"] as const) delete (vv as unknown as Record<string, unknown>)[key];
    if (kb) {
      Object.defineProperty(vv, "height", { configurable: true, get: () => kb.height });
      Object.defineProperty(vv, "offsetTop", { configurable: true, get: () => kb.offsetTop });
      Object.defineProperty(vv, "pageTop", { configurable: true, get: () => window.scrollY + kb.offsetTop });
    }
    if (vv.height !== was.height) vv.dispatchEvent(new Event("resize"));
    if (vv.offsetTop !== was.offsetTop) vv.dispatchEvent(new Event("scroll"));
  }, kb);
  await settled(page);
}

interface InSheet {
  /** The field against what is visible above the keyboard. */
  top: number;
  bottom: number;
  visibleTop: number;
  visibleBottom: number;
  /** The panel's own box and scroll. */
  panelTop: number;
  panelBottom: number;
  scrollTop: number;
  focused: boolean;
}
const inSheet = (field: Locator): Promise<InSheet> =>
  field.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const panel = el.closest<HTMLElement>('[role="dialog"]')!;
    const p = panel.getBoundingClientRect();
    const vv = window.visualViewport!;
    return {
      top: r.top,
      bottom: r.bottom,
      visibleTop: vv.offsetTop,
      visibleBottom: vv.offsetTop + vv.height,
      panelTop: p.top,
      panelBottom: p.bottom,
      scrollTop: panel.scrollTop,
      focused: document.activeElement === el,
    };
  });

/**
 * Type into a sheet's field while the keyboard does what an iPhone's does mid-typing: the
 * suggestion bar comes (the visible area loses 45 px) and goes, and Safari pans the visual
 * viewport. Through all of it the field is on screen and inside the panel, a keystroke moves
 * nothing, and a change of the keyboard either leaves the field where it is on screen (a panel as
 * tall as the room gives up its bottom edge) or carries it with the keyboard's top (a shorter
 * panel rides the keyboard) — never anything else, and never by scrolling the panel.
 */
async function typeInSheetThroughKeyboardChanges(page: Page, field: Locator, text: string, viewport: { height: number }) {
  const up = viewport.height - (viewport.height > 700 ? 336 : 260);
  await keyboard(page, { height: up, offsetTop: 0 });
  await expect(field).toBeFocused();
  const start = await inSheet(field);
  const check = async (what: string) => {
    const s = await inSheet(field);
    expect(s.focused, `focus ${what}`).toBe(true);
    expect(s.top, `field top inside the visible area ${what}`).toBeGreaterThanOrEqual(s.visibleTop);
    expect(s.bottom, `field bottom above the keyboard ${what}`).toBeLessThanOrEqual(s.visibleBottom);
    expect(s.top, `field top inside the panel ${what}`).toBeGreaterThanOrEqual(s.panelTop);
    expect(s.bottom, `field bottom inside the panel ${what}`).toBeLessThanOrEqual(s.panelBottom);
    expect(s.panelBottom, `the panel sits on the keyboard ${what}`).toBeLessThanOrEqual(s.visibleBottom + 0.5);
    return s;
  };
  expect(start.bottom, "the field is above the keyboard to begin with").toBeLessThanOrEqual(start.visibleBottom);
  // What the keyboard does between keystrokes, in turn.
  const moves = [
    { height: up - 45, offsetTop: 0 }, // the suggestion bar appears
    { height: up - 45, offsetTop: 30 }, // Safari pans a little
    { height: up, offsetTop: 30 }, // the bar goes
    { height: up, offsetTop: 0 }, // the pan is undone
  ];
  let i = 0;
  for (const ch of text) {
    const before = await check(`before "${ch}"`);
    await press(page, ch);
    await settled(page);
    const typed = await check(`after "${ch}"`);
    // A keystroke alone moves nothing.
    expect(Math.abs(typed.top - before.top), `the field moves for "${ch}"`).toBeLessThanOrEqual(0.5);
    expect(typed.scrollTop, `the panel scrolls for "${ch}"`).toBe(before.scrollTop);
    const kb = moves[i++ % moves.length]!;
    await keyboard(page, kb);
    const moved = await check(`after the keyboard changed to ${JSON.stringify(kb)}`);
    // On screen (against the visible area's top) the field stayed put, or it kept its distance to the keyboard's top…
    const onScreen = Math.abs(moved.top - moved.visibleTop - (typed.top - typed.visibleTop));
    const toKeyboard = Math.abs(moved.visibleBottom - moved.bottom - (typed.visibleBottom - typed.bottom));
    expect(
      Math.min(onScreen, toKeyboard),
      `the field at ${JSON.stringify(kb)}: moved ${onScreen} px on screen, ${toKeyboard} px against the keyboard`,
    ).toBeLessThanOrEqual(1);
    // …and the panel's own scroll is left alone.
    expect(moved.scrollTop, `the panel's scroll at ${JSON.stringify(kb)}`).toBe(start.scrollTop);
  }
  await keyboard(page, null);
}

for (const viewport of [
  { width: 390, height: 844 },
  { width: 320, height: 568 },
]) {
  test.describe(`${viewport.width}×${viewport.height}`, () => {
    test.use({ viewport, hasTouch: true, isMobile: true });

    test("Train: twelve lines of session notes with the page at its end", async ({ page }) => {
      await onboardedOn(page, MONDAY);
      await page.goto("/train");
      const notes = page.getByRole("textbox", { name: "Session notes" });
      await expect(notes).toBeVisible();
      await withoutScrollAnchoring(page);
      await typeTwelveLines(page, notes);
      // What was typed is what is saved.
      await notes.blur();
      await expectSynced(page);
      const saved = (await serverData(page)).sessions.find((s) => s.date === MONDAY_ISO)!;
      expect(saved.notes.split("\n")).toHaveLength(12);
      expect(saved.notes).toContain("line 10 ok\nline 11");
    });

    test("Today: twelve lines of journal with the page at its end", async ({ page }) => {
      await onboardedOn(page, MONDAY);
      const journal = page.getByRole("textbox", { name: "Journal" });
      await expect(journal).toBeVisible();
      await withoutScrollAnchoring(page);
      await typeTwelveLines(page, journal);
      await journal.blur();
      await expectSynced(page);
      const saved = (await serverData(page)).days.find((d) => d.date === MONDAY_ISO)!;
      expect(saved.journal?.split("\n")).toHaveLength(12);
    });

    test("Today: entering calories and macros field to field — a value saved moves no field", async ({ page }) => {
      await onboardedOn(page, MONDAY);
      await seedHistory(page);
      // Calories equal to what the macros make: the "Use N from macros" chip is not there yet, and
      // comes as soon as a macro changes. Protein just under its target: 260 g will be over it.
      const res = await page.request.put(`/api/days/${MONDAY_ISO}`, {
        data: { weightLb: 199, calories: 2140, proteinG: 200, carbsG: 200, fatG: 60 },
      });
      expect(res.ok()).toBe(true);
      await page.reload();
      await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
      await withoutScrollAnchoring(page);
      await page.getByRole("button", { name: /^Nutrition/ }).tap();
      const editor = page.getByRole("group", { name: "Nutrition details" });
      const field = (name: string) => editor.getByRole("textbox", { name, exact: true });
      await expect(field("Fat")).toBeVisible();
      // The editor has finished opening.
      await expect.poll(async () => (await place(field("Fat"))).top, { intervals: [150] }).toBe((await place(field("Fat"))).top);
      await page.waitForTimeout(400);
      await watchInput(page);

      const chip = editor.getByRole("button", { name: /from macros$/ });
      await expect(chip).toHaveCount(0);
      const fuel = page.locator("section").filter({ has: page.getByRole("heading", { name: "Fuel" }) });

      /**
       * Tap `name` (unless it has focus already: a second tap soon after the first would be a double
       * tap, which selects a word instead of all), replace what it holds with `value` key by key: no
       * keystroke moves the field or the page. Returns where the field ended up.
       */
      const enter = async (name: string, value: string) => {
        if (!(await place(field(name))).focused) await field(name).tap();
        await expect(field(name)).toBeFocused();
        await field(name).press("ControlOrMeta+a");
        await settled(page);
        await takeInputs(page);
        let before = await place(field(name));
        for (const ch of value) {
          await press(page, ch);
          const [at] = await takeInputs(page);
          expect(at!.scrollY, `${name}: scroll position in the input event of "${ch}"`).toBe(before.scrollY);
          await settled(page);
          const after = await place(field(name));
          expect(after.scrollY, `${name}: scroll position after "${ch}"`).toBe(before.scrollY);
          expect(Math.abs(after.top - before.top), `${name}: the field's top after "${ch}"`).toBeLessThanOrEqual(0.5);
          expect(after.focused, `${name}: focus after "${ch}"`).toBe(true);
          before = after;
        }
        return before;
      };
      /** Where every number field of the editor is, by name. */
      const all = async () => {
        const out: Record<string, number> = {};
        for (const name of ["Calories", "Protein", "Carbs", "Fat"]) out[name] = (await place(field(name))).top;
        return out;
      };

      // Protein 200 → 260: over its target, and no longer what the calories say.
      await enter("Protein", "260");
      // The macros sit low on the screen, their boxes just clear of the nav — as a phone leaves a
      // field just clear of its keyboard.
      await page.evaluate(
        (by) => window.scrollBy(0, by),
        Math.round((await place(field("Carbs"))).bottom - ((await place(field("Carbs"))).clear - 24)),
      );
      await settled(page);
      const before = await all();
      const y = await page.evaluate(() => window.scrollY);
      // Leaving the field for the next saves it. The saved value changes the page — an "over" note
      // under Protein's bar, the chip offering the calories the macros make — but not where the
      // fields are: the next one is still under the thumb, and still above the keyboard.
      await field("Carbs").tap();
      await expect(field("Carbs")).toBeFocused();
      await expect(chip).toBeVisible();
      await expect(fuel.getByText(/^\+\d+g over$/)).toBeVisible();
      expect(await page.evaluate(() => window.scrollY), "nothing scrolled as Protein was saved").toBe(y);
      const after = await all();
      const carbs = await place(field("Carbs"));
      expect(carbs.bottom, "the field moved to is still on screen, clear of the nav").toBeLessThanOrEqual(carbs.clear);
      for (const name of Object.keys(before))
        expect(Math.abs(after[name]! - before[name]!), `${name} moved when Protein was saved`).toBeLessThanOrEqual(0.5);

      // On through the fields, by tap and by Tab: every keystroke leaves everything where it is…
      await enter("Carbs", "150");
      await enter("Fat", "70");
      const cal = await enter("Calories", "2270"); // 260·4 + 150·4 + 70·9: the chip has nothing left to offer
      await page.keyboard.press("Tab");
      // (Calories → Paste → Protein in tab order.)
      await page.keyboard.press("Tab");
      await expect(field("Protein")).toBeFocused();
      await expect(chip).toHaveCount(0);
      // …and so does the chip going away.
      const end = await all();
      expect(Math.abs(end.Calories! - cal.top), "Calories moved when it was saved").toBeLessThanOrEqual(0.5);
      for (const name of ["Protein", "Carbs", "Fat"])
        expect(Math.abs(end[name]! - before[name]!), `${name} moved by the end`).toBeLessThanOrEqual(0.5);

      await field("Protein").blur();
      await expectSynced(page);
      const saved = (await serverData(page)).days.find((d) => d.date === MONDAY_ISO)!;
      expect([saved.calories, saved.proteinG, saved.carbsG, saved.fatG]).toEqual([2270, 260, 150, 70]);
    });

    test("Today: the morning check-in field to field — what the readings add above waits, what is shown is true", async ({ page }) => {
      await onboardedOn(page, MONDAY);
      // Three weeks of readings: an HRV of 20 against them is a warning that takes the first line
      // of Signals (two lines of text where one was), and VO2 max and the ratings give the Morning
      // row its second line.
      await seedHistory(page);
      await page.reload();
      await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
      await withoutScrollAnchoring(page);
      const signal = page.locator("[data-signals] li").first();
      const signalBefore = await signal.textContent();
      expect(signalBefore).toBeTruthy();
      /** The first signal as it was when typing (last) began. */
      let signalHeld = signalBefore;
      const morning = page.getByRole("button", { name: /^Morning check-in/ });
      await morning.tap();
      // The row near the top of the screen: its whole editor is clear of the nav at both sizes.
      await morning.evaluate((el) => window.scrollBy(0, el.getBoundingClientRect().top - 72));
      const editor = page.getByRole("group", { name: "Morning check-in details" });
      const field = (name: string) => editor.getByRole("textbox", { name, exact: true });
      const SLEEP = "Sleep duration, hours and minutes";
      const names = ["Morning weight", SLEEP, "Sleep score", "HRV", "Resting HR", "VO2 max"];
      // Opening the editor on a day without a weight puts the caret in it.
      await expect(field("Morning weight")).toBeFocused();
      await expect.poll(async () => (await place(field("VO2 max"))).top, { intervals: [150] }).toBe((await place(field("VO2 max"))).top);
      await page.waitForTimeout(400);
      await watchInput(page);
      /** The lines under the Morning row's label. */
      const rowLines = () => morning.locator(".truncate").allTextContents();
      expect(await rowLines()).toEqual(["Weight · sleep · recovery"]);

      /** Where every field of the editor is in the page, and on screen. */
      const all = async () => {
        const out: Record<string, { top: number; docTop: number }> = {};
        for (const name of names) {
          const p = await place(field(name));
          out[name] = { top: p.top, docTop: p.docTop };
        }
        return out;
      };
      /** Type into the focused field key by key: no keystroke moves it or the page. */
      const type = async (name: string, value: string) => {
        await expect(field(name)).toBeFocused();
        await takeInputs(page);
        const before = await place(field(name));
        for (const ch of value) {
          await press(page, ch);
          const [at] = await takeInputs(page);
          expect(at!.scrollY, `${name}: scroll position in the input event of "${ch}"`).toBe(before.scrollY);
          await settled(page);
          const after = await place(field(name));
          expect(after.scrollY, `${name}: scroll position after "${ch}"`).toBe(before.scrollY);
          expect(Math.abs(after.top - before.top), `${name}: the field's top after "${ch}"`).toBeLessThanOrEqual(0.5);
        }
      };
      /** Leave the focused field for `name` by a tap: its value is saved (or refused), and no field of the editor moves. */
      const moveTo = async (name: string, from: string) => {
        await field(name).scrollIntoViewIfNeeded();
        await settled(page);
        const before = await all();
        const y = await page.evaluate(() => window.scrollY);
        await field(name).tap();
        await expect(field(name)).toBeFocused();
        // The save has reached the page (a task later) and the server.
        await expectSynced(page);
        await settled(page);
        expect(await page.evaluate(() => window.scrollY), `nothing scrolled as ${from} was left`).toBe(y);
        const after = await all();
        for (const n of names) {
          expect(Math.abs(after[n]!.top - before[n]!.top), `${n} moved on screen when ${from} was left`).toBeLessThanOrEqual(0.5);
          expect(Math.abs(after[n]!.docTop - before[n]!.docTop), `${n} moved in the page when ${from} was left`).toBeLessThanOrEqual(0.5);
        }
        // Above the editor: the signal as it was when typing began, and the row with as many lines as it had.
        expect(await signal.textContent(), `the first signal after ${from} was left`).toBe(signalHeld);
        expect(await rowLines(), `the Morning row's lines after ${from} was left`).toHaveLength(1);
      };

      await type("Morning weight", "199.4");
      await moveTo(SLEEP, "the weight");
      // What is shown is the day as it is: the row is done, with its weight — said to a screen reader too.
      await expect(morning).toContainText("Morning check-in, done");
      await expect(morning).toContainText("199.4");
      await type(SLEEP, "730");
      await moveTo("Sleep score", "the sleep");
      expect(await rowLines()).toEqual(["7h 30m"]);
      await type("Sleep score", "55");
      await moveTo("HRV", "the sleep score");
      expect(await rowLines()).toEqual(["7h 30m · sleep score 55"]);

      // A reading out of range is refused as its field is left: the range hangs under the field, and moves nothing.
      await type("HRV", "900");
      await moveTo("Resting HR", "a refused HRV");
      const hint = editor.locator("[data-range-hint]");
      await expect(hint).toHaveText("HRV not saved: use 0–500 ms");
      await expect(field("HRV")).toHaveValue("");
      await moveTo("HRV", "the (empty) resting HR");
      await type("HRV", "20");

      // The phone is put down and picked up again, the field still focused: the page may catch up
      // at that moment (nobody's finger is on it) — and holds again for the next field.
      await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      await page.waitForTimeout(400);
      signalHeld = await signal.textContent();
      // HRV 20 is saved as the resting HR is tapped: it changes the first signal — not now, and nothing moves.
      await moveTo("Resting HR", "the HRV (after coming back to the app)");
      await expect(hint).toHaveCount(0);
      expect(await rowLines()).toEqual(["7h 30m · sleep score 55 · HRV 20"]);
      await type("Resting HR", "80");
      await moveTo("VO2 max", "the resting HR");
      expect(await rowLines()).toEqual(["7h 30m · sleep score 55 · HRV 20 · RHRresting heart rate 80"]);
      await type("VO2 max", "50.1");

      // Everything left so far is on the server.
      const saved = (await serverData(page)).days.find((d) => d.date === MONDAY_ISO)!;
      expect([saved.weightLb, saved.sleepMinutes, saved.sleepScore, saved.hrvMs, saved.restingHrBpm]).toEqual([199.4, 450, 55, 20, 80]);

      // A rating tapped with the keyboard still up, played both ways a browser may: first a tap that
      // leaves focus in the field — saved, shown on the scale, nothing moves, the row's new line waits.
      const energy = editor.getByRole("radio", { name: "Energy 4 of 5" });
      const beforeRating = await all();
      await tapKeepingFocus(energy);
      await expect(energy).toHaveAttribute("aria-checked", "true");
      await expect(field("VO2 max")).toBeFocused();
      await expectSynced(page);
      await settled(page);
      const afterRating = await all();
      for (const n of names)
        expect(Math.abs(afterRating[n]!.top - beforeRating[n]!.top), `${n} moved when Energy was rated`).toBeLessThanOrEqual(0.5);
      expect(await rowLines(), "the Morning row while the field has focus").toHaveLength(1);

      // Then a tap that takes focus from the field: it lands on the disc it was aimed at — nothing
      // moved under it — and then, no field having focus, the page catches up with everything typed.
      const soreness = editor.getByRole("radio", { name: "Soreness 2 of 5" });
      await soreness.tap();
      await expect(soreness).toHaveAttribute("aria-checked", "true");
      await expect
        .poll(rowLines)
        .toEqual(["7h 30m · sleep score 55 · HRV 20 · RHRresting heart rate 80", "VO2 50.1 · energy 4/5 · soreness 2/5"]);
      // The signal the readings make is there now — it was not while a field had focus.
      expect(signalHeld).toBe(signalBefore);
      await expect(signal).not.toHaveText(signalBefore!);
      await expect(signal).toContainText(/HRV|resting HR/i);
      await expectSynced(page);
      const end = (await serverData(page)).days.find((d) => d.date === MONDAY_ISO)!;
      expect([end.vo2Max, end.energy, end.soreness]).toEqual([50.1, 4, 2]);
    });

    test("Today: steps typed, then on to the journal — the row says the steps at once, its bar waits until no field has focus", async ({
      page,
    }) => {
      await onboardedOn(page, MONDAY);
      await withoutScrollAnchoring(page);
      const row = page.getByRole("button", { name: /^Steps/ });
      await row.tap();
      const steps = page.getByRole("group", { name: "Steps details" }).getByRole("textbox", { name: "Steps", exact: true });
      const journal = page.getByRole("textbox", { name: "Journal" });
      await expect(steps).toBeVisible();
      await page.waitForTimeout(600);
      await steps.tap();
      await expect(steps).toBeFocused();
      for (const ch of "9000") await press(page, ch);
      const bar = row.locator(".w-32");
      await expect(bar).toHaveCount(0);

      // Straight on to the journal, under the checklist: the steps are saved, and the journal is where it was.
      await journal.scrollIntoViewIfNeeded();
      await settled(page);
      const before = await place(journal);
      await journal.tap();
      await expect(journal).toBeFocused();
      await expectSynced(page);
      expect((await serverData(page)).days.find((d) => d.date === MONDAY_ISO)!.steps).toBe(9000);
      await settled(page);
      const after = await place(journal);
      expect(Math.abs(after.docTop - before.docTop), "the journal moved in the page when the steps were saved").toBeLessThanOrEqual(0.5);
      expect(Math.abs(after.top - before.top), "the journal moved on screen when the steps were saved").toBeLessThanOrEqual(0.5);
      // The row says what is saved; the bar (a line more) waits.
      await expect(row).toContainText("9,000");
      await expect(row).toContainText("Steps, not done");
      await expect(bar).toHaveCount(0);
      for (const ch of "ok") await press(page, ch);
      expect(Math.abs((await place(journal)).top - before.top)).toBeLessThanOrEqual(0.5);

      // The keyboard goes: the bar is there.
      await journal.blur();
      await expect(bar).toBeVisible();

      // Past the target, and on to the journal again: the row is done at once — never "not done"
      // beside a filled dot — and the bar, there when typing began, stays (full) until focus leaves.
      await steps.tap();
      await steps.press("ControlOrMeta+a");
      for (const ch of "16000") await press(page, ch);
      await journal.scrollIntoViewIfNeeded();
      await settled(page);
      const again = await place(journal);
      await journal.tap();
      await expect(journal).toBeFocused();
      await expectSynced(page);
      await settled(page);
      expect(
        Math.abs((await place(journal)).docTop - again.docTop),
        "the journal moved when the steps passed the target",
      ).toBeLessThanOrEqual(0.5);
      await expect(row).toContainText("Steps, done");
      await expect(row).toContainText("16,000");
      await expect(row).not.toContainText("not done");
      await expect(bar).toHaveCount(1);
      await journal.blur();
      await expect(bar).toHaveCount(0);
    });

    test("Today: what a saved value brings sits under every field — micronutrients open, the metcon's notes", async ({ page }) => {
      await onboardedOn(page, MONDAY);
      await seedHistory(page);
      // Calories equal to what the macros make (no chip yet), and a micronutrient logged: its block is open.
      const res = await page.request.put(`/api/days/${MONDAY_ISO}`, {
        data: { weightLb: 199, calories: 2140, proteinG: 200, carbsG: 200, fatG: 60, micros: { "Fiber g": 30 } },
      });
      expect(res.ok()).toBe(true);
      // And a benchmark done before: there are recent names to offer, and a best so far.
      const fran = await page.request.put("/api/days/2026-10-20", {
        data: { metconDone: true, metconBenchmark: "Fran", metconScore: "4:10" },
      });
      expect(fran.ok()).toBe(true);
      await page.reload();
      await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
      await withoutScrollAnchoring(page);
      const nutrition = page.getByRole("button", { name: /^Nutrition/ });
      await nutrition.tap();
      await nutrition.evaluate((el) => window.scrollBy(0, el.getBoundingClientRect().top - 72));
      const editor = page.getByRole("group", { name: "Nutrition details" });
      const boxes = editor.getByRole("textbox");
      const fat = editor.getByRole("textbox", { name: "Fat", exact: true });
      const fiber = editor.getByRole("textbox", { name: "Fiber g", exact: true });
      await expect(fiber).toBeVisible();
      await page.waitForTimeout(700);
      const tops = () =>
        boxes.evaluateAll((els) => els.map((el) => Math.round((el.getBoundingClientRect().top + window.scrollY) * 10) / 10));

      // Fat 60 → 70, then on to a micronutrient: the chip comes — under the micronutrients, moving none of them.
      await fat.tap();
      await fat.press("ControlOrMeta+a");
      for (const ch of "70") await press(page, ch);
      await fiber.scrollIntoViewIfNeeded();
      await settled(page);
      const before = await tops();
      expect(before.length).toBeGreaterThan(8);
      const fiberBefore = await place(fiber);
      await fiber.tap();
      await expect(fiber).toBeFocused();
      const chip = editor.getByRole("button", { name: "Use 2,230 from macros" });
      await expect(chip).toBeVisible();
      await expectSynced(page);
      await settled(page);
      expect(await tops(), "no field of the editor moved when Fat was saved").toEqual(before);
      expect(
        Math.abs((await place(fiber)).top - fiberBefore.top),
        "the micronutrient tapped is where it was on screen",
      ).toBeLessThanOrEqual(0.5);
      expect((await chip.boundingBox())!.y, "the chip is under the last field").toBeGreaterThan((await boxes.last().boundingBox())!.y);
      // And going: the calories the macros make, typed by hand.
      await fiber.blur();

      // Metcon: the name, then the notes. The best so far (and, before, the recent names) are under the notes.
      const metcon = page.locator("button[aria-controls]").filter({ hasText: /^Metcon/ });
      await metcon.tap();
      await metcon.evaluate((el) => window.scrollBy(0, el.getBoundingClientRect().top - 72));
      const details = page.getByRole("group", { name: "Metcon details" });
      const name = details.locator('input[aria-label="Benchmark name"]');
      const notes = details.getByRole("textbox", { name: "Metcon notes" });
      await expect(notes).toBeVisible();
      await page.waitForTimeout(700);
      await expect(details.getByRole("group", { name: "Recent benchmarks" })).toBeVisible();
      await name.tap();
      for (const ch of "Fran") await press(page, ch);
      // The notes well clear of the nav, so that the browser has no reason of its own to scroll for the tap.
      await page.evaluate((by) => window.scrollBy(0, by), Math.round((await place(notes)).bottom - ((await place(notes)).clear - 120)));
      await settled(page);
      const notesBefore = await place(notes);
      await notes.tap();
      await expect(notes).toBeFocused();
      await expectSynced(page);
      await settled(page);
      const best = details.getByRole("button", { name: /^Best / });
      await expect(best).toBeVisible();
      await expect(details.getByRole("group", { name: "Recent benchmarks" })).toHaveCount(0);
      const notesAfter = await place(notes);
      expect(Math.abs(notesAfter.docTop - notesBefore.docTop), "the notes moved in the page when the name was saved").toBeLessThanOrEqual(
        0.5,
      );
      expect(Math.abs(notesAfter.top - notesBefore.top), "the notes moved on screen when the name was saved").toBeLessThanOrEqual(0.5);
      expect((await best.boundingBox())!.y).toBeGreaterThan(notesAfter.bottom - 1);
    });

    test("Today: the 'saved' tick coming and going moves no text area — journal, metcon notes", async ({ page }) => {
      await onboardedOn(page, MONDAY);
      await withoutScrollAnchoring(page);
      const journal = page.getByRole("textbox", { name: "Journal" });
      await journal.tap();
      for (const ch of "Good") await press(page, ch);
      // The save goes out 0.9 s after the last key and is acknowledged: the tick shows in the section's
      // header, above the text, for 1.2 s. Typing goes on through it.
      const watching = placesOver(journal, 3400);
      await page.waitForTimeout(1100);
      await expect(
        page
          .locator("section")
          .filter({ has: page.getByRole("heading", { name: "Journal" }) })
          .getByText("saved"),
      ).toBeVisible();
      for (const ch of " day") await press(page, ch);
      expect(await watching, "where the journal was, frame by frame, as its tick came and went").toHaveLength(1);
      await journal.blur();
      await expectSynced(page);

      const metcon = page.locator("button[aria-controls]").filter({ hasText: /^Metcon/ });
      await metcon.tap();
      const notes = page.getByRole("group", { name: "Metcon details" }).getByRole("textbox", { name: "Metcon notes" });
      await expect(notes).toBeVisible();
      await page.waitForTimeout(700);
      await notes.tap();
      for (const ch of "amrap") await press(page, ch);
      const watchingNotes = placesOver(notes, 3400);
      await page.waitForTimeout(1100);
      await expect(metcon.getByText("saved")).toBeVisible();
      for (const ch of " 20") await press(page, ch);
      expect(await watchingNotes, "where the metcon notes were as the row's tick came and went").toHaveLength(1);
    });

    test("Today: Zone 2 — typing a machine reading moves no field, however long the numbers; a refused one hangs under its field", async ({
      page,
    }) => {
      await onboardedOn(page, MONDAY);
      // Minutes with three digits: where both fields don't fit side by side, they never try to.
      expect((await page.request.put(`/api/days/${MONDAY_ISO}`, { data: { zone2Done: true, zone2Minutes: 120 } })).ok()).toBe(true);
      await page.reload();
      await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
      await withoutScrollAnchoring(page);
      const row = page.locator("button[aria-controls]").filter({ hasText: /^Zone 2/ });
      await row.tap();
      await row.evaluate((el) => window.scrollBy(0, el.getBoundingClientRect().top - 72));
      const editor = page.getByRole("group", { name: "Zone 2 details" });
      const minutes = editor.getByRole("textbox", { name: "Zone 2 minutes" });
      const kcal = editor.getByRole("textbox", { name: "Zone 2 machine calories" });
      await expect(kcal).toBeVisible();
      await page.waitForTimeout(700);
      await kcal.tap();
      await expect(kcal).toBeFocused();
      let was = { kcal: await place(kcal), minutes: await place(minutes) };
      // Key by key up to four digits, and back down: neither field moves, up, down or sideways.
      for (const key of ["2", "5", "0", "0", "Backspace", "Backspace", "Backspace", "Backspace", "3", "1", "0"]) {
        await page.keyboard.press(key);
        await settled(page);
        const now = { kcal: await place(kcal), minutes: await place(minutes) };
        for (const f of ["kcal", "minutes"] as const) {
          expect(Math.abs(now[f].top - was[f].top), `${f} field moved up or down for "${key}"`).toBeLessThanOrEqual(0.5);
          expect(Math.abs(now[f].left - was[f].left), `${f} field moved sideways for "${key}"`).toBeLessThanOrEqual(0.5);
        }
        expect(now.kcal.focused).toBe(true);
        was = now;
      }
      // Saved as the minutes are tapped: nothing moves.
      await minutes.tap();
      await expect(minutes).toBeFocused();
      await expectSynced(page);
      await settled(page);
      expect(Math.abs((await place(minutes)).top - was.minutes.top)).toBeLessThanOrEqual(0.5);
      expect((await serverData(page)).days.find((d) => d.date === MONDAY_ISO)!.zone2Kcal).toBe(310);

      // A reading the machine can't have shown is refused as its field is left: the range hangs under
      // the field, in the place of the note below it (which makes way), and moves nothing.
      await kcal.tap();
      await kcal.press("ControlOrMeta+a");
      for (const ch of "9999") await press(page, ch);
      const before = { kcal: await place(kcal), minutes: await place(minutes), bottom: (await editor.boundingBox())!.height };
      await minutes.tap();
      await expect(minutes).toBeFocused();
      await settled(page);
      const hint = editor.locator("[data-range-hint]");
      await expect(hint).toHaveText("Zone 2 machine calories not saved: use 0–3000 kcal");
      await expect(editor.getByText("Machine reading · not added to intake")).toBeHidden();
      expect(
        Math.abs((await place(minutes)).top - before.minutes.top),
        "the minutes moved when the reading was refused",
      ).toBeLessThanOrEqual(0.5);
      expect(Math.abs((await place(kcal)).top - before.kcal.top)).toBeLessThanOrEqual(0.5);
      expect((await editor.boundingBox())!.height, "the editor is as tall as it was").toBe(before.bottom);
      await expect(kcal).toHaveValue("310");
    });

    test("Today: a number typed and not yet committed is saved — once — when the app is hidden, its editor closed, or another day shown", async ({
      page,
      context,
    }) => {
      await watchOps(context);
      await onboardedOn(page, MONDAY);
      const row = page.locator("button[aria-controls]").filter({ hasText: /^Steps/ });
      const steps = page.getByRole("group", { name: "Steps details" }).getByRole("textbox", { name: "Steps", exact: true });
      const serverSteps = async (date = MONDAY_ISO) => (await serverData(page)).days.find((d) => d.date === date)?.steps ?? null;
      const open = async () => {
        await row.tap();
        await expect(steps).toBeVisible();
        await page.waitForTimeout(500);
        await steps.tap();
        await expect(steps).toBeFocused();
        await steps.press("ControlOrMeta+a");
      };

      // Typed, the keyboard still up — and the app goes to the background.
      await open();
      for (const ch of "9000") await press(page, ch);
      expect(await opsWriting(page, "steps")).toHaveLength(0);
      await hidden(page, true);
      await expectSynced(page);
      expect(await serverSteps()).toBe(9000);
      expect(await opsWriting(page, "steps")).toEqual([{ kind: "day", date: MONDAY_ISO, patch: { steps: 9000 } }]);
      // Back: the field is as it was left, and leaving it saves nothing a second time.
      await hidden(page, false);
      await expect(steps).toBeFocused();
      await expect(steps).toHaveValue("9000");
      await steps.press("Enter");
      await page.waitForTimeout(300);
      await expectSynced(page);
      expect(await opsWriting(page, "steps")).toHaveLength(1);

      // Typed, and the editor is closed by a tap that takes no focus from the field: no blur reaches a field that is removed.
      await steps.tap();
      await steps.press("ControlOrMeta+a");
      for (const ch of "9500") await press(page, ch);
      await tapKeepingFocus(row);
      await expect(steps).toHaveCount(0);
      await expectSynced(page);
      expect(await serverSteps()).toBe(9500);
      expect((await opsWriting(page, "steps")).map((op) => op.patch!.steps)).toEqual([9000, 9500]);
      await expect(row).toContainText("9,500");

      // Typed, and another day is shown: the number goes to the day it was typed for.
      await open();
      for (const ch of "9900") await press(page, ch);
      await tapKeepingFocus(page.getByRole("button", { name: "Previous day" }));
      await expect(page).toHaveURL(/\/day\/2026-10-25$/);
      await expectSynced(page);
      expect(await serverSteps()).toBe(9900);
      expect(await serverSteps("2026-10-25")).toBeNull();
      expect(await opsWriting(page, "steps")).toEqual(
        [9000, 9500, 9900].map((n) => ({ kind: "day", date: MONDAY_ISO, patch: { steps: n } })),
      );

      // Not saved: a reading out of range, half a number that leaving the field would round up to the limit, an emptied field.
      await page.getByRole("button", { name: "Next day" }).tap();
      await expect(page).toHaveURL(/\/$/);
      const morning = page.locator("button[aria-controls]").filter({ hasText: /^Morning check-in/ });
      await morning.tap();
      const details = page.getByRole("group", { name: "Morning check-in details" });
      await expect(details.getByRole("textbox", { name: "HRV" })).toBeVisible();
      await page.waitForTimeout(500);
      const before = (await page.evaluate(() => (window as unknown as { __ops: unknown[] }).__ops)).length;
      await details.getByRole("textbox", { name: "Morning weight" }).tap();
      await press(page, "1"); // on the way to 199: under the 50 lb a weight can be
      await hidden(page, true);
      await hidden(page, false);
      await details.getByRole("textbox", { name: "Morning weight" }).press("Backspace");
      await details.getByRole("textbox", { name: "HRV" }).tap(); // an emptied weight, left: nothing to save (there was none)
      for (const ch of "900") await press(page, ch);
      await hidden(page, true);
      await hidden(page, false);
      await page.waitForTimeout(300);
      expect(
        (await page.evaluate(() => (window as unknown as { __ops: unknown[] }).__ops)).length,
        "ops queued for numbers that can't be saved",
      ).toBe(before);
      const day = (await serverData(page)).days.find((d) => d.date === MONDAY_ISO)!;
      expect([day.weightLb, day.hrvMs]).toEqual([null, null]);
    });

    test("Train: a set editor's number field and the exercise search ride the keyboard", async ({ page }) => {
      await onboardedOn(page, MONDAY);
      await page.goto("/train");
      await page.getByRole("button", { name: /^Edit Bench press set 2:/ }).tap();
      const editor = page.getByRole("dialog", { name: "Bench press · set 2" });
      await editor.getByRole("button", { name: /^load \d+, edit$/ }).tap();
      const load = editor.getByRole("textbox", { name: "load" });
      await expect(load).toBeFocused();
      // The sheet has come to rest.
      await page.waitForTimeout(600);
      await load.press("ControlOrMeta+a");
      await typeInSheetThroughKeyboardChanges(page, load, "172.5", viewport);
      await expect(load).toHaveValue("172.5");
      await load.press("Enter");
      await editor.getByRole("button", { name: "Save target" }).tap();
      await expect(editor).toHaveCount(0);
      await expect(page.getByRole("button", { name: /^Edit Bench press set 2: 172\.5/ })).toBeVisible();

      await page.getByRole("button", { name: "Exercise", exact: true }).tap();
      const add = page.getByRole("dialog", { name: "Add exercise" });
      const search = add.getByRole("textbox", { name: "Search or create exercise" });
      await expect(search).toBeFocused();
      await page.waitForTimeout(600);
      await typeInSheetThroughKeyboardChanges(page, search, "Face pull", viewport);
      await expect(search).toHaveValue("Face pull");
      await add.getByRole("button", { name: "Close" }).tap();
      await expect(add).toHaveCount(0);

      // A load typed into the set editor and abandoned with it (closed with the keyboard still up, by
      // a tap that takes no focus from the field): the sheet's own buttons save — closing it doesn't.
      const third = page.getByRole("button", { name: /^Edit Bench press set 3:/ });
      const was = await third.getAttribute("aria-label");
      await expectSynced(page);
      const sessionBefore = (await serverData(page)).sessions.find((s) => s.date === MONDAY_ISO);
      await third.tap();
      const abandoned = page.getByRole("dialog", { name: "Bench press · set 3" });
      await abandoned.getByRole("button", { name: /^load \d+, edit$/ }).tap();
      const draft = abandoned.getByRole("textbox", { name: "load" });
      await expect(draft).toBeFocused();
      await draft.press("ControlOrMeta+a");
      for (const ch of "999") await press(page, ch);
      await hidden(page, true);
      await hidden(page, false);
      await tapKeepingFocus(abandoned.getByRole("button", { name: "Close" }));
      await expect(abandoned).toHaveCount(0);
      await expect(third).toHaveAttribute("aria-label", was!);
      await page.waitForTimeout(300);
      await expectSynced(page);
      expect((await serverData(page)).sessions.find((s) => s.date === MONDAY_ISO)).toEqual(sessionBefore);
    });

    // What this proves: with the notes clear of the dock (the page at its end), the app scrolls
    // nothing and takes neither focus, caret nor text when a save goes out, the sync pill arrives
    // in the dock and goes, while resting. What it doesn't: a field right above the dock when the
    // dock grows — the browser then brings the caret clear of it at the next key (scroll-padding),
    // which is by design here and can't be checked for a phone keyboard in this browser.
    test("Train: a save and the sync pill arriving mid-typing — the app scrolls nothing and keeps focus, caret and text (notes clear of the dock)", async ({
      page,
    }) => {
      await onboardedOn(page, MONDAY);
      await page.goto("/train");
      const notes = page.getByRole("textbox", { name: "Session notes" });
      await expect(notes).toBeVisible();
      await withoutScrollAnchoring(page);
      // A set logged: the rest pill is in the dock, and Train keeps the next set clear of the dock while resting.
      await page.getByRole("button", { name: /^Bench press set 1:/ }).tap();
      await expect(page.getByRole("group", { name: "Rest timer" })).toBeVisible();
      await expectSynced(page);
      // From here the server is slow: a save stays pending long enough for "Syncing…" to show.
      await page.route("**/api/**", async (route) => {
        if (route.request().method() !== "GET") await new Promise((r) => setTimeout(r, 2600));
        await route.continue();
      });
      await toPageEnd(page);
      await notes.tap();
      await expect(notes).toBeFocused();
      await toPageEnd(page);
      await settled(page);
      await watchInput(page);
      const start = await place(notes);
      const pill = page.getByRole("region", { name: "Notifications" }).getByText("Syncing…", { exact: true }).last();
      let sawPill = false;
      let typed = "";
      // One line, a key every 150 ms, for about 7 s: the first save goes out 900 ms after a pause…
      const keys = "felt strong today".split("");
      for (let i = 0; i < 46; i++) {
        const ch = keys[i % keys.length]!;
        // …so pause once, early, and keep typing while that save is pending and then confirmed.
        if (i === 6) await page.waitForTimeout(1000);
        await press(page, ch);
        typed += ch;
        const [at] = await takeInputs(page);
        expect(at!.scrollY, `scroll position in the input event of key ${i}`).toBe(start.scrollY);
        await page.waitForTimeout(150);
        const now = await place(notes);
        sawPill ||= await pill.isVisible();
        expect(now.scrollY, `scroll position after key ${i}`).toBe(start.scrollY);
        expect(Math.abs(now.top - start.top), `the field's top after key ${i}`).toBeLessThanOrEqual(0.5);
        expect(now.focused, `focus after key ${i}`).toBe(true);
        expect(now.caret, `caret after key ${i}`).toBe(typed.length);
        expect(now.value, `text after key ${i}`).toBe(typed);
      }
      expect(sawPill, "the sync pill showed while typing").toBe(true);
      await page.unroute("**/api/**");
      await notes.blur();
      await expectSynced(page);
      expect((await serverData(page)).sessions.find((s) => s.date === MONDAY_ISO)!.notes).toBe(typed);
    });

    test("Today: a sync landing mid-typing takes neither focus, caret nor text — and is said at once, less the lines it would add", async ({
      page,
    }) => {
      await onboardedOn(page, MONDAY);
      // A weight for the day, so that Fuel has a target to count what was eaten against.
      expect((await page.request.put(`/api/days/${MONDAY_ISO}`, { data: { weightLb: 199 } })).ok()).toBe(true);
      await page.reload();
      await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
      const journal = page.getByRole("textbox", { name: "Journal" });
      await expect(journal).toBeVisible();
      await withoutScrollAnchoring(page);
      await journal.tap();
      for (const ch of "Slept well") await press(page, ch);
      await journal.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(5, 5));
      // The text so far is saved (after a pause in typing), and the last read of the server is a
      // while ago: the app doesn't re-read within 5 s of one.
      await expectSynced(page);
      await page.waitForTimeout(5200);
      const before = await place(journal);
      expect(before.focused).toBe(true);

      // Another device saves the same day — a journal of its own, the calories, a coffee — and this
      // one reads the server again, as it does coming back to the foreground. The answer takes a
      // moment, and the typing goes on meanwhile: it lands with the field in use.
      const put = await page.request.put(`/api/days/${MONDAY_ISO}`, {
        data: { journal: "Written on the laptop", calories: 1800, caffeine: true },
      });
      expect(put.ok()).toBe(true);
      await page.route("**/api/bootstrap", async (route) => {
        await new Promise((r) => setTimeout(r, 700));
        await route.continue();
      });
      const read = page.waitForResponse((r) => r.url().includes("/api/bootstrap") && r.request().method() === "GET");
      await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      await press(page, "!");
      await read;
      const nutrition = page.getByRole("button", { name: /^Nutrition/ });
      // The other device's calories are on the page: eaten against the target, and in the Nutrition row…
      await expect(page.locator("[data-fuel-eaten]")).toHaveText("1,800 eaten");
      await expect(nutrition).toContainText("1,800");
      await expect(nutrition).toContainText("Nutrition, done");
      // …whose new line (the coffee) waits: it would make the row, above the field, a line taller.
      await expect(nutrition.locator(".truncate")).toHaveCount(1);

      const after = await place(journal);
      expect(after.focused, "focus after the sync").toBe(true);
      expect(after.value, "the text being typed").toBe("Slept! well");
      expect(after.caret, "the caret").toBe(6);
      expect(Math.abs(after.top - before.top), "the field's place").toBeLessThanOrEqual(0.5);
      expect(after.scrollY).toBe(before.scrollY);
      // Typing goes on where the caret was.
      await press(page, "?");
      await expect(journal).toHaveValue("Slept!? well");
      expect((await place(journal)).caret).toBe(7);
      // Focus leaves the field: the row has its new line, and nothing of the sync was lost.
      await journal.blur();
      await expect(nutrition.locator(".truncate")).toHaveText(["Daily totals", "Had caffeine"]);
      await page.unroute("**/api/bootstrap");
    });
  });
}
