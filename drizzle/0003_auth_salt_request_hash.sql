ALTER TABLE "auth_state" ADD COLUMN "key_salt" varchar(64);--> statement-breakpoint
ALTER TABLE "exercises" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD COLUMN "request_hash" varchar(64);