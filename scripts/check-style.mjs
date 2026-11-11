#!/usr/bin/env node
/**
 * Style lint for the web app (run in CI: `node scripts/check-style.mjs --strict`).
 *
 * Rules
 *   faint-text    `text-faint` is for decoration only (≈4:1 on ink-950; information needs `text-mute`
 *                 or brighter). Allowed when the use is clearly decorative: `placeholder:text-faint`,
 *                 an `aria-hidden` element on the same line, or a `decor` comment on the same line or
 *                 the line above (`// decor`, `/* decor *\/`, `{/* decor *\/}`).
 *   px-font       no px font sizes (`text-[11px]`): they ignore the user's font size. Use the type
 *                 scale or rem (`text-[0.6875rem]`).
 *   mute-on-tint  `text-mute` in the same class string as a tinted surface (`bg-accent/…`,
 *                 `bg-white/[0.04]`…`[0.09]`, `bg-ink-700`): mute drops below 4.5:1 there (≈4.3:1 on
 *                 white/[0.04] over a sheet's ink-850, 3.98:1 on ink-700). Use `text-fg-2`. Only the
 *                 same state counts: `disabled:text-mute` (disabled controls are exempt from contrast
 *                 minimums) and a `hover:`/`active:` surface next to a plain `text-mute` are ignored.
 *                 After measuring ≥ 4.5:1 on the real surface, mark the line with `// contrast-ok`
 *                 (same line or the line above).
 *                 It reads class strings only, so grey text in a nested element inside a tinted
 *                 parent escapes it: `npm run audit:contrast` (scripts/contrast-audit.mjs) measures
 *                 every rendered text against the pixels behind it and catches those.
 *   type-scale    arbitrary font sizes (`text-[0.8rem]`, `text-[clamp(…)]`) must be on the type scale
 *                 below (TYPE_SCALE). Tailwind's named sizes (text-xs … text-5xl) are always fine.
 *                 To add a size: add it to TYPE_SCALE with the role it plays, in the same change.
 *   white-alpha   `bg-white/[α]` surfaces use the surface steps in WHITE_ALPHAS (so tints stay a
 *                 handful of tokens, and high-contrast/legibility can be reasoned about per step).
 *
 * Deliberate exceptions live in ALLOW below (per rule and file) — they hold even with --strict and
 * are meant to shrink. Anything else that's known but not yet fixed can go in the ratchet:
 *
 * Ratchet: known violations are listed per file in scripts/check-style-baseline.json. A file
 * may never have more than its baseline; when it has fewer, the script says so and
 * `--update-baseline` shrinks the file. New files have a baseline of 0.
 *
 *   node scripts/check-style.mjs                   # check
 *   node scripts/check-style.mjs --update-baseline # rewrite the baseline to the current counts
 *   node scripts/check-style.mjs --strict          # ignore the baseline (every violation fails; ALLOW still applies)
 *
 * Every run first checks the rules themselves against the fixtures in selfTest().
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = path.join(root, "src/web");
const baselinePath = path.join(root, "scripts/check-style-baseline.json");
const args = new Set(process.argv.slice(2));

/**
 * Arbitrary font sizes on the type scale, with the role each plays. Tailwind's named sizes cover
 * the rest (xs 0.75 · sm 0.875 · base 1 · lg 1.125 · xl 1.25 · 2xl 1.5 · 3xl 1.875 · 4xl 2.25 · 5xl 3).
 */
export const TYPE_SCALE = new Map([
  ["0.625rem", "micro: units and plate chips on set buttons / the rest pill"],
  ["0.6875rem", "caption: `.label`, sub-lines under stats and macros"],
  ["0.8125rem", "small numerals: the rest pill's next-set line"],
  ["0.9375rem", "row title: list and target names"],
  ["1.75rem", "stat value, medium (`Stat size=\"md\"`)"],
  ["2.75rem", "screen title (h1) on Progress / Goals / Settings"],
  ["clamp(1.75rem,11vw,2.75rem)", "screen title (h1) that shrinks on narrow phones and at 200% zoom (Today, Train)"],
  ["max(0.45em,0.6875rem)", "a stat's unit, relative to its value but never below a caption"],
]);

