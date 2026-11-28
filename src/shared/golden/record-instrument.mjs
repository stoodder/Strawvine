// How inputs.json.gz was recorded (see generate.ts). On a copy of the code before chunk 2:
//
//   git archive b60f4e3 | tar -x -C /tmp/old && cd /tmp/old && npm ci
//   node <repo>/src/shared/golden/record-instrument.mjs .
//   # add "./scripts/rec-setup.ts" to both projects' setupFiles in vitest.config.ts, then
//   REC_DIR=/tmp/rec-node npx vitest run --project node src/shared src/web/lib --exclude '**/perf.test.ts'
//   REC_DIR=/tmp/rec-web npx vitest run --project web
//   node <repo>/src/shared/golden/record-pack.mjs <repo>/src/shared/golden/inputs.json.gz /tmp/rec-node /tmp/rec-web
//
// This script wraps the listed exported functions so that every top-level call (not the calls
// they make to each other) records its arguments as JSON; the setup file writes them out after
// each test file. The wrappers call the original functions, so every test still runs as before.
import fs from "node:fs";
const root = process.argv[2];
const lists = {
  "src/shared/session.ts": [
    "buildSession",
    "buildSessionFrom",
    "templateSource",
    "setsForAddedExercise",
    "mainLiftBlock",
    "planSignature",
    "planChanged",
    "planMatches",
    "sessionCounts",
    "blockCounts",
    "sessionVolume",
    "isSessionStarted",
    "accessoryHint",
    "effectiveSession",
    "mainLiftSwap",
    "mainLiftAdded",
    "sessionDoneEarly",
    "nextSession",
  ],
  "src/shared/gamify.ts": ["checklist", "dayChecklist", "closedDates", "streaks", "achievements", "amrapPrs"],
  "src/shared/insights.ts": ["buildModel", "weeklyCheckin"],
  "src/shared/swap.ts": ["swapMainLift", "removeMainLift", "undoSwap", "swapChoices", "swapSuggestion", "swapBlocked", "addBlocked"],
  "src/shared/sessionStructure.ts": [
    "supersetLetters",
    "moveExerciseToBlock",
    "reorderInBlock",
    "moveBlock",
    "splitOut",
    "normalizeMainLift",
    "movableInto",
    "locateExercise",
  ],
  "src/shared/sessionStructureUndo.ts": ["addStandings", "rejoinSuperset"],
};
for (const [file, names] of Object.entries(lists)) {
  const p = `${root}/${file}`;
  let src = fs.readFileSync(p, "utf8");
  let tail = `\nimport { __rec } from "./__rec";\n`;
  for (const n of names) {
    const re1 = new RegExp(`export function ${n}\\b`);
    const re2 = new RegExp(`export const ${n} = `);
    if (re1.test(src)) src = src.replace(re1, `function ${n}__impl`);
    else if (re2.test(src)) src = src.replace(re2, `const ${n}__impl = `);
    else throw new Error(`${n} not in ${file}`);
    tail += `export function ${n}(...a: any[]): any { return __rec(${JSON.stringify(n)}, a, () => (${n}__impl as any)(...a)); }\n`;
  }
  fs.writeFileSync(p, src + tail);
}
fs.writeFileSync(
  `${root}/src/shared/__rec.ts`,
  `
const g = globalThis as any;
g.__REC ??= [];
let depth = 0;
export function __rec(fn: string, args: unknown[], run: () => unknown) {
  if (depth === 0) {
    try { g.__REC.push({ fn, args: JSON.stringify(args) }); } catch {}
  }
  depth++;
  try { return run(); } finally { depth--; }
}
`,
);
fs.writeFileSync(
  `${root}/scripts/rec-setup.ts`,
  `
import { afterAll } from "vitest";
import fs from "node:fs";
afterAll(() => {
  const g = globalThis as any;
  const out = process.env.REC_DIR!;
  fs.mkdirSync(out, { recursive: true });
  const seen = new Set<string>();
  const rows: string[] = [];
  for (const r of g.__REC ?? []) { const k = r.fn + "\\t" + r.args; if (seen.has(k)) continue; seen.add(k); rows.push(k); }
  fs.writeFileSync(out + "/" + Math.random().toString(36).slice(2) + ".txt", rows.join("\\n"));
  g.__REC = [];
});
`,
);
