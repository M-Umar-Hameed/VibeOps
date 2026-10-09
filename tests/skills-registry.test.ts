import { describe, it, expect, afterEach, vi } from "vitest";
import { searchRegistry } from "../src/skills/marketplace.js";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks(); });

function mockFetch(body: unknown, ok = true, status = 200) {
  globalThis.fetch = vi.fn(async () => ({
    ok, status, json: async () => body,
  })) as unknown as typeof fetch;
}

describe("searchRegistry", () => {
  it("maps registry rows to clone urls and keeps install ranking", async () => {
    mockFetch({ skills: [
      { name: "webapp-testing", source: "anthropics/skills", installs: 172108 },
      { name: "clerk-testing", source: "clerk/skills", installs: 43500 },
    ] });
    const r = await searchRegistry("testing");
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ name: "webapp-testing", source: "anthropics/skills", url: "https://github.com/anthropics/skills", installs: 172108 });
    expect(r[0].installs).toBeGreaterThan(r[1].installs);
  });

  it("drops rows whose source is not a valid owner/repo, so no hostile clone url is built", async () => {
    mockFetch({ skills: [
      { name: "ok", source: "owner/repo", installs: 1 },
      { name: "traversal", source: "../../etc", installs: 9 },
      { name: "host", source: "https://evil.com/x", installs: 9 },
      { name: "missing-name", source: "owner/repo" },
      { name: 5, source: "owner/repo", installs: 9 },
    ] });
    const r = await searchRegistry("x");
    expect(r.map((s) => s.source)).toEqual(["owner/repo", "owner/repo"]);
    expect(r.every((s) => s.url.startsWith("https://github.com/"))).toBe(true);
  });

  it("honours the limit", async () => {
    mockFetch({ skills: Array.from({ length: 10 }, (_, i) => ({ name: `s${i}`, source: `o/r${i}`, installs: i })) });
    expect(await searchRegistry("x", { limit: 3 })).toHaveLength(3);
  });

  it("throws on a non-ok response so the route can surface it", async () => {
    mockFetch({}, false, 503);
    await expect(searchRegistry("x")).rejects.toThrow(/HTTP 503/);
  });

  it("passes an owner filter through to the query", async () => {
    let seenUrl = "";
    globalThis.fetch = (async (url: unknown) => {
      seenUrl = String(url);
      return { ok: true, status: 200, json: async () => ({ skills: [] }) };
    }) as unknown as typeof fetch;
    await searchRegistry("test", { owner: "anthropics" });
    expect(seenUrl).toContain("owner=anthropics");
  });
});

import { describe as describe2, it as it2, expect as expect2, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { installFromRegistry, listInstalled, removeMarketplace } from "../src/skills/marketplace.js";

function gitRepoWithSkill(base: string, source: string, skillDir: string): void {
  const repo = join(base, source);
  mkdirSync(join(repo, skillDir), { recursive: true });
  writeFileSync(join(repo, skillDir, "SKILL.md"), `---\nname: ${skillDir}\ndescription: ${skillDir} skill\n---\n# ${skillDir}\n`);
  const g = (...a: string[]) => execFileSync("git", a, { cwd: repo });
  g("init", "-b", "main"); g("config", "user.email", "t@t"); g("config", "user.name", "t");
  g("add", "-A"); g("commit", "-m", "base");
}

describe2("installFromRegistry (local git fixture, isolated home)", () => {
  let ghBase: string;
  let skillsHome: string;
  const SOURCE = "acme/skills";

  beforeEach(() => {
    ghBase = mkdtempSync(join(tmpdir(), "gh-base-"));
    skillsHome = mkdtempSync(join(tmpdir(), "skills-home-reg-"));
    gitRepoWithSkill(ghBase, SOURCE, "cool-skill");
    process.env.VIBEOPS_SKILLS_HOME = skillsHome;
    process.env.VIBEOPS_SKILLS_ALLOW_LOCAL = "1";
    process.env.VIBEOPS_SKILLS_GITHUB_BASE = ghBase;
  });

  afterEach(async () => {
    await removeMarketplace(`${ghBase}/${SOURCE}`).catch(() => {});
    delete process.env.VIBEOPS_SKILLS_HOME;
    delete process.env.VIBEOPS_SKILLS_ALLOW_LOCAL;
    delete process.env.VIBEOPS_SKILLS_GITHUB_BASE;
    rmSync(ghBase, { recursive: true, force: true });
    rmSync(skillsHome, { recursive: true, force: true });
  });

  it2("clones the source and installs the named skill in one call", async () => {
    const entry = await installFromRegistry(SOURCE, "cool-skill");
    expect2(entry.dir).toBe("cool-skill");
    const installed = await listInstalled();
    expect2(installed.some((e) => e.dir === "cool-skill" && e.present)).toBe(true);
  });

  it2("rejects a source that is not owner/repo", async () => {
    await expect2(installFromRegistry("../../etc", "x")).rejects.toThrow(/invalid registry source/);
  });

  it2("404s a name that does not exist in the source", async () => {
    await expect2(installFromRegistry(SOURCE, "no-such-skill")).rejects.toThrow(/not found in/);
  });
});
