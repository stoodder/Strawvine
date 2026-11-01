CREATE TABLE "idempotency_keys" (
	"key" varchar(80) PRIMARY KEY NOT NULL,
	"method" varchar(10) NOT NULL,
	"path" varchar(200) NOT NULL,
	"status" integer NOT NULL,
	"body" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
