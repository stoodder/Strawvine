import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants as zlibConstants, gzip } from "node:zlib";
import { serveStatic } from "@hono/node-server/serve-static";
import { asc, eq, sql } from "drizzle-orm";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { compress } from "hono/compress";
import { deleteCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { routePath } from "hono/route";
import { secureHeaders } from "hono/secure-headers";
import { z } from "zod";
import {
  dayLogPatchSchema,
  exerciseCreateSchema,
  exercisePatchSchema,
  isoDate,
  maxEntryCreateSchema,
  safeString,
  sessionSchema,
  settingsSchema,
  type Bootstrap,
  type Revs,
  type Session,
  type Settings,
} from "../shared/schemas";
import {
  clearSessionCookie,
  clientIp,
  clientKey,
  currentSession,
  dbEpochStore,
  deriveDeviceKey,
  deviceCookieName,
  knownDevice,
  loginLimiter,
  passwordMatches,
  requireAuth,
  sessionKeys,
  setDeviceCookie,
  setSessionCookie,
  tokenHash,
  type EpochStore,
  type LoginLimiterOptions,
  type SessionConfig,
} from "./auth";
import { exercisePatchRefusal } from "../shared/exerciseEdit";
import { MAX_BLOCKS, normalizeMainLift } from "../shared/sessionStructure";
import { buildExport, toDay, toExercise, toMax } from "./backup";
import type { Db } from "./db/client";
import { dayLogs, exercises, maxEntries, seenAchievements, sessions, settings } from "./db/schema";
import { exerciseCreateHashes, forgetMaxCreate, idempotency, type Tx } from "./idempotency";

export interface AppOptions {
  db: Db;
  password: string;
  sessionSecret: string;
  /** HTTPS deployment: Secure `__Host-` cookie. */
  secureCookies: boolean;
  /** Behind a trusted TLS-terminating proxy (Heroku): honour X-Forwarded-For / -Proto. */
  trustProxy?: boolean;
  /** Redirect plain-HTTP requests (per X-Forwarded-Proto) to HTTPS. Needs `trustProxy`. */
  forceHttps?: boolean;
  /** Directory with the built web app; omitted in dev/tests. */
  staticDir?: string;
  /** Sent as `x-strawvine-build` on API responses so the client can spot a newer deploy. */
  buildId?: string;
  /** Overrides for tests. */
  epochs?: EpochStore;
  loginLimits?: LoginLimiterOptions;
  log?: (message: string, details: Record<string, unknown>) => void;
}

export const BODY_LIMIT_BYTES = 1024 * 1024;
export const LOGIN_BODY_LIMIT_BYTES = 4 * 1024;
export const CSP_REPORT_BODY_LIMIT_BYTES = 8 * 1024;
/** CSP reports accepted per client per minute, and from everyone per minute. */
export const CSP_REPORTS_PER_CLIENT_PER_MIN = 30;
export const CSP_REPORTS_PER_MIN = 300;
/** CSP violations logged per report, and distinct (directive, host) pairs logged per minute. */
export const CSP_LOG_PER_REPORT = 2;
export const CSP_LOG_PAIRS_PER_MIN = 20;
/** Longest blocked host (or keyword) a CSP log line carries. */
export const CSP_BLOCKED_MAX_CHARS = 100;
const HEALTH_TIMEOUT_MS = 2_000;

function badRequest(error: z.ZodError) {
  return { error: "invalid", issues: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) };
}

/**
 * Row ids in the path are Postgres `serial`s (positive int4) written canonically — no sign, no
 * leading zeros — so one row has exactly one path (idempotency keys remember the path).
 */
const idParam = z
  .string()
  .regex(/^[1-9]\d{0,9}$/, "Expected a positive integer id")
  .transform(Number)
  .pipe(z.int().min(1).max(2_147_483_647));

/** A max entry's `createdAt` from the device is trusted within this window around the server's clock. */
export const MAX_CREATED_AT_PAST_MS = 30 * 24 * 60 * 60_000;
export const MAX_CREATED_AT_FUTURE_MS = 5 * 60_000;

/** The device's `createdAt` for a max entry, clamped to [now − 30 days, now + 5 min]; none → now. */
export function clampCreatedAt(createdAt: string | undefined, now = Date.now()): Date {
  const t = createdAt === undefined ? NaN : Date.parse(createdAt);
  if (!Number.isFinite(t)) return new Date(now);
  return new Date(Math.min(now + MAX_CREATED_AT_FUTURE_MS, Math.max(now - MAX_CREATED_AT_PAST_MS, t)));
}

/**
 * A row's revision for version-checked saves: Postgres' `xmin` (the id of the transaction that
 * last wrote the row) — new on every write, never reused for another row version, and needing no
 * column of its own. A restore rewrites every row, so revisions held by devices go stale (their
 * next save merges, see docs/SPEC.md §8).
 */
