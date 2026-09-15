import { binBasename } from "./doctor.js";

export const DEFAULT_ALLOWED_COMMANDS = ["npm test", "npm run", "npx vitest", "npx tsc", "git status", "git diff", "git log", "git show"];

// forge.allowedCommands (JSON string array) wins; unset or malformed falls back to the default.
export function resolveAllowedCommands(setting: string | null): string[] {
  if (setting === null) return DEFAULT_ALLOWED_COMMANDS;
  try {
    const parsed: unknown = JSON.parse(setting);
    if (Array.isArray(parsed) && parsed.every((c) => typeof c === "string")) return parsed;
  } catch { /* fall through */ }
  return DEFAULT_ALLOWED_COMMANDS;
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
// commands run. codex: its own OS sandbox. Other programs are not walled here.
export function wallCmd(cmd: string[], allowed: string[], write = false): string[] {
  const bin = binBasename(cmd[0]).toLowerCase();
  if (bin === "claude") {
    if (cmd.includes("--restricted")) return cmd;
    const kept = cmd.filter((p) => p !== "{prompt}" && p !== "{promptFile}");
    const print = kept.includes("-p") || kept.includes("--print") ? [] : ["-p"];
    return [...kept, ...print, "--restricted",
      ...(write ? ["--permission-mode", "acceptEdits"] : []),
      "--permission-prompts", "none",
      "--tools", "Read,Edit,Write,Glob,Grep,Bash,PowerShell",
      "--settings", JSON.stringify({ permissions: { allow: [...allowRules(allowed), "mcp__vibeops"], deny: DENY_RULES } })];
  }
  if (bin === "codex") {
    const i = cmd.indexOf("exec");
    if (i === -1 || cmd.some((p) => p === "-s" || p.startsWith("--sandbox") || p === "--dangerously-bypass-approvals-and-sandbox")) return cmd;
    return [...cmd.slice(0, i + 1), "--sandbox", "workspace-write", ...cmd.slice(i + 1)];
  }
  return cmd;
}

// Callers without a database (the standalone relay runner) get the defaults.
export async function loadWall(): Promise<{ on: boolean; allowed: string[] }> {
  try {
    const { getSetting } = await import("../services/settings.js");
    return {
      on: (await getSetting("forge.agentWall")) !== "false",
      allowed: resolveAllowedCommands(await getSetting("forge.allowedCommands")),
    };
  } catch {
    return { on: true, allowed: DEFAULT_ALLOWED_COMMANDS };
  }
}
