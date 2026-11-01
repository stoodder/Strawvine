/**
 * Single-user auth: one password (APP_PASSWORD) → a long-lived, HMAC-signed session cookie.
 *
 * - The signing key is derived from SESSION_SECRET *and* APP_PASSWORD, so changing either
 *   signs every device out.
 * - Each cookie carries the session epoch it was issued in (stored in `auth_state`). Signing
 *   out bumps the epoch, revoking every cookie issued before ("sign out everywhere").
 * - Cookies slide: an authenticated request re-issues the cookie once less than
 *   RENEW_BELOW_S of its lifetime is left, so a device in daily use never gets signed out.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { getConnInfo } from "@hono/node-server/conninfo";
import { eq, sql } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Db } from "./db/client";
import { authState } from "./db/schema";

export const COOKIE = "sv_session";
/** Over HTTPS the cookie uses the `__Host-` prefix: Secure, Path=/, no Domain — it can't be set by a sibling subdomain. */
export const SECURE_COOKIE = `__Host-${COOKIE}`;
export const MAX_AGE_S = 60 * 60 * 24 * 180; // 180 days
export const RENEW_BELOW_S = 60 * 60 * 24 * 90; // re-issue when fewer than 90 days remain

export const cookieName = (secure: boolean) => (secure ? SECURE_COOKIE : COOKIE);

const digest = (v: string) => createHash("sha256").update(v).digest();

export function passwordMatches(input: string, expected: string): boolean {
  return timingSafeEqual(digest(input), digest(expected));
}

/** The cookie-signing key: rotating SESSION_SECRET or changing APP_PASSWORD invalidates every cookie. */
export function deriveSessionKey(sessionSecret: string, password: string): Buffer {
  return createHmac("sha256", sessionSecret).update(`strawvine/session/v2\0${password}`).digest();
}

function sign(payload: string, key: Buffer) {
  return createHmac("sha256", key).update(payload).digest("base64url");
}

/** `<expiresAtMs>.<epoch>.<signature>` */
export function makeToken(key: Buffer, epoch: number, now = Date.now()): string {
  const payload = `${now + MAX_AGE_S * 1000}.${epoch}`;
  return `${payload}.${sign(payload, key)}`;
}

export interface TokenInfo {
  expiresAt: number;
  epoch: number;
}

/** The token's claims when the signature is valid and it hasn't expired; otherwise null. */
export function readToken(token: string | undefined, key: Buffer, now = Date.now()): TokenInfo | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [exp, epoch, sig] = parts as [string, string, string];
  if (!/^\d{1,16}$/.test(exp) || !/^\d{1,10}$/.test(epoch)) return null;
  const a = Buffer.from(sig);
  const b = Buffer.from(sign(`${exp}.${epoch}`, key));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const expiresAt = Number(exp);
  return expiresAt > now ? { expiresAt, epoch: Number(epoch) } : null;
}

// ---------------------------------------------------------------------------
// Session epoch
// ---------------------------------------------------------------------------

export interface EpochStore {
  current(): Promise<number>;
  /** Revoke every session issued so far; returns the new epoch. */
  bump(): Promise<number>;
}

/**
 * The epoch lives in Postgres and is cached briefly in memory: the cache is updated
 * immediately on bump, the TTL only matters with several processes (e.g. two dynos).
 */
export function dbEpochStore(db: Db, ttlMs = 5_000): EpochStore {
  let cached: { epoch: number; at: number } | null = null;
  return {
    async current() {
      const now = Date.now();
      if (cached && now - cached.at < ttlMs) return cached.epoch;
      const [row] = await db.select({ epoch: authState.sessionEpoch }).from(authState).where(eq(authState.id, 1));
      cached = { epoch: row?.epoch ?? 0, at: now };
      return cached.epoch;
    },
    async bump() {
      const [row] = await db
        .insert(authState)
        .values({ id: 1, sessionEpoch: 1 })
        .onConflictDoUpdate({ target: authState.id, set: { sessionEpoch: sql`${authState.sessionEpoch} + 1`, updatedAt: new Date() } })
        .returning({ epoch: authState.sessionEpoch });
      cached = { epoch: row!.epoch, at: Date.now() };
      return cached.epoch;
    },
  };
}

