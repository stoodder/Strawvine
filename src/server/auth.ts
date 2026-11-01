/**
 * Single-user auth: one password (APP_PASSWORD) → a long-lived, HMAC-signed session cookie.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

export const COOKIE = "sv_session";
const MAX_AGE_S = 60 * 60 * 24 * 180; // 180 days

const digest = (v: string) => createHash("sha256").update(v).digest();

export function passwordMatches(input: string, expected: string): boolean {
  return timingSafeEqual(digest(input), digest(expected));
}

function sign(payload: string, secret: string) {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function makeToken(secret: string, now = Date.now()): string {
  const payload = String(now + MAX_AGE_S * 1000);
  return `${payload}.${sign(payload, secret)}`;
}

export function verifyToken(token: string | undefined, secret: string, now = Date.now()): boolean {
  if (!token) return false;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return false;
  const expected = sign(payload, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  return Number(payload) > now;
}

export function setSessionCookie(c: Context, secret: string, secure: boolean) {
  setCookie(c, COOKIE, makeToken(secret), {
    httpOnly: true,
    secure,
    sameSite: "Lax",
    path: "/",
    maxAge: MAX_AGE_S,
  });
}

export function clearSessionCookie(c: Context) {
  deleteCookie(c, COOKIE, { path: "/" });
}

export function requireAuth(secret: string): MiddlewareHandler {
  return async (c, next) => {
    if (!verifyToken(getCookie(c, COOKIE), secret)) return c.json({ error: "unauthorized" }, 401);
    await next();
  };
}

/** Tiny in-memory limiter for the login endpoint. */
export function loginLimiter(maxAttempts = 10, windowMs = 15 * 60_000) {
  const hits = new Map<string, number[]>();
  return (key: string, now = Date.now()) => {
    const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    recent.push(now);
    hits.set(key, recent);
    return recent.length <= maxAttempts;
  };
}
