/**
 * Build step: writes `.br` and `.gz` siblings for the web build's compressible files, which
 * the static handler serves (`precompressed: true`) to clients that accept them — maximum
 * compression once at build time instead of gzip on every request.
 *
 *   tsx src/server/precompress.ts dist/web
 */
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";

const COMPRESSIBLE = /\.(js|mjs|css|html|svg|json|webmanifest|txt|map)$/i;
const MIN_BYTES = 1024;

const br = promisify(brotliCompress);
const gz = promisify(gzip);

async function* files(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* files(full);
    else if (COMPRESSIBLE.test(entry.name)) yield full;
  }
}

const root = process.argv[2] ?? "dist/web";
let count = 0;
let before = 0;
let after = 0;
for await (const file of files(root)) {
  if ((await stat(file)).size < MIN_BYTES) continue;
  const data = await readFile(file);
  const brotli = await br(data, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: data.length } });
  const gzipped = await gz(data, { level: 9 });
  await writeFile(`${file}.br`, brotli);
  await writeFile(`${file}.gz`, gzipped);
  count++;
  before += data.length;
  after += brotli.length;
}
console.log(`precompressed ${count} files: ${(before / 1024).toFixed(0)} KB → ${(after / 1024).toFixed(0)} KB (brotli)`);
