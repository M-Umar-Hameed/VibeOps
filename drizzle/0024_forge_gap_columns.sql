CREATE TABLE IF NOT EXISTS "forge_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"picks" jsonb,
	"extra_prompt" text,
	"after_ticket_ids" jsonb,
	"status" text DEFAULT 'queued' NOT NULL,
	"run_id" uuid,
	"error" text,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "forge_runs" ADD COLUMN "cause" text;--> statement-breakpoint
ALTER TABLE "forge_runs" ADD COLUMN "cause_detail" text;--> statement-breakpoint
ALTER TABLE "forge_runs" ADD COLUMN "work_base_sha" text;--> statement-breakpoint
ALTER TABLE "forge_runs" ADD COLUMN "base_branch" text;--> statement-breakpoint
ALTER TABLE "forge_runs" ADD COLUMN "stage_times" jsonb;--> statement-breakpoint
ALTER TABLE "forge_runs" ADD COLUMN "resume_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "forge_runs" ADD COLUMN "limit_waits" integer;--> statement-breakpoint
ALTER TABLE "forge_runs" ADD COLUMN "promote_on_pass" boolean;--> statement-breakpoint
ALTER TABLE "forge_runs" ADD COLUMN "allow_paths" jsonb;--> statement-breakpoint
ALTER TABLE "forge_runs" ADD COLUMN "gate_only_paths" jsonb;--> statement-breakpoint
ALTER TABLE "forge_runs" ADD COLUMN "gate_only_sha" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "source_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "forge_queue_queued_ticket_uniq" ON "forge_queue" USING btree ("ticket_id") WHERE "forge_queue"."status" = 'queued';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tickets_source_key_uniq" ON "tickets" USING btree ("project_id","source_key");