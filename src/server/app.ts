import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants as zlibConstants, gzip } from "node:zlib";
import { serveStatic } from "@hono/node-server/serve-static";
import { asc, eq, sql } from "drizzle-orm";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { compress } from "hono/compress";
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
} from "../shared/schemas";
import {
  clearSessionCookie,
  clientIp,
  clientKey,
  currentSession,
  dbEpochStore,
  deriveDeviceKey,
  knownDevice,
  loginLimiter,
  passwordMatches,
  requireAuth,
  sessionKeys,
  setDeviceCookie,
  setSessionCookie,
  type EpochStore,
  type LoginLimiterOptions,
  type SessionConfig,
} from "./auth";
import { buildExport, toDay, toExercise, toMax } from "./backup";
import type { Db } from "./db/client";
import { dayLogs, exercises, maxEntries, seenAchievements, sessions, settings } from "./db/schema";
import { forgetMaxCreate, idempotency } from "./idempotency";

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
};

/** Whether an `If-None-Match` header lists `etag` (weak comparison). */
function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  const strip = (t: string) => t.trim().replace(/^W\//, "");
  return header.split(",").some((t) => t.trim() === "*" || strip(t) === strip(etag));
}

const tooLarge = (c: Context) => c.json({ error: "Request body too large" }, 413);

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * CSRF guard for the JSON API. Hono's `csrf()` only inspects "simple" form content types and
 * compares Origin with the request URL, whose scheme is http behind Heroku's TLS-terminating
 * router — so this checks Origin against the Host header instead, refuses cross-site fetch
 * metadata, and refuses any body that isn't JSON (a cross-origin JSON request needs a CORS
 * preflight, which this API never grants).
 */
