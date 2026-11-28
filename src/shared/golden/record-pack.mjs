// Pack the recorded calls (args of every top-level call the existing suites made) into one
// content-addressed pool: every object or array is stored once, calls refer to their args by index.
// Usage: see record-instrument.mjs.
import fs from "node:fs";
import zlib from "node:zlib";
const [out, ...dirs] = process.argv.slice(2);
const SKIP = new Set(process.env.SKIP?.split(",") ?? []);
const lines = new Set();
for (const dir of dirs)
  for (const f of fs.readdirSync(dir).sort())
    for (const line of fs.readFileSync(dir + "/" + f, "utf8").split("\n")) if (line) lines.add(line);
const pool = [];
const index = new Map();
function intern(v) {
  if (v === null || typeof v !== "object") return v;
  const enc = Array.isArray(v) ? v.map(intern) : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, intern(x)]));
  const key = JSON.stringify(enc);
  let i = index.get(key);
  if (i === undefined) {
    i = pool.length;
    pool.push(enc);
    index.set(key, i);
  }
  return { $r: i };
}
const calls = [];
const perFn = new Map();
for (const line of [...lines].sort()) {
  const tab = line.indexOf("\t");
  const fn = line.slice(0, tab);
  if (SKIP.has(fn)) continue;
  const args = JSON.parse(line.slice(tab + 1));
  calls.push([fn, intern(args).$r]);
  perFn.set(fn, (perFn.get(fn) ?? 0) + 1);
}
const json = JSON.stringify({ pool, calls });
const gz = zlib.gzipSync(json, { level: 9 });
fs.writeFileSync(out, gz);
console.log(
  "calls",
  calls.length,
  "pool",
  pool.length,
  "json",
  (json.length / 1e6).toFixed(2) + "MB",
  "gz",
  (gz.length / 1e6).toFixed(2) + "MB",
);
console.log(
  [...perFn]
    .sort((a, b) => b[1] - a[1])
    .map(([f, n]) => `${f}:${n}`)
    .join(" "),
);
