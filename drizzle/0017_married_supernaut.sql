ALTER TYPE "public"."source_kind" ADD VALUE 'chat';--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD COLUMN "project_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
