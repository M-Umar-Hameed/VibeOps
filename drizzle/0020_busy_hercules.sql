ALTER TABLE "forge_runs" ADD COLUMN "pid" integer;--> statement-breakpoint
ALTER TABLE "forge_runs" ADD COLUMN "log_path" text;--> statement-breakpoint
ALTER TABLE "forge_runs" ADD COLUMN "run_token" text;