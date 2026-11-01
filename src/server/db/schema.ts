import { boolean, date, doublePrecision, integer, jsonb, pgTable, serial, text, timestamp, varchar } from "drizzle-orm/pg-core";
import type { Session, Settings } from "../../shared/schemas";

/** One row per calendar day — the raw source of truth for everything derived. */
export const dayLogs = pgTable("day_logs", {
  date: date("date", { mode: "string" }).primaryKey(),
  weightLb: doublePrecision("weight_lb"),
  calories: doublePrecision("calories"),
  proteinG: doublePrecision("protein_g"),
  carbsG: doublePrecision("carbs_g"),
  fatG: doublePrecision("fat_g"),
  micros: jsonb("micros").$type<Record<string, number>>(),
  steps: integer("steps"),
  sleepScore: doublePrecision("sleep_score"),
  hrvMs: doublePrecision("hrv_ms"),
  sleepMinutes: doublePrecision("sleep_minutes"),
  energy: integer("energy"),
  soreness: integer("soreness"),
  zone2Done: boolean("zone2_done").notNull().default(false),
  zone2Minutes: doublePrecision("zone2_minutes"),
  metconDone: boolean("metcon_done").notNull().default(false),
  metconNotes: text("metcon_notes"),
  metconBenchmark: varchar("metcon_benchmark", { length: 120 }),
  metconScore: varchar("metcon_score", { length: 120 }),
  journal: text("journal"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const exercises = pgTable("exercises", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 80 }).notNull(),
  category: varchar("category", { length: 20 }).notNull().default("accessory"),
  tracksMax: boolean("tracks_max").notNull().default(false),
  measure: varchar("measure", { length: 10 }).notNull().default("reps"),
  archived: boolean("archived").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Every change to a tracked max — the current max is the latest entry. */
export const maxEntries = pgTable("max_entries", {
  id: serial("id").primaryKey(),
  exerciseId: integer("exercise_id")
    .notNull()
    .references(() => exercises.id, { onDelete: "cascade" }),
  date: date("date", { mode: "string" }).notNull(),
  valueLb: doublePrecision("value_lb").notNull(),
  source: varchar("source", { length: 10 }).notNull(),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** A training session is a flexible document (blocks → exercises → sets). */
export const sessions = pgTable("sessions", {
  date: date("date", { mode: "string" }).primaryKey(),
  data: jsonb("data").$type<Session>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Single settings document (id = 1). */
export const settings = pgTable("settings", {
  id: integer("id").primaryKey(),
  data: jsonb("data").$type<Settings>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Achievements the athlete has already been shown (so celebrations play once). */
export const seenAchievements = pgTable("seen_achievements", {
  key: varchar("key", { length: 120 }).primaryKey(),
  seenAt: timestamp("seen_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Server-side auth state (single row, id = 1). Session cookies carry the epoch they were
 * issued in; signing out bumps it, which revokes every cookie issued before.
 */
export const authState = pgTable("auth_state", {
  id: integer("id").primaryKey(),
  sessionEpoch: integer("session_epoch").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Responses to creates sent with an `Idempotency-Key` header, so a retried POST (the response
 * was lost, the client timed out) returns the original row instead of creating a duplicate.
 * Pruned after IDEMPOTENCY_TTL_MS.
 */
export const idempotencyKeys = pgTable("idempotency_keys", {
  key: varchar("key", { length: 80 }).primaryKey(),
  method: varchar("method", { length: 10 }).notNull(),
  path: varchar("path", { length: 200 }).notNull(),
  status: integer("status").notNull(),
  body: jsonb("body"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
