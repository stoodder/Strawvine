/**
 * Writes the golden answers (`expected.json.gz`) from the inputs (`inputs.json.gz`). Run it on the
 * code *before* chunk 2 — that is the point — never on the current code:
 *
 *   git archive b60f4e3 | tar -x -C /tmp/old && cp src/shared/golden/{compute,generate}.ts /tmp/old/src/shared/golden/
 *   (cd /tmp/old && npx tsx src/shared/golden/generate.ts $PWD/src/shared/golden)
 *
 * (inputs.json.gz itself was recorded on that code: every top-level call the node and web test
 * suites made into session / gamify / insights / swap / sessionStructure(Undo), perf.test.ts left
 * out, deduplicated.)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { argsOf, hash, normalize, recalcBefore, run, worldCases, WORLDS, type Pack } from "./compute";
import type { Session } from "../schemas";
import type { BuildContext } from "../session";

const dir = process.argv[2]!;
const pack = JSON.parse(gunzipSync(readFileSync(`${dir}/inputs.json.gz`)).toString()) as Pack;
const recorded = pack.calls.map(([fn, ref]) => run(fn, argsOf(pack, ref), "old"));
const recalc = pack.calls.map(([fn, ref]) => {
  if (fn !== "planChanged" && fn !== "mainLiftAdded") return null;
  const [s, ctx] = argsOf(pack, ref) as [Session, BuildContext];
  if (!ctx.exercises || !ctx.maxEntries) return null;
  const full = { ...ctx, sessions: ctx.sessions ?? [] };
  try {
    return normalize(recalcBefore(s, full), [s, full]);
  } catch (e) {
    return { threw: String(e) };
  }
});
const random: Record<string, string> = {};
let cases = 0;
for (let seed = 1; seed <= WORLDS; seed++) {
  const groups = new Map<string, unknown[]>();
  for (const c of worldCases(seed, "old")) {
    const key = `${seed}/${c.name.split("/").at(-1)}`;
    groups.set(key, [...(groups.get(key) ?? []), [c.name, c.out]]);
    cases++;
  }
  for (const [key, list] of groups) random[key] = hash(list);
}
writeFileSync(`${dir}/expected.json.gz`, gzipSync(JSON.stringify({ recorded, recalc, random, cases }), { level: 9 }));
console.log(
  `recorded ${recorded.length}, recalc ${recalc.filter(Boolean).length}, random ${cases} cases in ${Object.keys(random).length} groups`,
);
