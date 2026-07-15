import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { getSetting, setSetting } from "../services/settings.js";
import { ConflictError, NotFoundError } from "../services/errors.js";

const DIFF_CAP = 50_000;
const DIR_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

export interface DiscoveredSkill {
  name: string;
  description: string;
  dir: string;
  sourcePath: string;
}
export interface PublicSkill { name: string; description: string; dir: string; installed: boolean }
export interface MarketplaceListing { url: string; skills: PublicSkill[] }
interface MarketplaceEntry { url: string; addedAt: string }
export interface InstalledSkillEntry { name: string; dir: string; url: string; installedAt: string }

function skillsRoot(): string {
  return process.env.VIBEOPS_SKILLS_HOME ?? homedir();
}

function marketplacesRoot(): string {
  return join(skillsRoot(), ".vibeops", "marketplaces");
}

function claudeSkillsDir(): string {
  return join(skillsRoot(), ".claude", "skills");
}

function marketplaceDir(url: string): string {
  return join(marketplacesRoot(), createHash("sha1").update(url).digest("hex"));
}

// dir names are joined straight into filesystem paths (install target,
// uninstall target); reject anything that isn't a single safe path segment.
function sanitizeDirName(name: string): string {
  if (name === "." || name === ".." || !DIR_NAME_RE.test(name)) {
    throw new Error(`invalid skill directory name "${name}"`);
  }
  return name;
}

// Discovery-time token building: coerce arbitrary plugin/skill names into a
// safe dir segment instead of failing the whole scan on one odd name.
function toDirToken(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 64) || "skill";
}

function validateMarketplaceUrl(url: string): void {
  if (process.env.VIBEOPS_SKILLS_ALLOW_LOCAL === "1") return; // test escape hatch for local path fixtures
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("invalid marketplace url");
  }
  if (parsed.protocol !== "https:") throw new Error("marketplace url must be https");
}

// Arg-vector git, mirrors src/forge/sandbox.ts's spawn pattern.
function git(cwd: string, ...args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const cap = (d: Buffer) => { if (out.length < DIFF_CAP) out += d.toString("utf-8"); };
    child.stdout?.on("data", cap);
    child.stderr?.on("data", cap);
    child.on("close", (code) => resolve({ code: code ?? 1, out: out.slice(0, DIFF_CAP) }));
    child.on("error", (e) => resolve({ code: 1, out: String(e) }));
  });
}

async function cloneOrRefresh(url: string, dir: string): Promise<void> {
  if (existsSync(dir)) {
    const pull = await git(dir, "pull", "--ff-only");
    if (pull.code === 0) return;
    rmSync(dir, { recursive: true, force: true });
  }
  mkdirSync(marketplacesRoot(), { recursive: true });
  const clone = await git(marketplacesRoot(), "clone", "--depth", "1", url, dir);
  if (clone.code !== 0) throw new Error(`git clone failed: ${clone.out.trim()}`);
}

function readSkillMeta(skillMdPath: string, fallbackName: string): { name: string; description: string } {
  const text = readFileSync(skillMdPath, "utf-8");
  const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const block = frontmatter?.[1] ?? "";
  const name = block.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const description = block.match(/^description:\s*(.+)$/m)?.[1]?.trim();
  const heading = text.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return { name: name || fallbackName, description: description || heading || "" };
}

function findSkillMdFiles(root: string, maxDepth: number): string[] {
  const results: string[] = [];
  function walk(dir: string, depth: number) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === ".git") continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.isFile() && e.name === "SKILL.md") results.push(full);
    }
  }
  walk(root, 1);
  return results;
}

interface MarketplaceManifest { plugins?: Array<{ name?: string; source?: string }> }

