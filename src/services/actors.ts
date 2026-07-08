import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { actors, type Actor } from "../db/schema.js";
import { AuthError } from "./errors.js";

export function hashKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export async function createActor(input: {
  name: string; kind: "human" | "agent"; role?: string;
}): Promise<{ actor: Actor; apiKey: string }> {
  const apiKey = randomBytes(24).toString("hex");
  const [actor] = await db.insert(actors).values({
    name: input.name, kind: input.kind, role: input.role ?? "member",
    apiKeyHash: hashKey(apiKey),
  }).returning();
  return { actor, apiKey };
}

export async function resolveActor(rawKey: string): Promise<Actor> {
  const [actor] = await db.select().from(actors)
    .where(eq(actors.apiKeyHash, hashKey(rawKey))).limit(1);
  if (!actor) throw new AuthError("invalid api key");
  return actor;
}

export async function listActors(): Promise<{ id: string; name: string; kind: string; role: string }[]> {
  return db.select({ id: actors.id, name: actors.name, kind: actors.kind, role: actors.role }).from(actors);
}
