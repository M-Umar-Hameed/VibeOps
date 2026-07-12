import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { db } from "./db/client.js";
import { actors } from "./db/schema.js";
import { createActor } from "./services/actors.js";
import { createProject } from "./services/projects.js";

// First-run self-setup for the embedded database. Idempotent: any existing
// actor means the system is already initialized.
export async function runBootstrap(
  port: number, dir = join(homedir(), ".vibeops"),
): Promise<{ bootstrapped: boolean }> {
  // The default vault (human markdown, auto-indexed) lives inside the backup
  // unit. Created every boot so pre-vault installs pick it up; the starter
  // note is seeded once and never overwritten.
  try {
    const vaultDir = join(dir, "vault");
    mkdirSync(vaultDir, { recursive: true });
    const starter = join(vaultDir, "README.md");
    if (!existsSync(starter)) {
      writeFileSync(starter,
        "# VibeOps Vault\n\nDrop markdown files here — VibeOps indexes them into knowledge search automatically.\n" +
        "Open this folder as an Obsidian vault if you use Obsidian; any editor works.\n");
    }
  } catch (e) {
    console.warn(`could not prepare default vault: ${(e as Error).message}`);
  }

  const [existing] = await db.select({ id: actors.id }).from(actors).limit(1);
  if (existing) return { bootstrapped: false };

  await createProject({ key: "inbox", name: "Inbox" });
  const { apiKey } = await createActor({ name: "owner", kind: "human", role: "admin" });
  const creds = { baseUrl: `http://localhost:${port}`, apiKey };
  try {
    // Owner-only permissions (like ~/.ssh). Effective on POSIX; on Windows the
    // file inherits the user-profile ACL, which is already user-scoped.
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const credsPath = join(dir, "credentials.json");
    writeFileSync(credsPath, JSON.stringify(creds, null, 2), { mode: 0o600 });
    chmodSync(credsPath, 0o600); // mode option only applies on creation; tighten pre-existing files too
  } catch (e) {
    console.warn(`could not write credentials file: ${(e as Error).message}`);
    console.log(`api key (copy now, shown once): ${apiKey}`);
  }
  return { bootstrapped: true };
}
