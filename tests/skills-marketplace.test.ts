import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, unlinkSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  discoverSkills, addMarketplace, listMarketplaces, removeMarketplace,
  installSkill, uninstallSkill, listInstalled,
} from "../src/skills/marketplace.js";
import { ConflictError, NotFoundError } from "../src/services/errors.js";

function writeSkill(dir: string, name: string, content: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), content);
}

describe("discoverSkills: plain format", () => {
  it("parses frontmatter name/description", () => {
    const root = mkdtempSync(join(tmpdir(), "skills-plain-"));
    writeSkill(join(root, "my-skill"), "my-skill", "---\nname: my-skill\ndescription: Does a thing\n---\n# My Skill\nbody\n");
    const skills = discoverSkills(root);
    expect(skills).toEqual([{
      name: "my-skill", description: "Does a thing", dir: "my-skill", sourcePath: join(root, "my-skill"),
    }]);
    rmSync(root, { recursive: true, force: true });
  });

  it("falls back to dir name and first heading when frontmatter is absent", () => {
    const root = mkdtempSync(join(tmpdir(), "skills-plain-fb-"));
    writeSkill(join(root, "no-frontmatter"), "x", "# Fallback Heading\nbody text\n");
    const skills = discoverSkills(root);
    expect(skills).toEqual([{
      name: "no-frontmatter", description: "Fallback Heading",
      dir: "no-frontmatter", sourcePath: join(root, "no-frontmatter"),
    }]);
    rmSync(root, { recursive: true, force: true });
  });

  it("scans nested dirs up to depth 3", () => {
    const root = mkdtempSync(join(tmpdir(), "skills-plain-nested-"));
    writeSkill(join(root, "cat", "nested-skill"), "x", "---\nname: nested\ndescription: deep\n---\n");
    const skills = discoverSkills(root);
    expect(skills.map((s) => s.name)).toContain("nested");
    rmSync(root, { recursive: true, force: true });
  });
});

describe("discoverSkills: plugin (marketplace.json) format", () => {
  it("labels skills plugin:skill-dir and sanitizes the install dir", () => {
    const root = mkdtempSync(join(tmpdir(), "skills-plugin-"));
    mkdirSync(join(root, ".claude-plugin"), { recursive: true });
    writeFileSync(join(root, ".claude-plugin", "marketplace.json"), JSON.stringify({
      plugins: [{ name: "acme", source: "./plugins/acme" }],
    }));
    writeSkill(join(root, "plugins", "acme", "skills", "widget"), "widget", "---\nname: widget\ndescription: Widget skill\n---\n");
    const skills = discoverSkills(root);
    expect(skills).toEqual([{
      name: "acme:widget", description: "Widget skill", dir: "acme-widget",
      sourcePath: join(root, "plugins", "acme", "skills", "widget"),
    }]);
    rmSync(root, { recursive: true, force: true });
  });

  it("ignores plugins with no skills dir instead of throwing", () => {
    const root = mkdtempSync(join(tmpdir(), "skills-plugin-empty-"));
    mkdirSync(join(root, ".claude-plugin"), { recursive: true });
    writeFileSync(join(root, ".claude-plugin", "marketplace.json"), JSON.stringify({
      plugins: [{ name: "empty", source: "./plugins/empty" }],
    }));
    expect(discoverSkills(root)).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });
});

function g(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd });
}

function initSourceRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "skills-src-"));
  g(dir, "init", "-b", "main");
  g(dir, "config", "user.email", "t@t");
  g(dir, "config", "user.name", "t");
  writeSkill(join(dir, "greeter"), "greeter", "---\nname: greeter\ndescription: Says hi\n---\n");
  g(dir, "add", "-A");
  g(dir, "commit", "-m", "base");
  return dir;
}

