/**
 * Text contrast measured against what is actually painted behind the text — gradients, tinted
 * surfaces, nested spans, chart fills — rather than a guessed background colour.
 *
 * How: note every text element's colour (with the opacity it is drawn at) and its text boxes,
 * screenshot the page once with all text made transparent, and compare the colour with the
 * pixels under each text box. Used by scripts/contrast-audit.mjs (every text on a screen) and by
 * e2e/11-a11y.spec.ts (the nodes axe leaves "incomplete": gradients, text over charts).
 *
 * The ratio reported for an element is the 10th percentile over the pixels behind its text, so a
 * hairline or a chart line crossing a label doesn't decide alone, but a gradient's dark half does.
 *
 *   const results = await measureTextContrast(page, { targets: ["#root p.label", …], highContrast: false });
 *   results.filter((r) => r.ratio < r.required)
 */

/** Runs in the page: tag and describe the text elements to measure. */
function collectInPage({ targets, within }) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  /** Any CSS colour (oklab(), color-mix() results, rgba()…) → sRGB 0–255 + alpha 0–1, via the canvas. */
  const rgba = (css) => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = "#000";
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    return [r, g, b, a / 255];
  };
  const visible = (el) => {
    for (let e = el; e; e = e.parentElement) {
      const s = getComputedStyle(e);
      if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false;
      // Visually hidden (sr-only: a 1 px clipped box) — read by screen readers, never seen. Not
      // asked of <html>: while a sheet pins the page (body position: fixed) it has no in-flow
      // content, so it is 0 px tall, and it clips sideways — yet everything in it shows.
      if (e === document.documentElement) continue;
      const r = e.getBoundingClientRect();
      if ((r.width <= 1 || r.height <= 1) && (s.overflow !== "visible" || s.clip !== "auto" || s.clipPath !== "none")) return false;
    }
    return true;
  };
  /** Disabled controls are exempt from contrast minimums (WCAG 1.4.3). */
  const disabled = (el) => !!el.closest(":disabled, [aria-disabled=true]");
  const opacity = (el) => {
    let o = 1;
    for (let e = el; e; e = e.parentElement) o *= Number(getComputedStyle(e).opacity);
    return o;
  };
  const ownText = (el) =>
    [...el.childNodes]
      .filter((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim())
      .map((n) => n.textContent)
      .join("")
      .trim();
  const isField = (el) =>
    (el instanceof HTMLInputElement && !["checkbox", "radio", "range", "hidden", "color", "file"].includes(el.type)) ||
    el instanceof HTMLTextAreaElement;
  const describe = (el) => {
    const cls = typeof el.className === "string" ? el.className.split(/\s+/).filter(Boolean).slice(0, 5).join(".") : "";
    const label = el.getAttribute("aria-label");
    return `${el.tagName.toLowerCase()}${cls ? "." + cls : ""}${label ? `[aria-label="${label}"]` : ""}`;
  };
  /** Where on the page: the nearest section heading / landmark, for the report. */
  const context = (el) => {
    const dialog = el.closest("[role=dialog]");
    if (dialog) {
      const labelledBy = dialog.getAttribute("aria-labelledby");
      const name =
        dialog.getAttribute("aria-label") ??
        (labelledBy ? document.getElementById(labelledBy)?.textContent : null) ??
        dialog.querySelector("h2, h3")?.textContent ??
        "";
      return `dialog "${name.trim().slice(0, 40)}"`;
    }
    if (el.closest("nav")) return "nav";
    if (el.closest("[data-dock]")) return "dock";
    const section = el.closest("section");
    const heading = section?.querySelector("h2, h3, .label")?.textContent?.trim();
    return heading ? `section "${heading.slice(0, 40)}"` : "";
  };

  let elements;
  if (targets) elements = targets.map((t) => document.querySelector(t)).filter(Boolean);
  else
    elements = [...((within ? document.querySelector(within) : document.body)?.querySelectorAll("*") ?? [])].filter(
      (el) =>
        !(el instanceof SVGElement) &&
        !["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"].includes(el.tagName) &&
        (ownText(el) || (isField(el) && el.value)),
    );

  const items = [];
  elements.forEach((el, i) => {
    if (!visible(el) || disabled(el)) return;
    const rects = [];
    if (isField(el)) {
      if (!el.value) return;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      const pl = parseFloat(s.paddingLeft) + parseFloat(s.borderLeftWidth);
      const pr = parseFloat(s.paddingRight) + parseFloat(s.borderRightWidth);
      const pt = parseFloat(s.paddingTop) + parseFloat(s.borderTopWidth);
      const pb = parseFloat(s.paddingBottom) + parseFloat(s.borderBottomWidth);
      rects.push({ x: r.left + pl, y: r.top + pt, w: r.width - pl - pr, h: r.height - pt - pb });
    } else {
      const textNodes = [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
      // targets from axe may name an element whose text is in its children: measure those.
      const nodes = textNodes.length ? textNodes : [el];
      for (const n of nodes) {
        const range = document.createRange();
        range.selectNodeContents(n);
        for (const r of range.getClientRects())
          if (r.width >= 2 && r.height >= 2) rects.push({ x: r.left, y: r.top, w: r.width, h: r.height });
      }
    }
    if (!rects.length) return; // sr-only (clipped to 1 px) or empty
    const s = getComputedStyle(el);
    const fg = rgba(s.color);
    const fontSize = parseFloat(s.fontSize);
    const weight = Number(s.fontWeight) || 400;
    el.setAttribute("data-contrast-probe", String(i));
    items.push({
      probe: i,
      what: describe(el),
      where: context(el),
      text: (isField(el) ? el.value : ownText(el) || el.textContent?.trim() || "").slice(0, 60),
      fg: [fg[0], fg[1], fg[2], fg[3] * opacity(el)],
      fontSize,
      weight,
      large: fontSize >= 24 || (fontSize >= 18.66 && weight >= 700),
      rects,
    });
  });
  return items;
}

/** Runs in the page: compare each item's colour with the screenshot's pixels under its text. */
async function analyzeInPage({ png, items, dpr }) {
  const img = new Image();
  img.src = `data:image/png;base64,${png}`;
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const lin = (c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const lum = (r, g, b) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  const out = [];
  for (const item of items) {
    const [fr, fg, fb, fa] = item.fg;
    const ratios = [];
    let sampleBg = null;
    for (const r of item.rects) {
      const x0 = Math.max(0, Math.floor(r.x * dpr));
      const y0 = Math.max(0, Math.floor(r.y * dpr));
      const x1 = Math.min(canvas.width, Math.ceil((r.x + r.w) * dpr));
      const y1 = Math.min(canvas.height, Math.ceil((r.y + r.h) * dpr));
      if (x1 <= x0 || y1 <= y0) continue;
      const data = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
      // At most ~1500 samples per box.
      const step = Math.max(1, Math.floor(Math.sqrt(((x1 - x0) * (y1 - y0)) / 1500)));
      for (let y = 0; y < y1 - y0; y += step)
        for (let x = 0; x < x1 - x0; x += step) {
          const k = (y * (x1 - x0) + x) * 4;
          const br = data[k],
            bg = data[k + 1],
            bb = data[k + 2];
          // The text colour as drawn: blended over this pixel by its alpha.
          const tr = fr * fa + br * (1 - fa),
            tg = fg * fa + bg * (1 - fa),
            tb = fb * fa + bb * (1 - fa);
          const l1 = lum(tr, tg, tb),
            l2 = lum(br, bg, bb);
          const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
          ratios.push([ratio, br, bg, bb]);
        }
    }
    if (!ratios.length) {
      out.push({ ...item, ratio: null, bg: null });
      continue;
    }
    ratios.sort((a, b) => a[0] - b[0]);
    const p = ratios[Math.floor(ratios.length * 0.1)];
    sampleBg = `rgb(${p[1]}, ${p[2]}, ${p[3]})`;
    out.push({ ...item, ratio: Math.round(p[0] * 100) / 100, min: Math.round(ratios[0][0] * 100) / 100, bg: sampleBg });
  }
  for (const el of document.querySelectorAll("[data-contrast-probe]")) el.removeAttribute("data-contrast-probe");
  return out;
}

const HIDE_TEXT = `
  *, *::before, *::after, *::placeholder, *::marker {
    color: transparent !important;
    -webkit-text-fill-color: transparent !important;
    text-shadow: none !important;
    caret-color: transparent !important;
    text-decoration-color: transparent !important;
    transition: none !important;
  }`;

/**
 * Measure text contrast on the current page.
 *
 * @param {import("@playwright/test").Page} page
 * @param {{ targets?: string[], within?: string, highContrast?: boolean }} [opts]
 *   targets: CSS selectors of the elements to measure (default: every visible element with its own text);
 *   within: only text inside the element this selector finds (e.g. an open sheet, whose backdrop dims the page);
 *   highContrast: hold text to 7:1 (4.5:1 large) instead of 4.5:1 (3:1 large).
 * @returns {Promise<Array<{ what: string, where: string, text: string, ratio: number | null, min?: number, required: number, fg: number[], bg: string | null, fontSize: number, large: boolean }>>}
 */
export async function measureTextContrast(page, { targets, within, highContrast = false } = {}) {
  const viewport = page.viewportSize();
  // Lay the whole page out in one viewport, so one screenshot covers every text box. With a sheet
  // open the page is pinned (body position: fixed, ui.tsx `lockPage`) and the document reports no
  // scroll height, so body's own height counts too: the viewport still grows enough for a sheet's
  // panel (a share of the viewport tall) to show all of its content.
  const height = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body.scrollHeight, window.innerHeight));
  if (viewport && height > viewport.height) await page.setViewportSize({ width: viewport.width, height: Math.min(height, 12_000) });
  try {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(150);
    const items = await page.evaluate(collectInPage, { targets: targets ?? null, within: within ?? null });
    if (!items.length) return [];
    await page.evaluate((css) => {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      window.__contrastHideText = sheet;
    }, HIDE_TEXT);
    let png;
    try {
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      png = (await page.screenshot({ animations: "disabled", caret: "hide", scale: "css" })).toString("base64");
    } finally {
      await page.evaluate(() => {
        document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== window.__contrastHideText);
      });
    }
    // scale: "css" — one screenshot pixel per CSS pixel.
    const measured = await page.evaluate(analyzeInPage, { png, items, dpr: 1 });
    return measured.map(({ rects: _, probe: __, weight: ___, ...m }) => ({
      ...m,
      required: highContrast ? (m.large ? 4.5 : 7) : m.large ? 3 : 4.5,
    }));
  } finally {
    if (viewport && height > viewport.height) await page.setViewportSize(viewport);
  }
}

/** One line per result: `4.01 < 4.5  p.mt-12 "Strawvine · built…"  (fg rgb(…) on rgb(…), 11px) — section "…"`. */
export function formatContrast(r) {
  const fg = `rgba(${r.fg.slice(0, 3).join(", ")}, ${Math.round(r.fg[3] * 100) / 100})`;
  return `${r.ratio ?? "?"} < ${r.required}  ${r.what} "${r.text}"  (${fg} on ${r.bg ?? "?"}, ${Math.round(r.fontSize * 10) / 10}px)${r.where ? ` — ${r.where}` : ""}`;
}
