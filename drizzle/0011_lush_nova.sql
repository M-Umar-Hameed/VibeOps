ALTER TABLE "ai_usage_logs" ADD COLUMN "ticket_id" uuid;--> statement-breakpoint
ALTER TABLE "ai_usage_logs" ADD COLUMN "actor_id" uuid;--> statement-breakpoint
ALTER TABLE "ai_usage_logs" ADD COLUMN "duration_ms" integer;