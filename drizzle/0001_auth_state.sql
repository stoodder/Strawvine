CREATE TABLE "auth_state" (
	"id" integer PRIMARY KEY NOT NULL,
	"session_epoch" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