describe("install lifecycle (fixture git repos, isolated skills home)", () => {
  let sourceRepo: string;
  let skillsHome: string;
  let url: string;

  beforeEach(() => {
    sourceRepo = initSourceRepo();
    skillsHome = mkdtempSync(join(tmpdir(), "skills-home-"));
    process.env.VIBEOPS_SKILLS_HOME = skillsHome;
    process.env.VIBEOPS_SKILLS_ALLOW_LOCAL = "1";
    url = sourceRepo; // local path fixture, allowed via VIBEOPS_SKILLS_ALLOW_LOCAL
  });

  afterEach(async () => {
    await removeMarketplace(url).catch(() => {});
    delete process.env.VIBEOPS_SKILLS_HOME;
    delete process.env.VIBEOPS_SKILLS_ALLOW_LOCAL;
    rmSync(sourceRepo, { recursive: true, force: true });
    rmSync(skillsHome, { recursive: true, force: true });
  });

  it("addMarketplace clones and scans; listMarketplaces reads the local clone without network", async () => {
    const skills = await addMarketplace(url);
    expect(skills).toEqual([{ name: "greeter", description: "Says hi", dir: "greeter", installed: false }]);

    const listing = (await listMarketplaces()).find((m) => m.url === url);
    expect(listing?.skills).toEqual([{ name: "greeter", description: "Says hi", dir: "greeter", installed: false }]);
  });

  it("addMarketplace on a repeat URL refreshes instead of erroring or duplicating", async () => {
    await addMarketplace(url);
    const before = (await listMarketplaces()).filter((m) => m.url === url);
    expect(before).toHaveLength(1);
    await addMarketplace(url);
    const after = (await listMarketplaces()).filter((m) => m.url === url);
    expect(after).toHaveLength(1);
  });

  it("on pull failure, the clone is removed and re-cloned", async () => {
    await addMarketplace(url);
    const listing = (await listMarketplaces()).find((m) => m.url === url);
    expect(listing?.skills.length).toBe(1);

    // Corrupt the local clone so `git pull` fails, but leave the source repo intact.
    const cloneDir = join(skillsHome, ".vibeops", "marketplaces");
    const hashDirs = readdirSync(cloneDir);
    for (const h of hashDirs) {
      const headFile = join(cloneDir, h, ".git", "HEAD");
      if (existsSync(headFile)) unlinkSync(headFile);
    }

    const skills = await addMarketplace(url); // should rm + re-clone, not throw
    expect(skills).toEqual([{ name: "greeter", description: "Says hi", dir: "greeter", installed: false }]);
  });

  it("install / re-install (update) / uninstall lifecycle", async () => {
    await addMarketplace(url);
    const entry = await installSkill(url, "greeter");
    expect(entry).toMatchObject({ name: "greeter", dir: "greeter", url });
    const target = join(skillsHome, ".claude", "skills", "greeter");
    expect(existsSync(join(target, "SKILL.md"))).toBe(true);

    const installedList = await listInstalled();
    expect(installedList.find((e) => e.dir === "greeter")).toMatchObject({ present: true });

    // Re-install of an owned skill overwrites (update), no conflict.
    await expect(installSkill(url, "greeter")).resolves.toMatchObject({ dir: "greeter" });

    await uninstallSkill("greeter");
    expect(existsSync(target)).toBe(false);
    expect((await listInstalled()).find((e) => e.dir === "greeter")).toBeUndefined();

    await expect(uninstallSkill("greeter")).rejects.toThrow(NotFoundError);
  });

  it("install refuses to overwrite a dir that exists but isn't ours", async () => {
    await addMarketplace(url);
    const target = join(skillsHome, ".claude", "skills", "greeter");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "hand-authored.txt"), "user content\n");

    await expect(installSkill(url, "greeter")).rejects.toThrow(ConflictError);
    expect(existsSync(join(target, "hand-authored.txt"))).toBe(true); // untouched
  });

  it("installSkill 404s for a dir not present in the marketplace scan", async () => {
    await addMarketplace(url);
    await expect(installSkill(url, "does-not-exist")).rejects.toThrow(NotFoundError);
  });

  it("removeMarketplace drops the clone and registry entry but leaves installed skills in place", async () => {
    await addMarketplace(url);
    await installSkill(url, "greeter");
    const target = join(skillsHome, ".claude", "skills", "greeter");

    await removeMarketplace(url);
    expect((await listMarketplaces()).find((m) => m.url === url)).toBeUndefined();
    expect(existsSync(target)).toBe(true); // installed skill survives marketplace removal

    await uninstallSkill("greeter");
  });

  it("rejects non-https marketplace URLs when the local escape hatch is off", async () => {
    delete process.env.VIBEOPS_SKILLS_ALLOW_LOCAL;
    await expect(addMarketplace("http://example.com/repo.git")).rejects.toThrow();
  });
});
