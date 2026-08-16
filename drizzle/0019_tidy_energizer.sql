ALTER TABLE "embeddings" ADD COLUMN "project_id" uuid;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "embeddings_project_idx" ON "embeddings" USING btree ("project_id");--> statement-breakpoint
UPDATE "embeddings"
SET "project_id" = substring("source_ref" from 1 for 36)::uuid
WHERE "source_kind" IN ('repo','vault','chat')
  AND "source_ref" ~ '^[0-9a-fA-F-]{36}:'
  AND "project_id" IS NULL;
--> statement-breakpoint
UPDATE "embeddings" e
SET "project_id" = sub.pid
FROM (
  SELECT n.id::text AS ref,
         CASE WHEN n.scope = 'project' THEN n.ref_id
              WHEN n.scope = 'ticket'  THEN t.project_id
              ELSE NULL END AS pid
  FROM notes n
  LEFT JOIN tickets t ON t.id = n.ref_id
  WHERE n.deleted_at IS NULL
) sub
WHERE e.source_kind = 'note' AND e.source_ref = sub.ref
  AND e.project_id IS NULL;