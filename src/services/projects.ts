import { db } from "../db/client.js";
import { projects, type Project } from "../db/schema.js";
import { ConflictError } from "./errors.js";

export async function listProjects(): Promise<Project[]> {
  return db.select().from(projects);
}

export async function createProject(input: { key: string; name: string }): Promise<Project> {
  try {
    const [p] = await db.insert(projects).values({ key: input.key, name: input.name }).returning();
    return p;
  } catch (e) {
    if (String((e as { code?: string }).code) === "23505") {
      throw new ConflictError(`project key already exists: ${input.key}`);
    }
    throw e;
  }
}