// ---------------------------------------------------------------------------
// Cookies & middleware
// ---------------------------------------------------------------------------

export interface SessionConfig {
  key: Buffer;
  secure: boolean;
  epochs: EpochStore;
}

export async function setSessionCookie(c: Context, cfg: SessionConfig, epoch?: number) {
  setCookie(c, cookieName(cfg.secure), makeToken(cfg.key, epoch ?? (await cfg.epochs.current())), {
    httpOnly: true,
    secure: cfg.secure,
    sameSite: "Lax",
    path: "/",
    maxAge: MAX_AGE_S,
  });
}

export function clearSessionCookie(c: Context, cfg: Pick<SessionConfig, "secure">) {
  deleteCookie(c, cookieName(cfg.secure), { path: "/", secure: cfg.secure });
  // Cookies issued before the `__Host-` prefix was adopted.
  if (cfg.secure && getCookie(c, COOKIE) !== undefined) deleteCookie(c, COOKIE, { path: "/" });
}

/** The valid session on this request (signature, expiry and epoch all check out), or null. */
export async function currentSession(c: Context, cfg: SessionConfig): Promise<TokenInfo | null> {
  const info = readToken(getCookie(c, cookieName(cfg.secure)), cfg.key);
  if (!info) return null;
  return info.epoch === (await cfg.epochs.current()) ? info : null;
}

export function requireAuth(cfg: SessionConfig): MiddlewareHandler {
  return async (c, next) => {
    const session = await currentSession(c, cfg);
    if (!session) return c.json({ error: "unauthorized" }, 401);
    if (session.expiresAt - Date.now() < RENEW_BELOW_S * 1000) await setSessionCookie(c, cfg, session.epoch);
    await next();
  };
}

// ---------------------------------------------------------------------------
// Login rate limiting
// ---------------------------------------------------------------------------

/**
 * The client address for rate limiting. Behind Heroku's router (TRUST_PROXY) the real client
 * IP is the *last* X-Forwarded-For entry — earlier ones are client-supplied. Otherwise the
 * header is ignored and the socket address is used.
 */
export function clientIp(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const last = c.req.header("x-forwarded-for")?.split(",").at(-1)?.trim();
    if (last) return last;
  }
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown"; // not running on a Node socket (tests)
  }
}

export interface LoginLimiterOptions {
  /** Failed attempts allowed per client within `windowMs`. */
  perClient?: number;
  windowMs?: number;
  /** Failed attempts allowed across all clients within `globalWindowMs` (caps distributed guessing). */
  global?: number;
  globalWindowMs?: number;
}

/** In-memory limiter for the login endpoint. Only failures count; stale entries are pruned. */
export function loginLimiter({
  perClient = 10,
  windowMs = 15 * 60_000,
  global = 50,
  globalWindowMs = 60 * 60_000,
}: LoginLimiterOptions = {}) {
  const failures = new Map<string, number[]>();
  let globalFailures: number[] = [];
  let lastPrune = 0;

  const prune = (now: number) => {
    lastPrune = now;
    globalFailures = globalFailures.filter((t) => now - t < globalWindowMs);
    for (const [key, times] of failures) {
      const recent = times.filter((t) => now - t < windowMs);
      if (recent.length) failures.set(key, recent);
      else failures.delete(key);
    }
  };

  return {
    /** Whether a login attempt from `key` must be refused right now. */
    blocked(key: string, now = Date.now()): boolean {
      if (now - lastPrune > 60_000) prune(now);
      const mine = (failures.get(key) ?? []).filter((t) => now - t < windowMs).length;
      const all = globalFailures.filter((t) => now - t < globalWindowMs).length;
      return mine >= perClient || all >= global;
    },
    fail(key: string, now = Date.now()) {
      failures.set(key, [...(failures.get(key) ?? []), now]);
      globalFailures.push(now);
    },
    succeed(key: string) {
      failures.delete(key);
    },
    /** For tests: number of clients currently tracked. */
    size: () => failures.size,
  };
}