/** Surface steps for `bg-white/[α]` (ink-950 + white α). */
export const WHITE_ALPHAS = new Set(["0.03", "0.04", "0.05", "0.06", "0.08"]);

/**
 * Deliberate, known exceptions (they pass even with --strict). Reduce them: each entry is a
 * place where the owner can move to the scale / a brighter text token.
 *   white-alpha:   file → the off-scale α values it may use
 *   mute-on-tint:  file → how many occurrences it may have
 *   type-scale:    file → the extra sizes it may use
 */
export const ALLOW = {
  "white-alpha": {
    "src/web/components/charts.tsx": ["0.02"], // the table under a chart: a barely-there well
    "src/web/components/progress/IntakeStrip.tsx": ["0.035"], // intake bars' track
    // active:bg of round icon buttons.
    "src/web/components/ui.tsx": ["0.1"],
  },
  "mute-on-tint": {
    // Unselected weekday chips on the page background (ink-950 + white/0.04 ≈ 4.8:1 — passes there,
    // but would not on a sheet). A candidate for text-fg-2.
    "src/web/screens/Settings.tsx": 1,
  },
  "type-scale": {},
};

function* walk(dir) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) yield* walk(p);
    else if (/\.(tsx|ts)$/.test(ent.name) && !/\.test\.tsx?$/.test(ent.name)) yield p;
  }
}