function discoverPluginFormat(repoDir: string, manifestPath: string): DiscoveredSkill[] {
  let manifest: MarketplaceManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch {
    return [];
  }
  const skills: DiscoveredSkill[] = [];
  for (const plugin of manifest.plugins ?? []) {
    const pluginName = plugin.name ?? "plugin";
    const pluginDir = join(repoDir, plugin.source ?? plugin.name ?? "");
    const skillsGlobDir = join(pluginDir, "skills");
    let entries;
    try {
      entries = readdirSync(skillsGlobDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const skillMd = join(skillsGlobDir, e.name, "SKILL.md");
      if (!existsSync(skillMd)) continue;
      const meta = readSkillMeta(skillMd, e.name);
      skills.push({
        name: `${pluginName}:${e.name}`,
        description: meta.description,
        dir: `${toDirToken(pluginName)}-${toDirToken(e.name)}`.slice(0, 64),
        sourcePath: join(skillsGlobDir, e.name),
      });
    }
  }
  return skills;
}

function discoverPlainFormat(repoDir: string): DiscoveredSkill[] {
  return findSkillMdFiles(repoDir, 3).map((skillMdPath) => {
    const sourcePath = dirname(skillMdPath);
    const dir = basename(sourcePath);
    const meta = readSkillMeta(skillMdPath, dir);
    return { name: meta.name, description: meta.description, dir, sourcePath };
  });
}

export function discoverSkills(repoDir: string): DiscoveredSkill[] {
  const manifestPath = join(repoDir, ".claude-plugin", "marketplace.json");
  if (existsSync(manifestPath)) return discoverPluginFormat(repoDir, manifestPath);
  return discoverPlainFormat(repoDir);
}

async function getMarketplaces(): Promise<MarketplaceEntry[]> {
  const raw = await getSetting("skills.marketplaces");
  return raw ? JSON.parse(raw) : [];
}
async function setMarketplaces(list: MarketplaceEntry[]): Promise<void> {
  await setSetting("skills.marketplaces", JSON.stringify(list));
}
async function getInstalled(): Promise<InstalledSkillEntry[]> {
  const raw = await getSetting("skills.installed");
  return raw ? JSON.parse(raw) : [];
}
async function setInstalled(list: InstalledSkillEntry[]): Promise<void> {
  await setSetting("skills.installed", JSON.stringify(list));
}

function toPublic(skill: DiscoveredSkill, installed: InstalledSkillEntry[]): PublicSkill {
  return {
    name: skill.name,
    description: skill.description,
    dir: skill.dir,
    installed: installed.some((e) => e.dir === skill.dir),
  };
}

export async function addMarketplace(url: string): Promise<PublicSkill[]> {
  validateMarketplaceUrl(url);
  const dir = marketplaceDir(url);
  await cloneOrRefresh(url, dir);
  const marketplaces = await getMarketplaces();
  if (!marketplaces.some((m) => m.url === url)) {
    await setMarketplaces([...marketplaces, { url, addedAt: new Date().toISOString() }]);
  }
  const installed = await getInstalled();
  return discoverSkills(dir).map((s) => toPublic(s, installed));
}

export async function listMarketplaces(): Promise<MarketplaceListing[]> {
  const marketplaces = await getMarketplaces();
  const installed = await getInstalled();
  return marketplaces.map((m) => ({
    url: m.url,
    skills: discoverSkills(marketplaceDir(m.url)).map((s) => toPublic(s, installed)),
  }));
}

export async function removeMarketplace(url: string): Promise<void> {
  const marketplaces = await getMarketplaces();
  await setMarketplaces(marketplaces.filter((m) => m.url !== url));
  rmSync(marketplaceDir(url), { recursive: true, force: true });
}

export async function installSkill(url: string, dir: string): Promise<InstalledSkillEntry> {
  sanitizeDirName(dir);
  const skill = discoverSkills(marketplaceDir(url)).find((s) => s.dir === dir);
  if (!skill) throw new NotFoundError(`skill "${dir}" not found in marketplace`);
  const installed = await getInstalled();
  const target = join(claudeSkillsDir(), dir);
  const owned = installed.some((e) => e.dir === dir);
  if (existsSync(target) && !owned) {
    throw new ConflictError(`"${dir}" already exists and is not managed by the registry`);
  }
  mkdirSync(claudeSkillsDir(), { recursive: true });
  cpSync(skill.sourcePath, target, { recursive: true });
  const entry: InstalledSkillEntry = { name: skill.name, dir, url, installedAt: new Date().toISOString() };
  await setInstalled([...installed.filter((e) => e.dir !== dir), entry]);
  return entry;
}

export async function uninstallSkill(name: string): Promise<void> {
  const installed = await getInstalled();
  const entry = installed.find((e) => e.name === name);
  if (!entry) throw new NotFoundError(`skill "${name}" not installed`);
  rmSync(join(claudeSkillsDir(), sanitizeDirName(entry.dir)), { recursive: true, force: true });
  await setInstalled(installed.filter((e) => e.name !== name));
}

export async function listInstalled(): Promise<(InstalledSkillEntry & { present: boolean })[]> {
  const installed = await getInstalled();
  return installed.map((e) => ({ ...e, present: existsSync(join(claudeSkillsDir(), e.dir)) }));
}