const jsonApiGuard: MiddlewareHandler = async (c, next) => {
  if (!MUTATING.has(c.req.method)) return next();
  const site = c.req.header("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return c.json({ error: "Cross-site request refused" }, 403);
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
      contentSecurityPolicy: {
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
      },
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
  app.use("/api/*", bodyLimit({ maxSize: BODY_LIMIT_BYTES, onError: tooLarge }));
  app.use("/api/*", jsonApiGuard);

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

  const api = new Hono();
  api.use("*", requireAuth(session));

  api.get("/auth/me", (c) => c.json({ ok: true }));

  // ---- bootstrap ----------------------------------------------------------
  // Never stored by the browser (`no-store`: health data stays out of the HTTP cache). The
  // client keeps its own copy and revalidates it with `If-None-Match`: the ETag comes from a
  // cheap version stamp of every table (row counts, last update, row versions), so an unchanged
  // dataset answers 304 without reading or serialising it.
  const versionStamp = async (): Promise<string> => {
    const [row] = await db.execute<{ stamp: string }>(sql`
      select concat_ws('|',
        (select count(*) || ':' || coalesce(max(updated_at)::text, '') || ':' || coalesce(sum(xmin::text::bigint), 0) from day_logs),
        (select count(*) || ':' || coalesce(max(updated_at)::text, '') || ':' || coalesce(sum(xmin::text::bigint), 0) from sessions),
        (select count(*) || ':' || coalesce(max(updated_at)::text, '') || ':' || coalesce(sum(xmin::text::bigint), 0) from exercises),
        (select count(*) || ':' || coalesce(max(id), 0) || ':' || coalesce(sum(xmin::text::bigint), 0) from max_entries),
        (select count(*) || ':' || coalesce(sum(xmin::text::bigint), 0) from seen_achievements),
        (select coalesce(max(updated_at)::text, '') || ':' || coalesce(sum(xmin::text::bigint), 0) from settings),
        (select coalesce(max(session_epoch), 0) || ':' || coalesce(max(key_salt), '') from auth_state)
      ) as stamp`);
    return row!.stamp;
  };

  api.get("/bootstrap", async (c) => {
    const stamp = await versionStamp();
    const tag = `W/"${createHash("sha256")
      .update(`${opts.buildId ?? "dev"}\0${stamp}`)
      .digest("base64url")
      .slice(0, 27)}"`;
    c.header("ETag", tag);
    c.header("Cache-Control", "no-store");
    if (etagMatches(c.req.header("If-None-Match"), tag)) return c.body(null, 304);
    const [settingsRow, days, ex, maxes, sess, seen] = await Promise.all([
      db.select().from(settings).where(eq(settings.id, 1)),
      db.select().from(dayLogs).orderBy(asc(dayLogs.date)),
      db.select().from(exercises).orderBy(asc(exercises.id)),
      db.select().from(maxEntries).orderBy(asc(maxEntries.date), asc(maxEntries.id)),
      db.select().from(sessions).orderBy(asc(sessions.date)),
      db.select().from(seenAchievements).orderBy(asc(seenAchievements.key)),
    ]);
    if (!settingsRow[0]) return c.json({ error: "not seeded" }, 500);
    const body: Bootstrap = {
      settings: settingsRow[0].data,
      days: days.map(toDay),
      exercises: ex.map(toExercise),
      maxEntries: maxes.map(toMax),
      sessions: sess.map((s) => s.data),
      seenAchievements: seen.map((s) => s.key),
    };
    return c.json(body);
  });

  // ---- days ---------------------------------------------------------------
  api.put("/days/:date", async (c) => {
    const date = isoDate.safeParse(c.req.param("date"));
    const patch = dayLogPatchSchema.safeParse(await c.req.json().catch(() => null));
    if (!date.success) return c.json(badRequest(date.error), 400);
    if (!patch.success) return c.json(badRequest(patch.error), 400);
    const values = { ...patch.data, updatedAt: new Date() };
    const [row] = await db
      .insert(dayLogs)
      .values({ date: date.data, ...values })
      .onConflictDoUpdate({ target: dayLogs.date, set: values })
      .returning();
    return c.json(toDay(row!));
  });

  // ---- settings -------------------------------------------------------------
  api.put("/settings", async (c) => {
    const parsed = settingsSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(badRequest(parsed.error), 400);
    await db.update(settings).set({ data: parsed.data, updatedAt: new Date() }).where(eq(settings.id, 1));
    return c.json(parsed.data);
  });

  // ---- exercises & maxes ----------------------------------------------------
  // Creates accept an `Idempotency-Key` header (see ./idempotency): a retry returns the first response.
  api.post("/exercises", async (c) => {
    const parsed = exerciseCreateSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(badRequest(parsed.error), 400);
    return idempotent(c, { path: "/api/exercises", body: parsed.data }, async (tx) => {
      const [row] = await tx.insert(exercises).values(parsed.data).returning();
      return { status: 201, body: toExercise(row!) };
    });
  });

  api.patch("/exercises/:id", async (c) => {
    const id = idParam.safeParse(c.req.param("id"));
    if (!id.success) return c.json(badRequest(id.error), 400);
    const parsed = exercisePatchSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(badRequest(parsed.error), 400);
    const [row] = await db
      .update(exercises)
      .set({ ...parsed.data, updatedAt: new Date() })
      .where(eq(exercises.id, id.data))
      .returning();
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
    return idempotent(c, { path: `/api/exercises/${exerciseId}/maxes`, body: parsed.data }, async (tx) => {
      const [row] = await tx
        .insert(maxEntries)
        .values({ exerciseId, ...entry, createdAt: clampCreatedAt(createdAt) })
        .returning();
      return { status: 201, body: toMax(row!) };
    });
  });

  api.delete("/maxes/:id", async (c) => {
    const id = idParam.safeParse(c.req.param("id"));
    if (!id.success) return c.json(badRequest(id.error), 400);
    const found = await db.transaction(async (tx) => {
      const rows = await tx.delete(maxEntries).where(eq(maxEntries.id, id.data)).returning({ id: maxEntries.id });
      // A stored "created" response for a row that no longer exists must not be replayed.
      if (rows.length) await forgetMaxCreate(tx, id.data);
      return rows.length > 0;
    });
    return found ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
  });

  // ---- sessions ---------------------------------------------------------------
  api.put("/sessions/:date", async (c) => {
    const parsed = sessionSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(badRequest(parsed.error), 400);
    if (parsed.data.date !== c.req.param("date")) return c.json({ error: "date mismatch" }, 400);
    await db
      .insert(sessions)
      .values({ date: parsed.data.date, data: parsed.data })
      .onConflictDoUpdate({ target: sessions.date, set: { data: parsed.data, updatedAt: new Date() } });
    return c.json(parsed.data);
  });

  api.delete("/sessions/:date", async (c) => {
    const date = isoDate.safeParse(c.req.param("date"));
    if (!date.success) return c.json(badRequest(date.error), 400);
    await db.delete(sessions).where(eq(sessions.date, date.data));
    return c.json({ ok: true });
  });

  // ---- achievements -----------------------------------------------------------
  api.post("/achievements/seen", async (c) => {
    const parsed = z.object({ keys: z.array(safeString().max(120)).max(500) }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(badRequest(parsed.error), 400);
    if (parsed.data.keys.length)
      await db
        .insert(seenAchievements)
        .values(parsed.data.keys.map((key) => ({ key })))
        .onConflictDoNothing();
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
