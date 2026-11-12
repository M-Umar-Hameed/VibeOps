ALTER TABLE "notes" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN "confidence" real DEFAULT 0.7 NOT NULL;
