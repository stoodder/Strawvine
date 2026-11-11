/**
 * The field being typed in stays where it is: nothing the app does for a keystroke, for a value
 * saved as its field is left for the next one, for a save or a sync landing mid-typing, or for a
 * phone keyboard changing size may move it — only the field's own growth moves anything, and the
 * browser then keeps the caret in view by itself.
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
 * What only an iPhone can show (Safari's own pan to a focused field, the real keyboard) is not
 * tested here.
 */
import type { Locator, Page } from "@playwright/test";
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

      /** Tap `name`, type `value` key by key: no keystroke moves the field or the page. Returns where the field ended up. */
      const enter = async (name: string, value: string) => {
        await field(name).tap();
        await expect(field(name)).toBeFocused();
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
      await field("Calories").tap();
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
    });

    test("Train: a save and the sync pill arriving mid-typing move nothing, resting or not", async ({ page }) => {
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

    test("Today: a sync landing mid-typing takes neither focus, caret nor text", async ({ page }) => {
      await onboardedOn(page, MONDAY);
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

      // Another device saves the same day — a journal of its own and the calories — and this one
      // reads the server again (as it does coming back to the foreground) while the field has focus.
      const put = await page.request.put(`/api/days/${MONDAY_ISO}`, { data: { journal: "Written on the laptop", calories: 1800 } });
      expect(put.ok()).toBe(true);
      const read = page.waitForResponse((r) => r.url().includes("/api/bootstrap") && r.request().method() === "GET");
      await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      await read;
      // The other device's calories are on the page: the sync landed.
      await expect(page.getByRole("button", { name: /^Nutrition/ })).toContainText("1,800");

      const after = await place(journal);
      expect(after.focused, "focus after the sync").toBe(true);
      expect(after.value, "the text being typed").toBe("Slept well");
      expect(after.caret, "the caret").toBe(5);
      expect(Math.abs(after.top - before.top), "the field's place").toBeLessThanOrEqual(0.5);
      expect(after.scrollY).toBe(before.scrollY);
      // Typing goes on where the caret was.
      await press(page, "!");
      await expect(journal).toHaveValue("Slept! well");
      expect((await place(journal)).caret).toBe(6);
    });
  });
}
