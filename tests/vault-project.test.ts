import { afterAll, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeEmbedder } from "../src/knowledge/embedder.js";
import { upsertVaultFile, searchKnowledge } from "../src/services/knowledge.js";
import { createProject, setProjectSetting, getProjectSettings } from "../src/services/projects.js";
import { rescanProjectVaults, stopProjectVaults, watchedProjectPaths } from "../src/ingest/watch.js";

const emb = new FakeEmbedder(1024);

afterAll(async () => { await stopProjectVaults(); });

test("project vault chunks are scoped to their project", async () => {
  const uniq = `pv-${Date.now()}-${Math.round(performance.now() * 1000)}`;
  const shared = `# Vault ${uniq}\nproject vault marker text`;
  const projA = randomUUID();
  const projB = randomUUID();
  await upsertVaultFile(`${projA}:a.md`, shared, emb);
  await upsertVaultFile(`${projB}:b.md`, shared, emb);

  const aRefs = (await searchKnowledge(shared, { limit: 20, projectId: projA }, emb)).map((h) => h.sourceRef);
  expect(aRefs).toContain(`${projA}:a.md`);
  expect(aRefs).not.toContain(`${projB}:b.md`);
});

test("legacy global vault content stays searchable under project scope", async () => {
  const uniq = `pv-${Date.now()}-${Math.round(performance.now() * 1000)}`;
  const shared = `# Legacy ${uniq}\nlegacy global vault marker`;
  const projA = randomUUID();
  const legacyRef = `/legacy/vault/${uniq}.md`; // absolute path, no uuid prefix
  await upsertVaultFile(legacyRef, shared, emb);

  const refs = (await searchKnowledge(shared, { limit: 20, projectId: projA }, emb)).map((h) => h.sourceRef);
  expect(refs).toContain(legacyRef);
});

test("rescan starts, re-points, and stops project watchers without restart", { timeout: 90000 }, async () => {
  // Stop any watchers from prior tests/bootstrap before starting fresh.
  await stopProjectVaults();

  const dirA = mkdtempSync(join(tmpdir(), "vaultA-"));
  const dirB = mkdtempSync(join(tmpdir(), "vaultB-"));
  writeFileSync(join(dirA, "note.md"), "# a\nalpha content");
  writeFileSync(join(dirB, "note.md"), "# b\nbeta content");
  try {
    const p = await createProject({ key: `vp-${Date.now()}`, name: "VaultProj" });
    await setProjectSetting(p.id, "vault.path", dirA);

    await rescanProjectVaults(emb);
    expect(watchedProjectPaths().get(p.id)).toBe(dirA);

    // Override to a new path -> watch set updates, no restart.
    await setProjectSetting(p.id, "vault.path", dirB);
    await rescanProjectVaults(emb);
    expect(watchedProjectPaths().get(p.id)).toBe(dirB);
  } finally {
    await stopProjectVaults();
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});

test("vault.path project setting is stored raw, not binding-normalized", async () => {
  const p = await createProject({ key: `vpp-${Date.now()}`, name: "VaultPath" });
  await setProjectSetting(p.id, "vault.path", "/tmp/some/path/");
  const s = await getProjectSettings(p.id);
  expect(s["vault.path"]).toBe("/tmp/some/path/");
});
