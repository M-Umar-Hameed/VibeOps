CREATE TABLE IF NOT EXISTS "knowledge_query_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"caller" text NOT NULL,
	"project_id" uuid,
	"hit_count" integer NOT NULL,
	"hit_kinds" jsonb NOT NULL,
	"top_score" integer,
	"query_text" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
