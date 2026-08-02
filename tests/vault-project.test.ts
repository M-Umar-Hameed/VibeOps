import { afterAll, afterEach, expect, test, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// Temp home directory used by the default-vault test; set before vi.mock.
let mockHomeDir: string | null = null;
const realHomeDir = homedir();

// Mock node:os to redirect homedir() to our temp dir when set.
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => mockHomeDir ?? actual.homedir(),
  };
});

// Must import AFTER vi.mock so the mock is in place.
const { FakeEmbedder } = await import("../src/knowledge/embedder.js");
const { upsertVaultFile, searchKnowledge } = await import("../src/services/knowledge.js");
const { createProject, setProjectSetting, getProjectSettings } = await import("../src/services/projects.js");
const { rescanProjectVaults, stopProjectVaults, watchedProjectPaths, reindexFile } = await import("../src/ingest/watch.js");
const { defaultProjectVaultPath } = await import("../src/ingest/vault-path.js");

const emb = new FakeEmbedder(1024);

// Track project IDs created by default-vault test to verify real home untouched.
const defaultVaultTestProjectIds: string[] = [];

afterAll(async () => { await stopProjectVaults(); });

afterEach(() => {
  // Reset mock home after each test.
  mockHomeDir = null;
});

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

test("rescan starts, re-points, and stops project watchers without restart", async () => {
  // Stop any watchers from prior tests/bootstrap before starting fresh.
  await stopProjectVaults();

  const dirA = mkdtempSync(join(tmpdir(), "vaultA-"));
  const dirB = mkdtempSync(join(tmpdir(), "vaultB-"));
  writeFileSync(join(dirA, "note.md"), "# a\nalpha content");
  writeFileSync(join(dirB, "note.md"), "# b\nbeta content");
  try {
    const p = await createProject({ key: `vp-${Date.now()}`, name: "VaultProj" });
    await setProjectSetting(p.id, "vault.path", dirA);

    // Use projectIds filter to avoid full-DB scan (test isolation).
    await rescanProjectVaults(emb, [p.id]);
    expect(watchedProjectPaths().get(p.id)).toBe(dirA);

    // Override to a new path -> watch set updates, no restart.
    await setProjectSetting(p.id, "vault.path", dirB);
    await rescanProjectVaults(emb, [p.id]);
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

test("default vault dir is created, watched, and searchable for project with no override", async () => {
  await stopProjectVaults();
  // Redirect homedir() to a temp dir so we don't pollute real ~/.vibeops.
  const fakeHome = mkdtempSync(join(tmpdir(), "home-"));
  mockHomeDir = fakeHome;
  try {
    const p = await createProject({ key: `dvp-${Date.now()}`, name: "DefaultVault" });
    defaultVaultTestProjectIds.push(p.id);
    const expectedPath = join(fakeHome, ".vibeops", "vaults", p.id);

    // Dir should not exist yet.
    expect(existsSync(expectedPath)).toBe(false);

    // Rescan creates the default dir and starts watching.
    await rescanProjectVaults(emb, [p.id]);

    // (a) Directory exists under mocked home.
    expect(existsSync(expectedPath)).toBe(true);

    // (b) Watcher started and points to the expected path.
    expect(watchedProjectPaths().get(p.id)).toBe(expectedPath);

    // (c) Drop a markdown file; index it directly (chokidar timing is unreliable in tests).
    const uniqueContent = `# Test ${Date.now()}\ndefault vault searchable marker ${Math.random()}`;
    const searchableFile = join(expectedPath, "searchable.md");
    writeFileSync(searchableFile, uniqueContent);
    // Index with the project-scoped ref (simulates what the watcher would do).
    await reindexFile(searchableFile, emb, `${p.id}:searchable.md`);

    const hits = await searchKnowledge(uniqueContent, { limit: 10, projectId: p.id }, emb);
    const refs = hits.map((h) => h.sourceRef);
    expect(refs).toContain(`${p.id}:searchable.md`);

    // NOT returned for a different project.
    const otherProj = randomUUID();
    const otherHits = await searchKnowledge(uniqueContent, { limit: 10, projectId: otherProj }, emb);
    const otherRefs = otherHits.map((h) => h.sourceRef);
    expect(otherRefs).not.toContain(`${p.id}:searchable.md`);
  } finally {
    await stopProjectVaults();
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("real home untouched by default-vault test", () => {
  // Verify no directories leaked into real ~/.vibeops/vaults for test project IDs.
  const realVaultsDir = join(realHomeDir, ".vibeops", "vaults");
  if (!existsSync(realVaultsDir)) return; // no vaults dir at all, OK
  const entries = readdirSync(realVaultsDir);
  for (const pid of defaultVaultTestProjectIds) {
    expect(entries).not.toContain(pid);
  }
});
