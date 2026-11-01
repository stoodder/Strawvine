CREATE TABLE "day_logs" (
	"date" date PRIMARY KEY NOT NULL,
	"weight_lb" double precision,
	"calories" double precision,
	"protein_g" double precision,
	"carbs_g" double precision,
	"fat_g" double precision,
	"micros" jsonb,
	"steps" integer,
	"sleep_score" double precision,
	"hrv_ms" double precision,
	"sleep_minutes" double precision,
	"energy" integer,
	"soreness" integer,
	"zone2_done" boolean DEFAULT false NOT NULL,
	"zone2_minutes" double precision,
	"metcon_done" boolean DEFAULT false NOT NULL,
	"metcon_notes" text,
	"metcon_benchmark" varchar(120),
	"metcon_score" varchar(120),
	"journal" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "exercises" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(80) NOT NULL,
	"category" varchar(20) DEFAULT 'accessory' NOT NULL,
	"tracks_max" boolean DEFAULT false NOT NULL,
	"measure" varchar(10) DEFAULT 'reps' NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "max_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"exercise_id" integer NOT NULL,
	"date" date NOT NULL,
	"value_lb" double precision NOT NULL,
	"source" varchar(10) NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "seen_achievements" (
	"key" varchar(120) PRIMARY KEY NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"date" date PRIMARY KEY NOT NULL,
	"data" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" integer PRIMARY KEY NOT NULL,
	"data" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "max_entries" ADD CONSTRAINT "max_entries_exercise_id_exercises_id_fk" FOREIGN KEY ("exercise_id") REFERENCES "public"."exercises"("id") ON DELETE cascade ON UPDATE no action;