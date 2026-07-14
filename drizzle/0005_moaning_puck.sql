ALTER TYPE "public"."ticket_status" ADD VALUE 'planned';--> statement-breakpoint
ALTER TYPE "public"."ticket_status" ADD VALUE 'review';--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "kind" text DEFAULT 'comment' NOT NULL;