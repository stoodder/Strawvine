/**
 * Guard for tests and scripts that wipe a database (drop schemas, truncate, drop/recreate):
 * they only ever run against a throwaway database — its name says so, and it lives on this
 * machine (or in CI, where the database is a disposable service container).
 */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", ""]);

export function disposableDatabaseProblem(url: string, { nameMustContain = "test", env = process.env } = {}): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "isn't a valid connection URL";
  }
  const name = decodeURIComponent(parsed.pathname.slice(1));
  if (!name.toLowerCase().includes(nameMustContain)) return `database "${name}" must have "${nameMustContain}" in its name`;
  const ci = env.CI === "true" || env.CI === "1";
  if (!ci && !LOCAL_HOSTS.has(parsed.hostname.toLowerCase())) return `host "${parsed.hostname}" isn't local (only allowed with CI=true)`;
  return null;
}

/** Throws unless `url` is a disposable database (see `disposableDatabaseProblem`). */
export function assertDisposableDatabase(url: string, opts?: Parameters<typeof disposableDatabaseProblem>[1]) {
  const problem = disposableDatabaseProblem(url, opts);
  if (problem) throw new Error(`Refusing to wipe this database: ${problem}.`);
}
