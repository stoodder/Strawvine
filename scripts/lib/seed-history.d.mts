/** Types for seed-history.mjs (a plain module so scripts/*.mjs can use it without a build). */
export function seedHistory(
  call: (method: string, path: string, body?: unknown) => Promise<any>,
  opts?: { through?: string; weeks?: number },
): Promise<void>;
