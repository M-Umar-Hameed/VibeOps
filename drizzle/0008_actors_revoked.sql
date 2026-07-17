ALTER TABLE "actors" ADD COLUMN IF NOT EXISTS "revoked" boolean NOT NULL DEFAULT false;
