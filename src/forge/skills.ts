import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readSkillMeta } from "../skills/marketplace.js";

export interface SkillMeta { name: string; description: string; path: string }

const SKILL_BODY_CAP = 16000;

// Directory names under a skills root. Missing dir -> []. Moved here from
// src/api/forge-routes.ts so the /forge/skills route and the pipeline share it.
export function listSkillDir(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

// Every <dir>/SKILL.md under <workdir>/.claude/skills and ~/.claude/skills.
// workdir first, workdir wins on a name clash, optional allowlist (case-insensitive,
// empty means no filter). name = frontmatter name else dir; description = frontmatter
// description else "". A dir without a readable SKILL.md is skipped.
export function listSkills(workdir: string, allowlist?: string[]): SkillMeta[] {
  const roots = [join(workdir, ".claude", "skills"), join(homedir(), ".claude", "skills")];
  const byName = new Map<string, SkillMeta>();
  for (const root of roots) {
    for (const dir of listSkillDir(root)) {
      const path = join(root, dir, "SKILL.md");
      let meta: { name: string; description: string };
      try {
        meta = readSkillMeta(path, dir);
      } catch {
        continue; // no SKILL.md in this dir
      }
      if (!byName.has(meta.name)) {
        byName.set(meta.name, { name: meta.name, description: meta.description, path });
      }
    }
  }
  if (allowlist?.length) {
    const allow = new Set(allowlist.map((n) => n.toLowerCase()));
    return [...byName.values()].filter((s) => allow.has(s.name.toLowerCase()));
  }
  return [...byName.values()];
}

// forge.skillAllowlist value: JSON array of skill names. Unset, invalid, non-array
// or empty -> undefined (no filter). Invalid JSON warns so a typo is visible.
export function parseSkillAllowlist(raw: string | null | undefined): string[] | undefined {
  if (!raw?.trim()) return undefined;
  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v) && v.length && v.every((n) => typeof n === "string")) return v;
  } catch { /* fallthrough */ }
  console.warn("forge: forge.skillAllowlist is not a JSON array of names; ignored");
  return undefined;
}

// SKILL.md body with the leading frontmatter block removed, capped at 16000
// chars with a trailing "[skill truncated]" line when cut.
export function readSkillBody(path: string): string {
  const text = readFileSync(path, "utf-8");
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  if (body.length <= SKILL_BODY_CAP) return body;
  return body.slice(0, SKILL_BODY_CAP) + "\n[skill truncated]";
}

function dedupeCap(names: string[]): string[] {
  const out: string[] = [];
  for (const n of names) if (!out.includes(n) && out.length < 3) out.push(n);
  return out;
}

// LAST line matching /^\s*Skills:\s*(.*)$/im, split on commas, trimmed, lowered,
// "none" and unknown names dropped, deduped, capped at 3 in written order.
export function parsePlanSkills(plan: string, known: string[]): string[] {
  const knownLower = new Set(known.map((k) => k.toLowerCase()));
  const last = [...plan.matchAll(/^\s*Skills:\s*(.*)$/gim)].at(-1);
  if (!last) return [];
  return dedupeCap(
    last[1].split(",").map((s) => s.trim().toLowerCase())
      .filter((s) => s && s !== "none" && knownLower.has(s)),
  );
}

// Every /name token whose name is known (what the "/" autocomplete inserts).
export function parseOperatorSkills(extra: string, known: string[]): string[] {
  const knownLower = new Set(known.map((k) => k.toLowerCase()));
  const tokens = [...extra.matchAll(/\/([A-Za-z0-9._:-]+)/g)].map((m) => m[1].toLowerCase());
  return dedupeCap(tokens.filter((t) => knownLower.has(t)));
}

export function formatSkillIndex(skills: SkillMeta[]): string {
  if (!skills.length) return "";
  return "Available skills:\n" + skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");
}

export function formatSkillBodies(skills: SkillMeta[]): string {
  return skills.map((s) => `\n### Skill: ${s.name}\n${readSkillBody(s.path)}\n`).join("");
}
