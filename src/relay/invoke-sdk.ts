import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { RelayAgent } from "./config.js";
import type { AgentResult } from "./invoke.js";
import { substituteCmd } from "./invoke.js";
import { query, type PermissionResult, type HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { loadWall, allowRules, DENY_RULES } from "./wall.js";
import { registerEnvSecrets } from "../forge/redact.js";
import { chooseAccount, allExhaustedResult, settleAccountResult } from "./accounts.js";

const OUTPUT_CAP = 100_000;
const DEFAULT_TIMEOUT_MS = 30 * 60_000;
const READ_ONLY = new Set(["Read", "Grep", "Glob"]);
const WRITE_TOOLS = new Set(["Edit", "Write"]);
const BASH_TIMEOUT_MS = "1200000";
const NO_BACKGROUND_TOOLS = ["SlashCommand", "Skill", "Task", "Agent", "BashOutput", "TaskOutput", "KillShell"];

// Realpath the nearest existing ancestor, then rejoin the missing tail, so a
// not-yet-created Write target and any symlinked ancestor both resolve
// truthfully before the sandbox prefix check.
function realBoundary(p: string): string {
  let cur = path.resolve(p);
  const tail: string[] = [];
  while (!existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    tail.unshift(path.basename(cur));
    cur = parent;
  }
  const real = realpathSync(cur);
  return tail.length ? path.join(real, ...tail) : real;
}

// EXPORTED for unit tests. The load-bearing sandbox-write guard.
export function checkToolPermission(
  toolName: string, input: Record<string, unknown>, sandbox: string,
  onData?: (chunk: string) => void,
  walled = false,
): PermissionResult {
  if (READ_ONLY.has(toolName)) return { behavior: "allow", updatedInput: input };
  // Bash runs with cwd = sandbox. We do NOT parse shell strings for paths; a
  // `cd /elsewhere && ...` is out of scope for Phase 1 (documented limitation).
  if (toolName === "Bash") {
    if (!walled) return { behavior: "allow", updatedInput: input };
    onData?.(`\n[forge: permission-denied Bash ${String(input.command ?? "").slice(0, 120)}]\n`);
    return { behavior: "deny", message: "command not in forge.allowedCommands" };
  }
  if (WRITE_TOOLS.has(toolName)) {
    const raw = typeof input.file_path === "string" ? input.file_path : "";
    const target = realBoundary(path.resolve(sandbox, raw));
    const realSandbox = realpathSync(sandbox);
    // Trailing separator so /sandbox-evil never satisfies a /sandbox prefix.
    const inside = target === realSandbox || target.startsWith(realSandbox + path.sep);
    if (inside) return { behavior: "allow", updatedInput: input };
    onData?.(`\n[forge: permission-denied ${toolName} ${raw}]\n`);
    return { behavior: "deny", message: `write outside the sandbox denied: ${raw}` };
  }
  onData?.(`\n[forge: permission-denied ${toolName} ${JSON.stringify(input).slice(0, 120)}]\n`);
  return { behavior: "deny", message: `tool ${toolName} is not permitted in the forge sandbox` };
}

// ponytail: env token OR the CLI login file. macOS Keychain-only logins aren't
// file-checkable here and fall through to the SDK auth error at run time.
export function hasCredentials(configDir = path.join(homedir(), ".claude")): boolean {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return true;
  return existsSync(path.join(configDir, ".credentials.json"));
}

// Merge order matches invoke.ts: process.env < agent.env ({workdir} substituted) < account env.
export function sdkEnv(agent: RelayAgent, workdir: string, acctEnv: Record<string, string>): Record<string, string> {
  let laneEnv: Record<string, string> = {};
  if (agent.env) {
    const keys = Object.keys(agent.env);
    const vals = substituteCmd(Object.values(agent.env), { workdir });
    laneEnv = Object.fromEntries(keys.map((k, i) => [k, vals[i]]));
    registerEnvSecrets(laneEnv);
  }
  const env = Object.fromEntries(Object.entries({ ...process.env, ...laneEnv, ...acctEnv })
    .filter((e): e is [string, string] => e[1] !== undefined));
  env.BASH_DEFAULT_TIMEOUT_MS ??= BASH_TIMEOUT_MS;
  env.BASH_MAX_TIMEOUT_MS ??= BASH_TIMEOUT_MS;
  return env;
}

// allowedTools approves before canUseTool, so background runs are blocked by a hook.
const denyBackground: HookCallback = async (input) => {
  const i = input as { tool_name?: string; tool_input?: { run_in_background?: unknown } };
  if ((i.tool_name === "Bash" || i.tool_name === "PowerShell") && i.tool_input?.run_in_background === true) {
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "background commands are not supported here; run it in the foreground" } };
  }
  return {};
};

