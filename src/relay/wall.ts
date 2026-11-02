import { binBasename } from "./doctor.js";
import { agyPatterns, denyPatterns } from "./risk.js";

export const DEFAULT_ALLOWED_COMMANDS = ["npm test", "npm run", "npx vitest", "npx tsc", "git status", "git diff", "git log", "git show", "git rm"];

// forge.allowedCommands (JSON string array) wins; unset or malformed falls back.
export function resolveAllowedCommands(setting: string | null, fallback = DEFAULT_ALLOWED_COMMANDS): string[] {
  if (setting === null) return fallback;
  try {
    const parsed: unknown = JSON.parse(setting);
    if (Array.isArray(parsed) && parsed.every((c) => typeof c === "string")) return parsed;
  } catch { /* fall through */ }
  return fallback;
}

// Claude runs shell commands through Bash or PowerShell depending on the platform.
export function allowRules(allowed: string[]): string[] {
  return allowed.flatMap((c) => ["Bash", "PowerShell"].flatMap((t) => [`${t}(${c})`, `${t}(${c} *)`]));
}

// git's --output writes a file anywhere; deny beats allow.
export const DENY_RULES = ["Bash(git *--output*)", "PowerShell(git *--output*)"];

// Per-program write wall added at launch, whatever relay.json says. claude: the
// prompt moves to stdin (a prompt file outside the folder would be refused) and
// --restricted confines its file tools to the working folder, edit rights only
// when write is true (the work stage); only allow-listed
// commands run; claude also gets the deny list when the wall is off (denyOnlyCmd); plan/work/review agents can also read the attachments folder (operator evidence, chat attachments). codex: its own OS sandbox. Other programs are not walled here.
export function wallCmd(cmd: string[], allowed: string[], write = false, addDirs: string[] = [], lifted: readonly string[] = []): string[] {
  const bin = binBasename(cmd[0]).toLowerCase();
  if (bin === "claude") {
    if (cmd.includes("--restricted")) return cmd;
    const kept = cmd.filter((p) => p !== "{prompt}" && p !== "{promptFile}");
    const print = kept.includes("-p") || kept.includes("--print") ? [] : ["-p"];
    return [...kept, ...print, "--restricted",
      ...(write ? ["--permission-mode", "acceptEdits"] : []),
      "--permission-prompts", "none",
      "--tools", "Read,Edit,Write,Glob,Grep,Bash,PowerShell",
      "--settings", JSON.stringify({ permissions: { allow: [...allowRules(allowed), "mcp__vibeops"], deny: [...DENY_RULES, ...denyPatterns(lifted)] } }),
      ...addDirs.flatMap((d) => ["--add-dir", d])];
  }
  if (bin === "codex") {
    const i = cmd.indexOf("exec");
    if (i === -1 || cmd.some((p) => p === "-s" || p.startsWith("--sandbox") || p === "--dangerously-bypass-approvals-and-sandbox")) return cmd;
    return [...cmd.slice(0, i + 1), "--sandbox", "workspace-write", ...cmd.slice(i + 1)];
  }
  return cmd;
}

export function denyOnlyCmd(cmd: string[], lifted: readonly string[] = []): string[] {
  if (binBasename(cmd[0]).toLowerCase() !== "claude" || cmd.includes("--settings")) return cmd;
  return [...cmd, "--settings", JSON.stringify({ permissions: { deny: [...DENY_RULES, ...denyPatterns(lifted)] } })];
}

export function agyDenyCmd(cmd: string[], lifted: readonly string[] = []): string[] {
  if (binBasename(cmd[0]).toLowerCase() !== "agy" || cmd.includes("--settings")) return cmd;
  return [...cmd, "--settings", JSON.stringify({ permissions: { deny: agyPatterns(lifted) } })];
}

const SHELL_CONTROL = /&&|\|\||;|\||>|<|`|\$\(/;
const warnedChecks = new Set<string>();

// forge.allowedCommands.<projectId> wins over forge.allowedCommands, then the default.
// Work lanes (write) may also run the project's single-command checks.
export async function loadWall(projectId?: string, write = false, workdir = ""): Promise<{ on: boolean; allowed: string[] }> {
  try {
    const { getSetting } = await import("../services/settings.js");
    const global = resolveAllowedCommands(await getSetting("forge.allowedCommands"));
    const allowed = projectId ? resolveAllowedCommands(await getSetting(`forge.allowedCommands.${projectId}`), global) : global;
    const on = (await getSetting("forge.agentWall")) !== "false";
    if (!write) return { on, allowed };
    const { resolveChecks } = await import("../forge/checks.js");
    const checks = resolveChecks(projectId ? await getSetting(`forge.checks.${projectId}`) : null, workdir, await getSetting("forge.checks"));
    const simple = checks.filter((c) => {
      if (!SHELL_CONTROL.test(c)) return true;
      if (!warnedChecks.has(c)) { warnedChecks.add(c); console.warn(`forge: wall skips compound check (use a single command): ${c}`); }
      return false;
    });
    return { on, allowed: [...new Set([...allowed, ...simple])] };
  } catch {
    return { on: true, allowed: DEFAULT_ALLOWED_COMMANDS };
  }
}
