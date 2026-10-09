import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
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
  // A local folder on the user's own disk is a legitimate marketplace (e.g.
  // the in-repo vibeops-pack); git clone accepts plain paths.
  if (/^[A-Za-z]:[\\/]/.test(url) || url.startsWith("/")) {
    if (existsSync(url)) return;
    throw new Error("local marketplace path does not exist");
  }
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
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
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

export function readSkillMeta(skillMdPath: string, fallbackName: string): { name: string; description: string } {
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
    // Manifest content is attacker-controlled: a "source" like ../../.. would
    // walk discovery (and later install-copy) outside the cloned repo.
    const pluginDir = resolve(repoDir, plugin.source ?? plugin.name ?? "");
    if (!pluginDir.startsWith(resolve(repoDir) + sep) && pluginDir !== resolve(repoDir)) continue;
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

// Everything under ~/.claude/skills, managed or not — the tab's honest answer
// to "where do my agents' current skills come from".
export function listLocalSkillDirs(): string[] {
  try {
    return readdirSync(claudeSkillsDir(), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

export function discoverSkills(repoDir: string): DiscoveredSkill[] {
  const manifestPath = join(repoDir, ".claude-plugin", "marketplace.json");
  if (existsSync(manifestPath)) return discoverPluginFormat(repoDir, manifestPath);
  return discoverPlainFormat(repoDir);
}

// Registry keys scope by the overridden root: parallel test files share one
// settings DB and would otherwise clobber each other's registries. Production
// (no env override) uses the plain keys.
function regKey(base: string): string {
  const home = process.env.VIBEOPS_SKILLS_HOME;
  return home ? `${base}:${createHash("sha1").update(home).digest("hex").slice(0, 8)}` : base;
}

async function getMarketplaces(): Promise<MarketplaceEntry[]> {
  const raw = await getSetting(regKey("skills.marketplaces"));
  return raw ? JSON.parse(raw) : [];
}
async function setMarketplaces(list: MarketplaceEntry[]): Promise<void> {
  await setSetting(regKey("skills.marketplaces"), JSON.stringify(list));
}
async function getInstalled(): Promise<InstalledSkillEntry[]> {
  const raw = await getSetting(regKey("skills.installed"));
  return raw ? JSON.parse(raw) : [];
}
async function setInstalled(list: InstalledSkillEntry[]): Promise<void> {
  await setSetting(regKey("skills.installed"), JSON.stringify(list));
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
  // Defense in depth against manifest-driven traversal: only copy from inside
  // the marketplace clone, never elsewhere on the host.
  const cloneRoot = resolve(marketplaceDir(url));
  if (!resolve(skill.sourcePath).startsWith(cloneRoot + sep)) {
    throw new ConflictError("skill source escapes the marketplace clone");
  }
  mkdirSync(claudeSkillsDir(), { recursive: true });
  cpSync(skill.sourcePath, target, { recursive: true });
  const entry: InstalledSkillEntry = { name: skill.name, dir, url, installedAt: new Date().toISOString() };
  await setInstalled([...installed.filter((e) => e.dir !== dir), entry]);
  return entry;
}

// One-call install straight from a registry result: add (clone) the source repo
// as a marketplace, find the skill whose directory matches the registry name, and
// install it. Every step is the existing hardened path - addMarketplace's url
// validation, discoverSkills, installSkill's traversal and dir-name guards - so
// this only chains them; it introduces no new way to fetch or copy anything.
export async function installFromRegistry(source: string, name: string): Promise<InstalledSkillEntry> {
  if (!OWNER_REPO_RE.test(source)) throw new NotFoundError(`invalid registry source "${source}"`);
  // Base is configurable only so tests can point at a local git fixture; it
  // defaults to github.com and the owner/repo shape is already validated above.
  const base = (process.env.VIBEOPS_SKILLS_GITHUB_BASE ?? "https://github.com").replace(/\/$/, "");
  const url = `${base}/${source}`;
  await addMarketplace(url); // clones/refreshes and registers the marketplace
  const skills = discoverSkills(marketplaceDir(url));
  // Registry name is the skill's directory inside its repo; fall back to the
  // frontmatter name so a repo that renames via frontmatter still resolves.
  const match = skills.find((sk) => sk.dir === name) ?? skills.find((sk) => sk.name === name);
  if (!match) throw new NotFoundError(`skill "${name}" not found in ${source}`);
  return installSkill(url, match.dir);
}

export async function uninstallSkill(name: string): Promise<void> {
  const installed = await getInstalled();
  const entry = installed.find((e) => e.name === name);
  if (!entry) throw new NotFoundError(`skill "${name}" not installed`);
  rmSync(join(claudeSkillsDir(), sanitizeDirName(entry.dir)), { recursive: true, force: true });
  await setInstalled(installed.filter((e) => e.name !== name));
}

export interface RegistrySkill {
  name: string;      // skill directory name inside its source repo
  source: string;    // GitHub "owner/repo" the skill lives in
  url: string;       // clone url: https://github.com/<source>
  installs: number;
  installed: boolean; // already present in ~/.claude/skills under this name
}

// skills.sh is the public, install-ranked registry behind `npx skills`. Its
// search API returns each skill's source repo ("owner/repo") and skill name; a
// result maps straight onto the marketplace model this file already hardened -
// the source is a GitHub repo to addMarketplace, the name is a skill inside it
// to installSkill. So search only resolves and ranks; clone/discover/install
// stay on the one path with the traversal and dir-name guards.
const REGISTRY_BASE = process.env.VIBEOPS_SKILLS_API_URL ?? "https://skills.sh";
const OWNER_REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

export async function searchRegistry(
  query: string,
  opts: { owner?: string; limit?: number } = {},
): Promise<RegistrySkill[]> {
  const params = new URLSearchParams({ q: query });
  if (opts.owner) params.set("owner", opts.owner);
  const url = `${REGISTRY_BASE}/api/search?${params.toString()}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  let data: { skills?: Array<{ name?: unknown; source?: unknown; installs?: unknown }> };
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`skills.sh search failed: HTTP ${res.status}`);
    data = await res.json();
  } finally {
    clearTimeout(timer);
  }
  const installedDirs = new Set((await getInstalled()).map((e) => e.dir));
  const localDirs = new Set(listLocalSkillDirs());
  const out: RegistrySkill[] = [];
  for (const raw of data.skills ?? []) {
    // The registry is third-party data: a malformed or hostile row (a source
    // that is not owner/repo, a non-string name) is dropped, never turned into
    // a clone url, so nothing downstream clones an attacker-chosen host.
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    const source = typeof raw.source === "string" ? raw.source.trim() : "";
    if (!name || !OWNER_REPO_RE.test(source)) continue;
    const installs = typeof raw.installs === "number" && raw.installs >= 0 ? raw.installs : 0;
    out.push({
      name, source,
      url: `https://github.com/${source}`,
      installs,
      installed: installedDirs.has(name) || localDirs.has(name),
    });
    if (opts.limit && out.length >= opts.limit) break;
  }
  return out;
}

export async function listInstalled(): Promise<(InstalledSkillEntry & { present: boolean })[]> {
  const installed = await getInstalled();
  return installed.map((e) => ({ ...e, present: existsSync(join(claudeSkillsDir(), e.dir)) }));
}
