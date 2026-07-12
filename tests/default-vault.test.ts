import { expect, test } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBootstrap } from "../src/bootstrap.js";
import { defaultVaultPath, resolveVaultPath } from "../src/ingest/watch.js";
import { setSetting } from "../src/services/settings.js";
import { db } from "../src/db/client.js";
import { settings } from "../src/db/schema.js";
import { eq } from "drizzle-orm";

test("bootstrap creates the vault dir with a starter note and never clobbers it", async () => {
  const home = mkdtempSync(join(tmpdir(), "vibeops-vault-"));
  await runBootstrap(18999, home);
  const starter = join(home, "vault", "README.md");
  expect(existsSync(starter)).toBe(true);
  expect(readFileSync(starter, "utf8")).toContain("VibeOps");

  writeFileSync(starter, "my edited note");
  await runBootstrap(18999, home); // second run: idempotent, no clobber
  expect(readFileSync(starter, "utf8")).toBe("my edited note");
});

test("resolveVaultPath: setting wins, default otherwise", async () => {
  // Ensure no leftover setting from other tests, then check the default.
  await db.delete(settings).where(eq(settings.key, "obsidian.vault_path"));
  const home = mkdtempSync(join(tmpdir(), "vibeops-home-"));
  expect(await resolveVaultPath(home)).toBe(join(home, ".vibeops", "vault"));
  expect(defaultVaultPath(home)).toBe(join(home, ".vibeops", "vault"));

  await setSetting("obsidian.vault_path", "D:/some/external/vault");
  try {
    expect(await resolveVaultPath(home)).toBe("D:/some/external/vault");
  } finally {
    await db.delete(settings).where(eq(settings.key, "obsidian.vault_path"));
  }
});
