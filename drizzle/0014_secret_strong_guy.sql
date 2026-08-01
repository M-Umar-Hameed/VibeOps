ALTER TABLE "forge_runs" ADD COLUMN "protected_violations" jsonb;--> statement-breakpoint
ALTER TABLE "forge_runs" ADD COLUMN "policy_waived_at" timestamp with time zone;