import { readFile } from "node:fs/promises";
import path from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { asc, eq, sql } from "drizzle-orm";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { compress } from "hono/compress";
import { etag } from "hono/etag";
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
  currentSession,
  dbEpochStore,
  deriveSessionKey,
  loginLimiter,
  passwordMatches,
  requireAuth,
  setSessionCookie,
  type EpochStore,
  type LoginLimiterOptions,
  type SessionConfig,
} from "./auth";
import { buildExport, toDay, toExercise, toMax } from "./backup";
import type { Db } from "./db/client";
import { dayLogs, exercises, maxEntries, seenAchievements, sessions, settings } from "./db/schema";

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

/** Row ids in the path are Postgres `serial`s (positive int4); anything else must not reach the query. */
const idParam = z.string().regex(/^\d+$/, "Expected a positive integer id").transform(Number).pipe(z.int().min(1).max(2_147_483_647));

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
    key: deriveSessionKey(opts.sessionSecret, opts.password),
    secure: opts.secureCookies,
    epochs: opts.epochs ?? dbEpochStore(db),
  };
  const log = opts.log ?? ((message, details) => console.error(message, JSON.stringify(details)));

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
  app.use("*", compress());

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
  app.post("/api/auth/login", async (c) => {
    const ip = clientIp(c, !!opts.trustProxy);
    if (limiter.blocked(ip)) return c.json({ error: "Too many attempts. Try again in a few minutes." }, 429);
    const body = z.object({ password: z.string().max(500) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success || !passwordMatches(body.data.password, opts.password)) {
      limiter.fail(ip);
      return c.json({ error: "That's not it." }, 401);
    }
    limiter.succeed(ip);
    await setSessionCookie(c, session);
    return c.json({ ok: true });
  });

  /** Signs this device out and revokes every other session too (the epoch moves on). */
  app.post("/api/auth/logout", async (c) => {
    if (await currentSession(c, session)) await session.epochs.bump();
    clearSessionCookie(c, session);
    return c.json({ ok: true });
  });

  const api = new Hono();
  api.use("*", requireAuth(session));

  api.get("/auth/me", (c) => c.json({ ok: true }));

  // ---- bootstrap ----------------------------------------------------------
  // Revalidated on every load (ETag → 304 when nothing changed); `private` keeps it out of shared caches.
  api.get(
    "/bootstrap",
    async (c, next) => {
      await next();
      if (c.res.ok || c.res.status === 304) c.res.headers.set("Cache-Control", "private, no-cache");
    },
    etag(),
    async (c) => {
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
    },
  );

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
  api.post("/exercises", async (c) => {
    const parsed = exerciseCreateSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(badRequest(parsed.error), 400);
    const [row] = await db.insert(exercises).values(parsed.data).returning();
    return c.json(toExercise(row!), 201);
  });

  api.patch("/exercises/:id", async (c) => {
    const id = idParam.safeParse(c.req.param("id"));
    if (!id.success) return c.json(badRequest(id.error), 400);
    const parsed = exercisePatchSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(badRequest(parsed.error), 400);
    const [row] = await db.update(exercises).set(parsed.data).where(eq(exercises.id, id.data)).returning();
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
    const [row] = await db
      .insert(maxEntries)
      .values({ exerciseId, ...parsed.data })
      .returning();
    return c.json(toMax(row!), 201);
  });

  api.delete("/maxes/:id", async (c) => {
    const id = idParam.safeParse(c.req.param("id"));
    if (!id.success) return c.json(badRequest(id.error), 400);
    const rows = await db.delete(maxEntries).where(eq(maxEntries.id, id.data)).returning({ id: maxEntries.id });
    return rows.length ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
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
