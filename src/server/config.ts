/**
 * Environment → server configuration, with the checks that keep a production deploy from
 * booting on placeholder or guessable secrets.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** Values that ship in .env.example / docker-compose.yml / the docs — never acceptable in production. */
export const PLACEHOLDER_SECRETS = new Set([
  "replace-with-a-long-random-string",
  "local-dev-secret-local-dev-secret-0000",
  "change-me",
  "changeme",
  "strawvine",
  "password",
  "hunter2",
  "<your password>",
]);

export const MIN_PROD_PASSWORD_LENGTH = 12;

/**
 * Whether `secret` looks like ≥ 256 bits of real randomness: ≥ 64 hex characters (`openssl
 * rand -hex 32`) or ≥ 43 base64/base64url characters (`openssl rand -base64 32`), with
 * enough distinct characters to rule out things like "aaaa…".
 */
export function looksRandomEnough(secret: string): boolean {
  const hex = /^[0-9a-fA-F]{64,}$/.test(secret);
  const b64 = /^[A-Za-z0-9+/_-]{43,}={0,2}$/.test(secret);
  return (hex || b64) && new Set(secret).size >= 12;
}

/** Problems with SESSION_SECRET / APP_PASSWORD. Production is strict; dev and tests stay permissive. */
export function secretProblems({
  production,
  sessionSecret,
  password,
}: {
  production: boolean;
  sessionSecret: string;
  password: string;
}): string[] {
  const problems: string[] = [];
  if (!production) {
    if (sessionSecret.length < 32) problems.push("SESSION_SECRET must be at least 32 characters.");
    return problems;
  }
  if (PLACEHOLDER_SECRETS.has(sessionSecret.trim().toLowerCase()))
    problems.push("SESSION_SECRET is the placeholder from .env.example/docker-compose. Generate one with `openssl rand -hex 32`.");
  else if (!looksRandomEnough(sessionSecret))
    problems.push(
      "SESSION_SECRET must be at least 256 random bits: 64+ hex characters (`openssl rand -hex 32`) or 43+ base64 characters (`openssl rand -base64 32`).",
    );
  if (PLACEHOLDER_SECRETS.has(password.trim().toLowerCase()))
    problems.push("APP_PASSWORD is a placeholder/default value. Choose your own password (12+ characters).");
  else if (password.length < MIN_PROD_PASSWORD_LENGTH)
    problems.push(`APP_PASSWORD must be at least ${MIN_PROD_PASSWORD_LENGTH} characters in production.`);
  if (password === sessionSecret) problems.push("APP_PASSWORD and SESSION_SECRET must differ.");
  return problems;
}

/** TRUST_PROXY=1/0; defaults to on when running on a Heroku dyno (DYNO is set), off elsewhere. */
export function trustProxyFrom(env: NodeJS.ProcessEnv): boolean {
  const v = env.TRUST_PROXY?.trim().toLowerCase();
  if (v) return v === "1" || v === "true" || v === "yes";
  return !!env.DYNO;
}

/**
 * The build id the web client was compiled with (`npm run build` writes dist/build-id.txt);
 * BUILD_ID in the environment wins. Undefined in dev, where no header is sent.
 */
export function readBuildId(env: NodeJS.ProcessEnv, distDir = path.resolve(process.cwd(), "dist")): string | undefined {
  const file = path.join(distDir, "build-id.txt");
  const raw = env.BUILD_ID?.trim() || (existsSync(file) ? readFileSync(file, "utf8").trim() : "");
  return /^[\w.-]{1,64}$/.test(raw) ? raw : undefined;
}

export interface ServerConfig {
  production: boolean;
  databaseUrl: string;
  password: string;
  sessionSecret: string;
  port: number;
  trustProxy: boolean;
  buildId: string | undefined;
}

/** Reads and validates the environment; throws with every problem listed. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const problems: string[] = [];
  const required = (name: string) => {
    const v = env[name];
    if (!v) problems.push(`Missing required environment variable ${name}. See .env.example.`);
    return v ?? "";
  };
  const production = env.NODE_ENV === "production";
  const databaseUrl = required("DATABASE_URL");
  const password = required("APP_PASSWORD");
  const sessionSecret = required("SESSION_SECRET");
  if (password && sessionSecret) problems.push(...secretProblems({ production, sessionSecret, password }));
  if (problems.length) throw new Error(`Refusing to start:\n  - ${problems.join("\n  - ")}`);
  return {
    production,
    databaseUrl,
    password,
    sessionSecret,
    port: Number(env.PORT ?? 3000),
    trustProxy: trustProxyFrom(env),
    buildId: readBuildId(env),
  };
}
