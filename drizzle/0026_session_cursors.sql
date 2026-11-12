CREATE TABLE IF NOT EXISTS "session_cursors" (
	"source_ref" text PRIMARY KEY NOT NULL,
	"byte_offset" bigint NOT NULL,
	"file_size" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now()
);
