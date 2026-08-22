ALTER TABLE "notes" ADD COLUMN "kind" text DEFAULT 'note' NOT NULL;--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN "domain" text;--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN "rationale" text;--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN "source" text DEFAULT 'manual' NOT NULL;