export function buildSdkOptions(
  env: Record<string, string>, workdir: string, wallOn: boolean, allowed: string[],
  onData?: (chunk: string) => void, model?: string,
) {
  return {
    cwd: workdir,
    ...(model ? { model } : {}),
    env,
    ...(wallOn ? { settingSources: [], allowedTools: allowRules(allowed) } : {}),
    disallowedTools: [...DENY_RULES, ...NO_BACKGROUND_TOOLS],
    hooks: { PreToolUse: [{ matcher: "Bash|PowerShell", hooks: [denyBackground] }] },
    canUseTool: async (toolName: string, toolInput: Record<string, unknown>) =>
      checkToolPermission(toolName, toolInput, workdir, onData, wallOn),
  };
}

export async function runAgentSdk(
  agent: RelayAgent, prompt: string, workdir: string,
  onData?: (chunk: string) => void,
  onAbort?: (abort: () => void) => void,
  model?: string,
): Promise<AgentResult> {
  const acct = await chooseAccount(agent);
  if (acct.allExhaustedUntil) return allExhaustedResult(acct.allExhaustedUntil, onData);
  const env = sdkEnv(agent, workdir, acct.env);
  if (!env.CLAUDE_CODE_OAUTH_TOKEN && !hasCredentials(env.CLAUDE_CONFIG_DIR)) {
    const msg = "\n[forge: SDK lane has no Claude credentials on this machine. Run `claude setup-token` (or `claude login`) and retry.]\n";
    onData?.(msg);
    return { ok: false, output: msg };
  }

  const wall = await loadWall(agent.projectId);
  const controller = new AbortController();
  onAbort?.(() => controller.abort());
  const timer = setTimeout(() => controller.abort(), agent.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let output = "";
  const append = (s: string) => { if (output.length < OUTPUT_CAP) output += s; onData?.(s); };
  let usage: { tokens: number; cost: number } | undefined;
  let ok = false;
  let cliVersion = "unknown";
  try {
    const response = query({
      prompt,
      options: { ...buildSdkOptions(env, workdir, wall.on, wall.allowed, onData, model), abortController: controller },
    });
    for await (const message of response) {
      if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "text") append(block.text);
        }
      } else if (message.type === "system" && message.subtype === "init") {
        cliVersion = message.claude_code_version;
      } else if (message.type === "result") {
        ok = message.subtype === "success" && !message.is_error;
        const u = message.usage;
        const tokens = (u?.input_tokens ?? 0) + (u?.output_tokens ?? 0)
          + (u?.cache_creation_input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0);
        usage = { tokens, cost: Math.round((message.total_cost_usd ?? 0) * 1e6) };
        if (message.subtype !== "success") {
          const errs = message.errors.length ? message.errors.join("; ") : "(none reported)";
          const denied = message.permission_denials.length
            ? message.permission_denials.map((d) => d.tool_name).join(",") : "(none)";
          append(`\n[forge: sdk result ${message.subtype} is_error=${message.is_error} cli=${cliVersion}]\n`);
          append(`[forge: sdk errors: ${errs}]\n`);
          append(`[forge: sdk permission_denials: ${denied}]\n`);
        }
      }
    }
  } catch (e) {
    append(`\n[forge: sdk error: ${(e as Error).message} cli=${cliVersion}]\n`);
    ok = false;
  } finally {
    clearTimeout(timer);
  }
  return settleAccountResult(agent, { ok, output: output.slice(0, OUTPUT_CAP), usage }, acct.account);
}
