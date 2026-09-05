import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  listSkills, readSkillBody, parsePlanSkills, parseOperatorSkills, formatSkillIndex,
} from "../src/forge/skills.js";

function writeSkill(root: string, dir: string, frontmatter: string, body: string): string {
  const d = join(root, ".claude", "skills", dir);
  mkdirSync(d, { recursive: true });
  const path = join(d, "SKILL.md");
  writeFileSync(path, `---\n${frontmatter}\n---\n${body}`);
  return path;
}

let home: string, workdir: string, prevHome: string | undefined, prevProfile: string | undefined;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "skills-home-"));
  workdir = mkdtempSync(join(tmpdir(), "skills-wd-"));
  prevHome = process.env.HOME; prevProfile = process.env.USERPROFILE;
  process.env.HOME = home; process.env.USERPROFILE = home;
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  if (prevProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevProfile;
  rmSync(home, { recursive: true, force: true });
  rmSync(workdir, { recursive: true, force: true });
});

test("listSkills reads both roots, workdir wins on a name clash, frontmatter falls back to dir name", () => {
  writeSkill(home, "alpha", "name: alpha\ndescription: home alpha", "home body");
  writeSkill(home, "beta", "name: beta\ndescription: home beta", "beta body");
  writeSkill(workdir, "alpha", "name: alpha\ndescription: workdir alpha", "workdir body");
  writeSkill(workdir, "gamma", "description: no name here", "gamma body");
  const byName = Object.fromEntries(listSkills(workdir).map((s) => [s.name, s]));
  expect(byName.alpha.description).toBe("workdir alpha");
  expect(byName.beta.description).toBe("home beta");
  expect(byName.gamma).toBeTruthy();
});

test("listSkills returns [] when the skills roots are missing", () => {
  expect(listSkills(join(tmpdir(), "no-such-dir-xyz-123"))).toEqual([]);
});

test("readSkillBody strips frontmatter and caps at 16000 with a truncation marker", () => {
  const p = writeSkill(workdir, "big", "name: big\ndescription: d", "X".repeat(20000));
  const body = readSkillBody(p);
  expect(body.startsWith("X")).toBe(true);
  expect(body).not.toContain("name: big");
  expect(body.endsWith("[skill truncated]")).toBe(true);
});

test("readSkillBody returns the full body under the cap with no marker", () => {
  const p = writeSkill(workdir, "small", "name: small\ndescription: d", "short body");
  expect(readSkillBody(p)).toContain("short body");
  expect(readSkillBody(p)).not.toContain("[skill truncated]");
});

test("parsePlanSkills takes the LAST Skills line, drops unknown and none, caps at 3, case-insensitive", () => {
  const known = ["a", "b", "c", "d"];
  expect(parsePlanSkills("Skills: x\nmid\nSkills: a, b, unknown, none", known)).toEqual(["a", "b"]);
  expect(parsePlanSkills("Skills: a, b, c, d", known)).toEqual(["a", "b", "c"]);
  expect(parsePlanSkills("Skills: none", known)).toEqual([]);
  expect(parsePlanSkills("no skills line", known)).toEqual([]);
  expect(parsePlanSkills("Skills: A", ["a"])).toEqual(["a"]);
});

test("parseOperatorSkills finds known /tokens, dedupes and caps at 3", () => {
  const known = ["demo", "forge", "docx"];
  expect(parseOperatorSkills("please use /demo and /forge", known)).toEqual(["demo", "forge"]);
  expect(parseOperatorSkills("/demo /demo /unknown", known)).toEqual(["demo"]);
  expect(parseOperatorSkills("no tokens", known)).toEqual([]);
});

test("formatSkillIndex is empty for no skills, else 'name: description' lines", () => {
  expect(formatSkillIndex([])).toBe("");
  const s = formatSkillIndex([{ name: "demo", description: "d", path: "/x" }]);
  expect(s).toContain("Available skills:");
  expect(s).toContain("- demo: d");
});