const xmin = (table: typeof sessions | typeof settings) => sql<string>`${table}.xmin::text`.mapWith(String);

const brotli = promisify(brotliCompress);
const gzipAsync = promisify(gzip);
/** Smaller JSON responses aren't worth compressing. */
const COMPRESS_MIN_BYTES = 1024;

function accepts(header: string, encoding: string): boolean {
  return header.split(",").some((part) => {
    const [name, ...params] = part.trim().toLowerCase().split(";");
    const q = params.map((p) => /^\s*q=([\d.]+)\s*$/.exec(p)?.[1]).find((v) => v !== undefined);
    return name === encoding && (q === undefined || Number(q) > 0);
  });
}

/**
 * Compresses JSON API responses: Brotli (quality 4 — most of the gain at a fraction of the
 * cost of 11) when the client accepts it, else gzip. The static app is precompressed at build
 * time instead (see precompress.ts).
 */
const compressJson: MiddlewareHandler = async (c, next) => {
  await next();
  const res = c.res;
  if (c.req.method === "HEAD" || !res.body || res.status === 204 || res.status === 304 || res.headers.has("Content-Encoding")) return;
  if (!/^application\/json\b/i.test(res.headers.get("Content-Type") ?? "")) return;
  const header = c.req.header("Accept-Encoding") ?? "";
  const encoding = accepts(header, "br") ? "br" : accepts(header, "gzip") ? "gzip" : null;
  if (!encoding) return;
  const t0 = performance.now();
  const raw = Buffer.from(await res.arrayBuffer());
  const body =
    raw.length < COMPRESS_MIN_BYTES
      ? raw
      : encoding === "br"
        ? await brotli(raw, {
            params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4, [zlibConstants.BROTLI_PARAM_SIZE_HINT]: raw.length },
          })
        : await gzipAsync(raw, { level: 6 });
  c.res = new Response(body, res);
  c.res.headers.delete("Content-Length");
  c.res.headers.append("Vary", "Accept-Encoding");
  if (body !== raw) c.res.headers.set("Content-Encoding", encoding);
  if (c.res.headers.has("Server-Timing")) c.res.headers.append("Server-Timing", timing({ compress: performance.now() - t0 }));
};

/** Whether an `If-None-Match` header lists `etag` (weak comparison). */
function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  const strip = (t: string) => t.trim().replace(/^W\//, "");
  return header.split(",").some((t) => t.trim() === "*" || strip(t) === strip(etag));
}

