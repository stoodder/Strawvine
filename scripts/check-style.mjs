#!/usr/bin/env node
/**
 * Style lint for the web app (run in CI: `node scripts/check-style.mjs`).
 *
 * Rules
 *   faint-text  `text-faint` is for decoration only (≈4:1 on ink-950; information needs `text-mute`
 *               or brighter). Allowed when the use is clearly decorative: `placeholder:text-faint`,
 *               an `aria-hidden` element on the same line, or a `decor` comment on the same line or
 *               the line above (`// decor`, `/* decor *\/`, `{/* decor *\/}`).
 *   px-font     no px font sizes (`text-[11px]`): they ignore the user's font size. Use the type
 *               scale or rem (`text-[0.6875rem]`).
 *
 * Ratchet: known violations are listed per file in scripts/check-style-baseline.json. A file
 * may never have more than its baseline; when it has fewer, the script says so and
 * `--update-baseline` shrinks the file. New files have a baseline of 0.
 *
 *   node scripts/check-style.mjs                   # check
 *   node scripts/check-style.mjs --update-baseline # rewrite the baseline to the current counts
 *   node scripts/check-style.mjs --strict          # ignore the baseline (every violation fails)
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = path.join(root, "src/web");
const baselinePath = path.join(root, "scripts/check-style-baseline.json");
const args = new Set(process.argv.slice(2));

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

/** Violations in one file's source: [{ rule, line, text }]. */
export function lint(source) {
  const lines = source.split("\n");
  const out = [];
  lines.forEach((line, i) => {
    const prev = i > 0 ? lines[i - 1] : "";
    for (const m of line.matchAll(FAINT)) {
      const before = line.slice(0, m.index + m[1].length);
      const decorative = /placeholder:$/.test(before) || /aria-hidden/.test(line) || DECOR.test(line) || DECOR.test(prev);
      if (!decorative) out.push({ rule: "faint-text", line: i + 1, text: line.trim() });
    }
    for (const _ of line.matchAll(PX_FONT)) out.push({ rule: "px-font", line: i + 1, text: line.trim() });
  });
  return out;
}

function main() {
  const baseline = !args.has("--strict") && existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, "utf8")) : {};
  const current = {};
  const report = [];
  for (const file of walk(srcDir)) {
    const rel = path.relative(root, file).split(path.sep).join("/");
    const found = lint(readFileSync(file, "utf8"));
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
              .map((v) => `    ${rel}:${v.line}  ${v.text.slice(0, 140)}`)
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

  if (report.length) {
    console.error(
      "check-style: new style violations\n\n" +
        report.join("\n\n") +
        "\n\nfaint-text: use text-mute (or brighter) for information; mark decoration with a `// decor` comment." +
        "\npx-font: use the type scale or rem (text-[0.6875rem]) so text follows the user's font size.",
    );
    process.exit(1);
  }
  const total = Object.values(current).reduce((a, c) => a + Object.values(c).reduce((x, y) => x + y, 0), 0);
  console.log(`check-style: ok${total ? ` (${total} known violation${total === 1 ? "" : "s"} in the baseline)` : ""}.`);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("check-style.mjs")) main();
