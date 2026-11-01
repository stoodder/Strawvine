import { readFile } from "node:fs/promises";
import path from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { z } from "zod";
import {
  dayLogPatchSchema,
  emptyDayLog,
  exerciseCreateSchema,
  exercisePatchSchema,
  isoDate,
  maxEntryCreateSchema,
  sessionSchema,
  settingsSchema,
  type Bootstrap,
  type DayLog,
  type Exercise,
  type MaxEntry,
} from "../shared/schemas";
import { clearSessionCookie, loginLimiter, passwordMatches, requireAuth, setSessionCookie } from "./auth";
import type { Db } from "./db/client";
import { dayLogs, exercises, maxEntries, seenAchievements, sessions, settings } from "./db/schema";

export interface AppOptions {
  db: Db;
  password: string;
  sessionSecret: string;
  secureCookies: boolean;
  /** Directory with the built web app; omitted in dev/tests. */
  staticDir?: string;
}

type DayRow = typeof dayLogs.$inferSelect;
type ExerciseRow = typeof exercises.$inferSelect;
type MaxRow = typeof maxEntries.$inferSelect;

const toDay = ({ updatedAt: _u, ...row }: DayRow): DayLog => ({ ...emptyDayLog(row.date), ...row });
const toExercise = (r: ExerciseRow): Exercise => ({
  id: r.id,
  name: r.name,
  category: r.category as Exercise["category"],
  tracksMax: r.tracksMax,
  measure: r.measure as Exercise["measure"],
  archived: r.archived,
});
const toMax = (r: MaxRow): MaxEntry => ({
  id: r.id,
  exerciseId: r.exerciseId,
  date: r.date,
  valueLb: r.valueLb,
  source: r.source as MaxEntry["source"],
  note: r.note,
  createdAt: r.createdAt.toISOString(),
});

function badRequest(error: z.ZodError) {
  return { error: "invalid", issues: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) };
}

export function createApp(opts: AppOptions) {
  const { db } = opts;
  const app = new Hono();
  const allowLogin = loginLimiter();

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
      },
    }),
  );

  app.get("/api/health", (c) => c.json({ ok: true }));

  // ---- auth -------------------------------------------------------------
  app.post("/api/auth/login", async (c) => {
    // Heroku's router appends the real client IP last; earlier entries are client-supplied.
    const ip = c.req.header("x-forwarded-for")?.split(",").at(-1)?.trim() ?? "local";
    if (!allowLogin(ip)) return c.json({ error: "Too many attempts. Try again in a few minutes." }, 429);
    const body = z.object({ password: z.string().max(500) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success || !passwordMatches(body.data.password, opts.password)) return c.json({ error: "That's not it." }, 401);
    setSessionCookie(c, opts.sessionSecret, opts.secureCookies);
    return c.json({ ok: true });
  });

  app.post("/api/auth/logout", (c) => {
    clearSessionCookie(c);
    return c.json({ ok: true });
  });

  const api = new Hono();
  api.use("*", requireAuth(opts.sessionSecret));

  api.get("/auth/me", (c) => c.json({ ok: true }));

  // ---- bootstrap ----------------------------------------------------------
  api.get("/bootstrap", async (c) => {
    const [settingsRow, days, ex, maxes, sess, seen] = await Promise.all([
      db.select().from(settings).where(eq(settings.id, 1)),
      db.select().from(dayLogs).orderBy(asc(dayLogs.date)),
      db.select().from(exercises).orderBy(asc(exercises.id)),
      db.select().from(maxEntries).orderBy(asc(maxEntries.date), asc(maxEntries.id)),
      db.select().from(sessions).orderBy(asc(sessions.date)),
      db.select().from(seenAchievements),
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
  api.post("/exercises", async (c) => {
    const parsed = exerciseCreateSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(badRequest(parsed.error), 400);
    const [row] = await db.insert(exercises).values(parsed.data).returning();
    return c.json(toExercise(row!), 201);
  });

  api.patch("/exercises/:id", async (c) => {
    const id = Number(c.req.param("id"));
    const parsed = exercisePatchSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(badRequest(parsed.error), 400);
    const [row] = await db.update(exercises).set(parsed.data).where(eq(exercises.id, id)).returning();
    return row ? c.json(toExercise(row)) : c.json({ error: "not found" }, 404);
  });

  api.post("/exercises/:id/maxes", async (c) => {
    const exerciseId = Number(c.req.param("id"));
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
    const id = Number(c.req.param("id"));
    const rows = await db.delete(maxEntries).where(eq(maxEntries.id, id)).returning({ id: maxEntries.id });
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
    await db.delete(sessions).where(eq(sessions.date, c.req.param("date")));
    return c.json({ ok: true });
  });

  // ---- achievements -----------------------------------------------------------
  api.post("/achievements/seen", async (c) => {
    const parsed = z.object({ keys: z.array(z.string().max(120)).max(500) }).safeParse(await c.req.json().catch(() => null));
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
    const [s, days, ex, maxes, sess] = await Promise.all([
      db.select().from(settings),
      db.select().from(dayLogs).orderBy(asc(dayLogs.date)),
      db.select().from(exercises),
      db.select().from(maxEntries),
      db.select().from(sessions).orderBy(asc(sessions.date)),
    ]);
    c.header("Content-Disposition", `attachment; filename="strawvine-export-${new Date().toISOString().slice(0, 10)}.json"`);
    return c.json({
      exportedAt: new Date().toISOString(),
      settings: s[0]?.data ?? null,
      days: days.map(toDay),
      exercises: ex.map(toExercise),
      maxEntries: maxes.map(toMax),
      sessions: sess.map((r) => r.data),
    });
  });

  app.route("/api", api);
  app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

  // ---- web app ----------------------------------------------------------------
  if (opts.staticDir) {
    const root = path.relative(process.cwd(), opts.staticDir) || ".";
    app.use(
      "/assets/*",
      async (c, next) => {
        await next();
        c.header("Cache-Control", "public, max-age=31536000, immutable");
      },
      serveStatic({ root }),
    );
    app.use("*", serveStatic({ root }));
    let indexHtml: string | null = null;
    app.get("*", async (c) => {
      indexHtml ??= await readFile(path.join(opts.staticDir!, "index.html"), "utf8");
      c.header("Cache-Control", "no-cache");
      return c.html(indexHtml);
    });
  }

  return app;
}