/** An entity tag's opaque value: `W/"abc"`, `"abc"` and a bare `abc` all give `abc`. */
export function opaqueTag(value: string): string {
  return value
    .trim()
    .replace(/^W\//, "")
    .replace(/^"(.*)"$/, "$1");
}

/**
 * The precondition of a version-checked save: `If-Match: <rev>` (the revision the edit was based
 * on), `If-None-Match: *` (the client knows of no saved document), or none (older clients: the
 * save is accepted as before). `If-Match: *` only asks that a document exists, which a save
 * doesn't need, so it's accepted.
 */
type Precondition = { kind: "match"; rev: string } | { kind: "absent" } | null;
function precondition(c: Context): Precondition {
  const match = c.req.header("if-match");
  if (match !== undefined && match.trim() !== "*" && match.trim() !== "") return { kind: "match", rev: opaqueTag(match.split(",")[0]!) };
  if (c.req.header("if-none-match")?.trim() === "*") return { kind: "absent" };
  return null;
}

/** Whether a document at `rev` (null: none saved) fails the precondition. A document deleted since is not a conflict. */
const conflicts = (pre: Precondition, rev: string | null) => pre !== null && rev !== null && (pre.kind === "absent" || pre.rev !== rev);

/** `Server-Timing` entries (ms, one decimal). */
const timing = (entries: Record<string, number>) =>
  Object.entries(entries)
    .map(([name, ms]) => `${name};dur=${ms.toFixed(1)}`)
    .join(", ");

/**
 * The data set's version: the `dataset_version` counter, which a trigger on every data table
 * bumps once per writing transaction inside that transaction (migration 0004), plus the session
 * epoch and key salt — a restore or a database-level rollback moves those on, so a counter that
 * starts over (or rolls back) never repeats a tag a device already holds.
 */
interface DatasetVersion {
  v: number;
  epoch: number;
  salt: string;
  /** The transaction this was read in bumped the counter (it wrote data). */
  bumped: boolean;
}

/** One cheap lookup: the counter row and the auth row, by primary key. */
const datasetVersionQuery = sql`
  select coalesce(d.v, 0)::text as v, coalesce(a.session_epoch, 0) as epoch, coalesce(a.key_salt, '') as salt,
         coalesce(current_setting('strawvine.dataset_bumped', true), '') = 'on' as bumped
  from (select 1) one
  left join dataset_version d on d.id = 1
  left join auth_state a on a.id = 1`;

async function readDatasetVersion(db: Db | Tx): Promise<DatasetVersion> {
  const [row] = await db.execute<{ v: string; epoch: number; salt: string; bumped: boolean }>(datasetVersionQuery);
  return { v: Number(row!.v), epoch: Number(row!.epoch), salt: row!.salt, bumped: !!row!.bumped };
}

/** The ETag for a data set version (what /bootstrap answers with at that version). */
export function datasetTag(buildId: string, ver: Omit<DatasetVersion, "bumped">): string {
  const hash = createHash("sha256").update(`${buildId}\0${ver.v}\0${ver.epoch}\0${ver.salt}`).digest("base64url");
  return `W/"${hash.slice(0, 27)}"`;
}

/**
 * Logs each distinct (directive, blocked) CSP violation at most once per window, and at most
 * `maxPairs` of them per window: a page that keeps violating (or someone posting reports) can't
 * flood the logs.
 */
function cspLogGate(maxPairs = CSP_LOG_PAIRS_PER_MIN, windowMs = 60_000) {
  let start = 0;
  const seen = new Set<string>();
  return (v: { directive: string; blocked: string }, now = Date.now()): boolean => {
    if (now - start >= windowMs) {
      start = now;
      seen.clear();
    }
    const key = `${v.directive}\0${v.blocked}`;
    if (seen.has(key) || seen.size >= maxPairs) return false;
    seen.add(key);
    return true;
  };
}

/** A fixed-window counter per key (and in total) for unauthenticated endpoints. */
function windowLimiter(perKey: number, total: number, windowMs = 60_000) {
  let start = 0;
  let all = 0;
  const counts = new Map<string, number>();
  return (key: string, now = Date.now()): boolean => {
    if (now - start >= windowMs) {
      start = now;
      all = 0;
      counts.clear();
    }
    const n = counts.get(key) ?? 0;
    if (n >= perKey || all >= total) return false;
    if (counts.size < 10_000) counts.set(key, n + 1);
    all++;
    return true;
  };
}

/**
 * What a CSP violation report says, reduced to what may be logged: the violated directive and the
 * blocked resource's host (or keyword: "inline", "eval", "data", …). Never the document, the
 * source file or a sample. Accepts the classic `report-uri` body and Reporting API arrays.
 */
export function cspViolations(body: unknown): Array<{ directive: string; blocked: string }> {
  const out: Array<{ directive: string; blocked: string }> = [];
  const clean = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[^\w\-.:'*]/g, "").slice(0, max) : "");
  const hostOf = (v: unknown): string => {
    if (typeof v !== "string" || !v) return "";
    try {
      const u = new URL(v);
      return (u.host || u.protocol.replace(/:$/, "")).replace(/[^\w\-.:[\]]/g, "").slice(0, CSP_BLOCKED_MAX_CHARS);
    } catch {
      return clean(v.split(/[\s/?#]/)[0], 40); // "inline", "eval", "data", "self"…
    }
  };
  const add = (r: Record<string, unknown> | null | undefined) => {
    if (!r || typeof r !== "object") return;
    const raw = r["effective-directive"] ?? r["violated-directive"] ?? r.effectiveDirective ?? r.violatedDirective;
    const directive = clean(typeof raw === "string" ? raw.trim().split(/\s/)[0] : "", 60);
    const blocked = hostOf(r["blocked-uri"] ?? r.blockedURL ?? r.blockedUri);
    if (directive) out.push({ directive, blocked: blocked || "unknown" });
  };
  if (Array.isArray(body)) {
    for (const r of body.slice(0, 10))
      if (r && typeof r === "object" && (r as { type?: unknown }).type === "csp-violation")
        add((r as { body?: Record<string, unknown> }).body);
  } else if (body && typeof body === "object") add((body as Record<string, Record<string, unknown>>)["csp-report"]);
  return out;
}

const tooLarge = (c: Context) => c.json({ error: "Request body too large" }, 413);

/** An exercise patch the locks refuse (`exercisePatchRefusal`); thrown to roll its transaction back. */
class PatchRefused extends Error {}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
export const CSP_REPORT_PATH = "/api/csp-report";

/** Per-request values of the authenticated API: the data set's version as of a write. */
type ApiEnv = { Variables: { dataset?: DatasetVersion; datasetMs?: number } };

/**
 * CSRF guard for the JSON API. Any request whose fetch metadata says another site sent it is
 * refused — writes, and reads too (a cross-site link or navigation could otherwise make the
 * browser download the export with the athlete's cookie). Hono's `csrf()` only inspects "simple"
 * form content types and compares Origin with the request URL, whose scheme is http behind
 * Heroku's TLS-terminating router — so writes check Origin against the Host header instead, and
 * refuse any body that isn't JSON (a cross-origin JSON request needs a CORS preflight, which this
 * API never grants).
 */
const jsonApiGuard: MiddlewareHandler = async (c, next) => {
  if (c.req.path === CSP_REPORT_PATH) return next();
  const site = c.req.header("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return c.json({ error: "Cross-site request refused" }, 403);
  if (!MUTATING.has(c.req.method)) return next();
  const origin = c.req.header("origin");
  if (origin !== undefined) {
    let host: string | null = null;
    try {
      host = new URL(origin).host;
    } catch {
      /* "null" or garbage */
    }
    if (!host || host !== c.req.header("host")) return c.json({ error: "Cross-origin request refused" }, 403);
  }
  const type = c.req.header("content-type");
  if (type !== undefined) {
    if (type.split(";")[0]!.trim().toLowerCase() !== "application/json") return c.json({ error: "Expected application/json" }, 415);
  } else if ((await c.req.arrayBuffer()).byteLength > 0) {
    // No content type at all (e.g. a no-cors Blob body): only an empty body is acceptable.
    return c.json({ error: "Expected application/json" }, 415);
  }
  return next();
};

/** The enforced Content-Security-Policy. */
export const CSP = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'"],
  styleSrc: ["'self'", "'unsafe-inline'"],
  imgSrc: ["'self'", "data:"],
  fontSrc: ["'self'", "data:"],
  connectSrc: ["'self'"],
  manifestSrc: ["'self'"],
  workerSrc: ["'self'"],
  objectSrc: ["'none'"],
  baseUri: ["'self'"],
  formAction: ["'self'"],
  frameAncestors: ["'none'"],
};

export function createApp(opts: AppOptions) {
  const { db } = opts;
  const app = new Hono();
  const limiter = loginLimiter(opts.loginLimits);
  const session: SessionConfig = {
    keyFor: sessionKeys(opts.sessionSecret, opts.password),
    secure: opts.secureCookies,
    epochs: opts.epochs ?? dbEpochStore(db),
  };
  const deviceKey = deriveDeviceKey(opts.sessionSecret, opts.password);
  const log = opts.log ?? ((message, details) => console.error(message, JSON.stringify(details)));
  const idempotent = idempotency(db, (err) => log("Pruning idempotency keys failed", { name: (err as Error)?.name }));

  // Errors: log what failed and where — never request bodies, values or SQL parameters (health data).
  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    const cause = (err as { cause?: { code?: unknown } }).cause;
    log("Unhandled error", {
      name: err.name,
      code: (err as { code?: unknown }).code ?? cause?.code,
      method: c.req.method,
      route: routePath(c),
    });
    return c.json({ error: "Something went wrong" }, 500);
  });

  if (opts.forceHttps && opts.trustProxy)
    app.use("*", async (c, next) => {
      if (c.req.header("x-forwarded-proto") !== "http") return next();
      const url = new URL(c.req.url);
      return c.redirect(`https://${c.req.header("host") ?? url.host}${url.pathname}${url.search}`, 301);
    });

  app.use(
    "*",
    secureHeaders({
      contentSecurityPolicy: CSP,
      // Trial (README "Content-Security-Policy trial"): the same policy without inline styles,
      // reported (never enforced) to /api/csp-report. `report-uri` only: Chromium ignores it once
      // `report-to` is present and then batches reports through the Reporting API (in testing,
      // none arrived within a minute), while every engine delivers `report-uri` reports at once.
      contentSecurityPolicyReportOnly: { ...CSP, styleSrc: ["'self'"], reportUri: CSP_REPORT_PATH },
      strictTransportSecurity: "max-age=31536000; includeSubDomains",
      xFrameOptions: "DENY",
      permissionsPolicy: { camera: [], microphone: [], geolocation: [], payment: [], usb: [] },
    }),
  );
  const compressOther = compress();
  app.use("*", (c, next) => (c.req.path.startsWith("/api/") ? compressJson(c, next) : compressOther(c, next)));

  // ---- API plumbing ---------------------------------------------------------
  app.use("/api/*", async (c, next) => {
    await next();
    // Health data must not linger in shared or browser caches unless a route opts in.
    if (!c.res.headers.has("Cache-Control")) c.res.headers.set("Cache-Control", "no-store");
    if (opts.buildId) c.res.headers.set("x-strawvine-build", opts.buildId);
  });
  app.use("/api/auth/login", bodyLimit({ maxSize: LOGIN_BODY_LIMIT_BYTES, onError: tooLarge }));
  app.use(CSP_REPORT_PATH, bodyLimit({ maxSize: CSP_REPORT_BODY_LIMIT_BYTES, onError: tooLarge }));
  app.use("/api/*", bodyLimit({ maxSize: BODY_LIMIT_BYTES, onError: tooLarge }));
  app.use("/api/*", jsonApiGuard);

  // ---- CSP reports (Report-Only trial) ----------------------------------------
  // No auth (browsers send reports without credentials), small bodies, rate-limited; logs only
  // the violated directive and the blocked resource's host — each pair once a minute, at most
  // CSP_LOG_PER_REPORT lines per report and CSP_LOG_PAIRS_PER_MIN lines a minute.
  const cspLimit = windowLimiter(CSP_REPORTS_PER_CLIENT_PER_MIN, CSP_REPORTS_PER_MIN);
  const cspLogOnce = cspLogGate();
  app.post(CSP_REPORT_PATH, async (c) => {
    if (!cspLimit(clientKey(clientIp(c, !!opts.trustProxy)))) return c.body(null, 429);
    let body: unknown = null;
    try {
      body = JSON.parse(await c.req.text());
    } catch {
      return c.body(null, 400);
    }
    let logged = 0;
    for (const v of cspViolations(body)) {
      if (logged >= CSP_LOG_PER_REPORT) break;
      if (cspLogOnce(v)) {
        log("CSP violation (report-only)", v);
        logged++;
      }
    }
    return c.body(null, 204);
  });

  app.get("/api/health", async (c) => {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        db.execute(sql`select 1`),
        new Promise((_, reject) => (timer = setTimeout(() => reject(new Error("timeout")), HEALTH_TIMEOUT_MS))),
      ]);
      return c.json({ ok: true, db: "ok" });
    } catch {
      return c.json({ ok: false, db: "unreachable" }, 503);
    } finally {
      clearTimeout(timer);
    }
  });

  // ---- auth -------------------------------------------------------------
  // Failures are limited per client (a known device, else its /24 or /64 network); under a
  // distributed attack unknown clients go through a tarpit while known devices sign in as usual.
  app.post("/api/auth/login", async (c) => {
    const device = knownDevice(c, deviceKey, opts.secureCookies);
    const client = device ? `device:${device}` : clientKey(clientIp(c, !!opts.trustProxy));
    const gate = limiter.check(client, { known: !!device });
    if (!gate.ok) {
      c.header("Retry-After", String(gate.retryAfterS));
      return c.json({ error: "Too many attempts. Try again in a few minutes." }, 429);
    }
    if (gate.waitMs > 0) await new Promise((r) => setTimeout(r, gate.waitMs));
    const body = z.object({ password: z.string().max(500) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success || !passwordMatches(body.data.password, opts.password)) {
      limiter.fail(client);
      return c.json({ error: "That's not it." }, 401);
    }
    limiter.succeed(client);
    await setSessionCookie(c, session);
    setDeviceCookie(c, deviceKey, opts.secureCookies, device ?? undefined);
    return c.json({ ok: true });
  });

  /**
   * Signs this device out and revokes every other session too (the epoch moves on). Also asks
   * the browser to drop its HTTP cache for the site (health data in cached responses).
   */
  app.post("/api/auth/logout", async (c) => {
    if (await currentSession(c, session)) await session.epochs.bump();
    clearSessionCookie(c, session);
    c.header("Clear-Site-Data", '"cache"');
    return c.json({ ok: true });
  });

  const api = new Hono<ApiEnv>();
  api.use("*", requireAuth(session));

  // ---- dataset version on writes ------------------------------------------------
  // Every successful write answers with the dataset's version after it (`x-dataset-etag`, the
  // ETag /bootstrap gives once it's committed) and just before it (`x-dataset-etag-prev`). Both
  // are exact: the counter is bumped by the write's own transaction (a trigger, migration 0004)
  // and read at its end, while the bump's row lock keeps every other writer — in this process,
  // another dyno, or an older release — out until it commits. So a client whose copy was at
  // `prev` holds exactly the new version once it applies the response, and its next
  // revalidation is a 304. A write that changed nothing (an idempotent replay, a delete of
  // nothing) answers with the current version as both.
  const buildId = opts.buildId ?? "dev";
  const tagOf = (ver: Omit<DatasetVersion, "bumped">) => datasetTag(buildId, ver);
  /** Reads the data set's version at the end of a write's transaction (see the middleware below). */
  const recordVersion = async (c: Context<ApiEnv>, tx: Tx) => {
    const t0 = performance.now();
    c.set("dataset", await readDatasetVersion(tx));
    c.set("datasetMs", performance.now() - t0);
  };
  /** Runs a write in a transaction and records the data set's version as of its end. */
  const write = <T>(c: Context<ApiEnv>, fn: (tx: Tx) => Promise<T>): Promise<T> =>
    db.transaction(async (tx) => {
      const out = await fn(tx);
      await recordVersion(c, tx);
      return out;
    });
  api.use("*", async (c, next) => {
    if (!MUTATING.has(c.req.method) || c.req.path.startsWith("/api/auth/")) return next();
    const t0 = performance.now();
    await next();
    const ver = c.get("dataset");
    const etagMs = c.get("datasetMs") ?? 0;
    if (ver && c.res.status >= 200 && c.res.status < 300) {
      c.res.headers.set("x-dataset-etag", tagOf(ver));
      c.res.headers.set("x-dataset-etag-prev", tagOf(ver.bumped ? { ...ver, v: ver.v - 1 } : ver));
    }
    c.res.headers.set("Server-Timing", timing({ db: performance.now() - t0 - etagMs, etag: etagMs }));
  });

  api.get("/auth/me", (c) => c.json({ ok: true }));

  /**
   * "Forget this device": signs this browser out (only this one — other devices stay signed in)
   * and drops its known-device mark, so the login limiter treats it like any unknown client. The
   * session token is revoked server-side too, so a copy of the cookie (or a browser that never
   * applied this response) can't keep using it.
   */
  api.post("/auth/forget-device", async (c) => {
    const current = await currentSession(c, session);
    if (current) await session.epochs.revoke?.(tokenHash(current.token), new Date(current.expiresAt));
    deleteCookie(c, deviceCookieName(opts.secureCookies), { path: "/", secure: opts.secureCookies });
    clearSessionCookie(c, session);
    c.header("Clear-Site-Data", '"cache"');
    return c.json({ ok: true });
  });

  // ---- bootstrap ----------------------------------------------------------
  // Never stored by the browser (`no-store`: health data stays out of the HTTP cache). The
  // client keeps its own copy and revalidates it with `If-None-Match`: the ETag comes from the
  // data set's version (one primary-key lookup), so an unchanged data set answers 304 without
  // reading or serialising it. The version is read before the data, so a write committing in
  // between can only make the body newer than its tag (one extra download later), never older.
  api.get("/bootstrap", async (c) => {
    const t0 = performance.now();
    const tag = tagOf(await readDatasetVersion(db));
    c.header("ETag", tag);
    c.header("Cache-Control", "no-store");
    if (etagMatches(c.req.header("If-None-Match"), tag)) {
      c.header("Server-Timing", timing({ db: performance.now() - t0 }));
      return c.body(null, 304);
    }
    const [settingsRow, days, ex, maxes, sess, seen] = await Promise.all([
      db
        .select({ data: settings.data, rev: xmin(settings) })
        .from(settings)
        .where(eq(settings.id, 1)),
      db.select().from(dayLogs).orderBy(asc(dayLogs.date)),
      db.select().from(exercises).orderBy(asc(exercises.id)),
      db.select().from(maxEntries).orderBy(asc(maxEntries.date), asc(maxEntries.id)),
      db
        .select({ date: sessions.date, data: sessions.data, rev: xmin(sessions) })
        .from(sessions)
        .orderBy(asc(sessions.date)),
      db.select().from(seenAchievements).orderBy(asc(seenAchievements.key)),
    ]);
    const t1 = performance.now();
    if (!settingsRow[0]) return c.json({ error: "not seeded" }, 500);
    const revs: Revs = { settings: settingsRow[0].rev, sessions: Object.fromEntries(sess.map((s) => [s.date, s.rev])) };
    const body: Bootstrap = {
      settings: settingsRow[0].data,
      days: days.map(toDay),
      exercises: ex.map(toExercise),
      maxEntries: maxes.map(toMax),
      sessions: sess.map((s) => s.data),
      seenAchievements: seen.map((s) => s.key),
      revs,
    };
    const json = JSON.stringify(body);
    c.header("Server-Timing", timing({ db: t1 - t0, build: performance.now() - t1 }));
    return c.body(json, 200, { "Content-Type": "application/json; charset=UTF-8" });
  });

  // ---- days ---------------------------------------------------------------
  api.put("/days/:date", async (c) => {
    const date = isoDate.safeParse(c.req.param("date"));
    const patch = dayLogPatchSchema.safeParse(await c.req.json().catch(() => null));
    if (!date.success) return c.json(badRequest(date.error), 400);
    if (!patch.success) return c.json(badRequest(patch.error), 400);
    const values = { ...patch.data, updatedAt: new Date() };
    const [row] = await write(c, (tx) =>
      tx
        .insert(dayLogs)
        .values({ date: date.data, ...values })
        .onConflictDoUpdate({ target: dayLogs.date, set: values })
        .returning(),
    );
    return c.json(toDay(row!));
  });

  // ---- settings -------------------------------------------------------------
  // Version-checked (see `precondition`): a stale revision is a 409 with the current document.
  api.put("/settings", async (c) => {
    const parsed = settingsSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(badRequest(parsed.error), 400);
    const pre = precondition(c);
    const out = await write(c, async (tx) => {
      const [cur] = await tx
        .select({ data: settings.data, rev: xmin(settings) })
        .from(settings)
        .where(eq(settings.id, 1))
        .for("update");
      if (cur && conflicts(pre, cur.rev)) return { conflict: cur };
      const [row] = await tx
        .update(settings)
        .set({ data: parsed.data, updatedAt: new Date() })
        .where(eq(settings.id, 1))
        .returning({ rev: xmin(settings) });
      return { rev: row?.rev ?? null };
    });
    if (out.conflict) return c.json({ error: "conflict", current: out.conflict.data, rev: out.conflict.rev }, 409);
    if (out.rev) c.header("ETag", `"${out.rev}"`);
    return c.json(parsed.data);
  });

  // ---- exercises & maxes ----------------------------------------------------
  // Creates accept an `Idempotency-Key` header (see ./idempotency): a retry returns the first response.
  api.post("/exercises", async (c) => {
    const parsed = exerciseCreateSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(badRequest(parsed.error), 400);
    // Hashed without `weighted` unless it is false; a retry matches whether or not the first attempt
    // carried the flag (windows on different builds share a queued create, see exerciseCreateHashes).
    const hashes = exerciseCreateHashes(parsed.data);
    return idempotent(
      c,
      { path: "/api/exercises", body: hashes.body, alsoMatches: hashes.alsoMatches },
      async (tx) => {
        // A create that doesn't say is weighted (see exerciseCreateSchema).
        const [row] = await tx
          .insert(exercises)
          .values({ ...parsed.data, weighted: parsed.data.weighted ?? true })
          .returning();
        return { status: 201, body: toExercise(row!) };
      },
      { beforeCommit: (tx) => recordVersion(c, tx) },
    );
  });

  api.patch("/exercises/:id", async (c) => {
    const id = idParam.safeParse(c.req.param("id"));
    if (!id.success) return c.json(badRequest(id.error), 400);
    const parsed = exercisePatchSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(badRequest(parsed.error), 400);
    let row: typeof exercises.$inferSelect | undefined;
    try {
      row = await write(c, async (tx) => {
        const [cur] = await tx.select().from(exercises).where(eq(exercises.id, id.data)).for("update");
        if (!cur) return undefined;
        // The edit sheet's locks, enforced for every client (a stale device, an older build): a
        // program day's main lift stays one, a lift with a strength target keeps its max.
        const [stored] = await tx.select({ data: settings.data }).from(settings).where(eq(settings.id, 1)).for("share");
        const s = stored?.data as Partial<Settings> | undefined;
        const why =
          s?.program && s.strengthTargets
            ? exercisePatchRefusal(toExercise(cur), parsed.data, { program: s.program, strengthTargets: s.strengthTargets })
            : null;
        if (why) throw new PatchRefused(why);
        const [out] = await tx
          .update(exercises)
          .set({ ...parsed.data, updatedAt: new Date() })
          .where(eq(exercises.id, id.data))
          .returning();
        return out;
      });
    } catch (err) {
      // Nothing was written (the transaction rolled back): the client shows it as a rejected change.
      if (err instanceof PatchRefused) return c.json({ error: err.message }, 409);
      throw err;
    }
    return row ? c.json(toExercise(row)) : c.json({ error: "not found" }, 404);
  });

  api.post("/exercises/:id/maxes", async (c) => {
    const id = idParam.safeParse(c.req.param("id"));
    if (!id.success) return c.json(badRequest(id.error), 400);
    const exerciseId = id.data;
    const parsed = maxEntryCreateSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(badRequest(parsed.error), 400);
    const [ex] = await db.select().from(exercises).where(eq(exercises.id, exerciseId));
    if (!ex) return c.json({ error: "not found" }, 404);
    const { createdAt, ...entry } = parsed.data;
    return idempotent(
      c,
      { path: `/api/exercises/${exerciseId}/maxes`, body: parsed.data },
      async (tx) => {
        const [row] = await tx
          .insert(maxEntries)
          .values({ exerciseId, ...entry, createdAt: clampCreatedAt(createdAt) })
          .returning();
        return { status: 201, body: toMax(row!) };
      },
      { beforeCommit: (tx) => recordVersion(c, tx) },
    );
  });

  api.delete("/maxes/:id", async (c) => {
    const id = idParam.safeParse(c.req.param("id"));
    if (!id.success) return c.json(badRequest(id.error), 400);
    const found = await write(c, async (tx) => {
      const rows = await tx.delete(maxEntries).where(eq(maxEntries.id, id.data)).returning({ id: maxEntries.id });
      // A stored "created" response for a row that no longer exists must not be replayed.
      if (rows.length) await forgetMaxCreate(tx, id.data);
      return rows.length > 0;
    });
    return found ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
  });

  // ---- sessions ---------------------------------------------------------------
  // Version-checked like settings. The new revision comes back as the response's ETag.
  const currentSessionDoc = (tx: Tx, date: string, lock: boolean) => {
    const q = tx
      .select({ data: sessions.data, rev: xmin(sessions) })
      .from(sessions)
      .where(eq(sessions.date, date));
    return lock ? q.for("update") : q;
  };

  api.put("/sessions/:date", async (c) => {
    const parsed = sessionSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(badRequest(parsed.error), 400);
    if (parsed.data.date !== c.req.param("date")) return c.json({ error: "date mismatch" }, 400);
    const pre = precondition(c);
    // The main-lift block holds the main lift alone (an older client may send more): what's saved,
    // and answered, is normalized. Its extras need a block of their own, within the limit.
    const doc = normalizeMainLift(parsed.data);
    if (doc.blocks.length > MAX_BLOCKS)
      return c.json({ error: "invalid", issues: [{ path: "blocks", message: `A workout can have at most ${MAX_BLOCKS} blocks` }] }, 400);
    type Out = { conflict: { data: Session; rev: string } } | { rev: string | null; conflict?: undefined };
    const out = await write(c, async (tx): Promise<Out> => {
      if (!pre) {
        const [row] = await tx
          .insert(sessions)
          .values({ date: doc.date, data: doc })
          .onConflictDoUpdate({ target: sessions.date, set: { data: doc, updatedAt: new Date() } })
          .returning({ rev: xmin(sessions) });
        return { rev: row?.rev ?? null };
      }
      for (let attempt = 0; ; attempt++) {
        const [cur] = await currentSessionDoc(tx, doc.date, true);
        if (cur) {
          if (conflicts(pre, cur.rev)) return { conflict: cur };
          const [row] = await tx
            .update(sessions)
            .set({ data: doc, updatedAt: new Date() })
            .where(eq(sessions.date, doc.date))
            .returning({ rev: xmin(sessions) });
          return { rev: row?.rev ?? null };
        }
        // None saved (a row deleted since isn't a conflict). `select … for update` locks nothing
        // when there's no row, so create it atomically: when another save creates it first (in
        // any process), this insert waits for that one to commit and inserts nothing — a 409
        // with that save's document, whatever the precondition said.
        const [row] = await tx
          .insert(sessions)
          .values({ date: doc.date, data: doc })
          .onConflictDoNothing()
          .returning({ rev: xmin(sessions) });
        if (row) return { rev: row.rev };
        const [created] = await currentSessionDoc(tx, doc.date, false);
        if (created) return { conflict: created };
        if (attempt >= 2) throw new Error("session row kept changing"); // created and deleted again, three times over
      }
    });
    if (out.conflict) return c.json({ error: "conflict", current: out.conflict.data, rev: out.conflict.rev }, 409);
    if (out.rev) c.header("ETag", `"${out.rev}"`);
    return c.json(doc);
  });

  // Version-checked like saves: `If-Match` with a revision the session no longer has is a 409
  // with the current document (another device changed it since; the client keeps that copy).
  api.delete("/sessions/:date", async (c) => {
    const date = isoDate.safeParse(c.req.param("date"));
    if (!date.success) return c.json(badRequest(date.error), 400);
    const pre = precondition(c);
    const conflict = await write(c, async (tx) => {
      if (pre) {
        const [cur] = await currentSessionDoc(tx, date.data, true);
        if (cur && conflicts(pre, cur.rev)) return cur;
      }
      await tx.delete(sessions).where(eq(sessions.date, date.data));
      return null;
    });
    if (conflict) return c.json({ error: "conflict", current: conflict.data, rev: conflict.rev }, 409);
    return c.json({ ok: true });
  });

  // ---- achievements -----------------------------------------------------------
  api.post("/achievements/seen", async (c) => {
    const parsed = z.object({ keys: z.array(safeString().max(120)).max(500) }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(badRequest(parsed.error), 400);
    await write(c, async (tx) => {
      if (parsed.data.keys.length)
        await tx
          .insert(seenAchievements)
          .values(parsed.data.keys.map((key) => ({ key })))
          .onConflictDoNothing();
    });
    return c.json({ ok: true });
  });

  // ---- export -----------------------------------------------------------------
  api.get("/export", async (c) => {
    const body = await buildExport(db);
    c.header("Content-Disposition", `attachment; filename="strawvine-export-${body.exportedAt.slice(0, 10)}.json"`);
    return c.json(body);
  });

  app.route("/api", api);
  app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

  // ---- web app ----------------------------------------------------------------
  if (opts.staticDir) {
    const root = path.relative(process.cwd(), opts.staticDir) || ".";
    // Hashed build assets never change. A missing one is a 404 — never the HTML shell, which
    // would otherwise be cached as "immutable" JavaScript.
    app.use("/assets/*", async (c, next) => {
      await next();
      if (c.res.ok) c.res.headers.set("Cache-Control", "public, max-age=31536000, immutable");
    });
    app.use("/assets/*", serveStatic({ root, precompressed: true }));
    app.all("/assets/*", (c) => c.text("Not found", 404, { "Cache-Control": "no-store" }));

    // Everything else (index.html, sw.js, manifest, icons) is revalidated on every load.
    app.use("*", async (c, next) => {
      await next();
      if (!c.res.headers.has("Cache-Control")) c.res.headers.set("Cache-Control", "no-cache");
    });
    app.use("*", serveStatic({ root, precompressed: true }));
    let indexHtml: string | null = null;
    app.get("*", async (c) => {
      indexHtml ??= await readFile(path.join(opts.staticDir!, "index.html"), "utf8");
      return c.html(indexHtml);
    });
  }

  return app;
}