const FAINT = /(^|[\s"'`{(:])text-faint(?![\w/-])/g;
const PX_FONT = /(^|[\s"'`{(:])text-\[\d+(\.\d+)?px\]/g;
const DECOR = /(\/\/|\/\*)\s*decor\b/;
const CONTRAST_OK = /(\/\/|\/\*)\s*contrast-ok\b/;
/** `text-[…]` arbitrary values that are sizes: a rem/em length or a CSS math function. */
const ARBITRARY_TEXT = /(^|[\s"'`{(:])text-\[([^\]\s]+)\]/g;
const SIZE_VALUE = /^(\d*\.?\d+(rem|em)|(clamp|min|max|calc)\(.*\))$/;
const WHITE_BG = /(^|[\s"'`{(:])bg-white\/\[([^\]]+)\]/g;
/** String literals on one line: "…", '…', `…` (no escapes needed for class strings). */
const LITERAL = /"([^"\n]*)"|'([^'\n]*)'|`([^`\n]*)`/g;
const TINT = /^(bg-accent\/.+|bg-white\/\[0\.0[4-9]\d*\]|bg-ink-700(\/.*)?)$/;

/** Splits a class token into its variant prefix ("hover:", "md:hover:", "") and the utility. */
function variantOf(token) {
  const i = token.lastIndexOf(":");
  // Arbitrary values may contain ":" inside brackets (e.g. `[&:hover]:…`); keep it simple.
  return i === -1 || token.slice(0, i).includes("[") ? ["", token] : [token.slice(0, i + 1), token.slice(i + 1)];
}

/** Does one class string put text-mute on a tinted surface in the same state? */
function muteOnTint(classes) {
  const tokens = classes.split(/\s+/).filter(Boolean).map(variantOf);
  return tokens.some(
    ([v, u]) =>
      u === "text-mute" && !/(^|:)(disabled|placeholder|aria-disabled):$/.test(v) && tokens.some(([bv, bu]) => bv === v && TINT.test(bu)),
  );
}

/** Violations in one file's source: [{ rule, line, text, value? }]. `rel` selects ALLOW entries. */
export function lint(source, rel = "") {
  const lines = source.split("\n");
  const out = [];
  lines.forEach((line, i) => {
    const prev = i > 0 ? lines[i - 1] : "";
    const text = line.trim();
    for (const m of line.matchAll(FAINT)) {
      const before = line.slice(0, m.index + m[1].length);
      const decorative = /placeholder:$/.test(before) || /aria-hidden/.test(line) || DECOR.test(line) || DECOR.test(prev);
      if (!decorative) out.push({ rule: "faint-text", line: i + 1, text });
    }
    for (const _ of line.matchAll(PX_FONT)) out.push({ rule: "px-font", line: i + 1, text });
    for (const m of line.matchAll(ARBITRARY_TEXT)) {
      const value = m[2];
      if (!SIZE_VALUE.test(value) || TYPE_SCALE.has(value)) continue;
      if (ALLOW["type-scale"][rel]?.includes(value)) continue;
      out.push({ rule: "type-scale", line: i + 1, text, value });
    }
    for (const m of line.matchAll(WHITE_BG)) {
      const value = m[2];
      if (WHITE_ALPHAS.has(value) || ALLOW["white-alpha"][rel]?.includes(value)) continue;
      out.push({ rule: "white-alpha", line: i + 1, text, value });
    }
    if (!CONTRAST_OK.test(line) && !CONTRAST_OK.test(prev))
      for (const m of line.matchAll(LITERAL)) {
        const classes = m[1] ?? m[2] ?? m[3] ?? "";
        if (classes.includes("text-mute") && muteOnTint(classes)) out.push({ rule: "mute-on-tint", line: i + 1, text });
      }
  });
  // Counted allowances (mute-on-tint): the first N occurrences in the file are the known ones.
  const allowed = ALLOW["mute-on-tint"][rel] ?? 0;
  let seen = 0;
  return out.filter((v) => v.rule !== "mute-on-tint" || ++seen > allowed);
}

const HELP = {
  "faint-text": "use text-mute (or brighter) for information; mark decoration with a `// decor` comment.",
  "px-font": "use the type scale or rem (text-[0.6875rem]) so text follows the user's font size.",
  "mute-on-tint": "text-mute is below 4.5:1 on tinted surfaces — use text-fg-2 (or `// contrast-ok` after measuring).",
  "type-scale": "use a named size or one from TYPE_SCALE in scripts/check-style.mjs (add new steps there, with their role).",
  "white-alpha": `use a surface step: bg-white/[${[...WHITE_ALPHAS].join(" | ")}] (see WHITE_ALPHAS in scripts/check-style.mjs).`,
};

/** The rules, checked against small fixtures (fails loudly if a rule regresses). */
function selfTest() {
  const rules = (src, rel) => lint(src, rel).map((v) => v.rule);
  assert.deepEqual(rules(`<p className="text-faint">x</p>`), ["faint-text"]);
  assert.deepEqual(rules(`<p className="placeholder:text-faint" />`), []);
  assert.deepEqual(rules(`<p className="text-[11px]" />`), ["px-font"]);
  assert.deepEqual(rules(`<p className="text-[0.6875rem] text-[0.8rem]" />`), ["type-scale"]);
  assert.deepEqual(rules(`<p className="text-[clamp(1rem,5vw,2rem)]" />`), ["type-scale"]);
  assert.deepEqual(rules(`<p className="text-[var(--x)] text-[#fff]" />`), []);
  assert.deepEqual(rules(`<div className="bg-white/[0.05] bg-white/[0.045]" />`), ["white-alpha"]);
  assert.deepEqual(rules(`<div className="bg-white/[0.02]" />`, "src/web/components/charts.tsx"), []);
  assert.deepEqual(rules(`<div className="chip bg-white/[0.04] text-mute" />`), ["mute-on-tint"]);
  assert.deepEqual(rules(`<div className="bg-accent/10 px-2 text-mute" />`), ["mute-on-tint"]);
  assert.deepEqual(rules(`<div className="rounded bg-ink-700 text-mute" />`), ["mute-on-tint"]);
  assert.deepEqual(rules(`clsx(on ? "bg-white/[0.08] text-fg" : "text-mute")`), []);
  assert.deepEqual(rules(`<b className="bg-white/[0.06] disabled:bg-white/[0.06] disabled:text-mute" />`), []);
  assert.deepEqual(rules(`<b className="text-mute active:bg-white/[0.06]" />`), []);
  assert.deepEqual(rules(`<b className="bg-white/[0.03] text-mute" />`), []);
  assert.deepEqual(rules(`// contrast-ok: 4.8:1 on ink-950\n<b className="bg-white/[0.04] text-mute" />`), []);
}

function main() {
  selfTest();
  const baseline = !args.has("--strict") && existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, "utf8")) : {};
  const current = {};
  const report = [];
  for (const file of walk(srcDir)) {
    const rel = path.relative(root, file).split(path.sep).join("/");
    const found = lint(readFileSync(file, "utf8"), rel);
    if (!found.length) continue;
    const counts = {};
    for (const v of found) counts[v.rule] = (counts[v.rule] ?? 0) + 1;
    current[rel] = counts;
    for (const [rule, n] of Object.entries(counts)) {
      const allowed = baseline[rel]?.[rule] ?? 0;
      if (n > allowed)
        report.push(
          `${rel}: ${n} ${rule} (baseline ${allowed})\n` +
            found
              .filter((v) => v.rule === rule)
              .map((v) => `    ${rel}:${v.line}  ${v.value ? `[${v.value}]  ` : ""}${v.text.slice(0, 140)}`)
              .join("\n"),
        );
    }
  }

  if (args.has("--update-baseline")) {
    writeFileSync(baselinePath, JSON.stringify(current, null, 2) + "\n");
    console.log(`check-style: baseline written (${Object.keys(current).length} files).`);
    return;
  }

  const shrinkable = [];
  for (const [rel, counts] of Object.entries(baseline))
    for (const [rule, n] of Object.entries(counts)) if ((current[rel]?.[rule] ?? 0) < n) shrinkable.push(`${rel} ${rule}`);
  if (shrinkable.length)
    console.log(
      `check-style: fewer violations than the baseline in ${shrinkable.join(", ")} — run with --update-baseline to lock that in.`,
    );

  // Allowances that no longer match anything: say so, so ALLOW shrinks with the code.
  const stale = staleAllowances();
  if (stale.length) console.log(`check-style: unused ALLOW entries (remove them): ${stale.join(", ")}`);

  if (report.length) {
    const rules = new Set(report.map((r) => r.split(" ")[2]));
    console.error(
      "check-style: new style violations\n\n" +
        report.join("\n\n") +
        "\n\n" +
        [...rules].map((r) => `${r}: ${HELP[r]}`).join("\n"),
    );
    process.exit(1);
  }
  const total = Object.values(current).reduce((a, c) => a + Object.values(c).reduce((x, y) => x + y, 0), 0);
  console.log(`check-style: ok${total ? ` (${total} known violation${total === 1 ? "" : "s"} in the baseline)` : ""}.`);
}

/** ALLOW entries whose file no longer has the value / as many occurrences. */
function staleAllowances() {
  const stale = [];
  const read = (rel) => (existsSync(path.join(root, rel)) ? readFileSync(path.join(root, rel), "utf8") : "");
  for (const [rel, values] of Object.entries(ALLOW["white-alpha"])) {
    const src = read(rel);
    for (const v of values) if (!src.includes(`bg-white/[${v}]`)) stale.push(`white-alpha ${rel} ${v}`);
  }
  for (const [rel, values] of Object.entries(ALLOW["type-scale"])) {
    const src = read(rel);
    for (const v of values) if (!src.includes(`text-[${v}]`)) stale.push(`type-scale ${rel} ${v}`);
  }
  for (const [rel, n] of Object.entries(ALLOW["mute-on-tint"])) {
    // Count without the allowance.
    const saved = ALLOW["mute-on-tint"][rel];
    ALLOW["mute-on-tint"][rel] = 0;
    const count = lint(read(rel), rel).filter((v) => v.rule === "mute-on-tint").length;
    ALLOW["mute-on-tint"][rel] = saved;
    if (count < n) stale.push(`mute-on-tint ${rel} (${count} of ${n} left)`);
  }
  return stale;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("check-style.mjs")) main();
