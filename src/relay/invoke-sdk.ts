import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { RelayAgent } from "./config.js";
import type { AgentResult } from "./invoke.js";
import { query, type PermissionResult } from "@anthropic-ai/claude-agent-sdk";

const OUTPUT_CAP = 100_000;
const DEFAULT_TIMEOUT_MS = 30 * 60_000;
const READ_ONLY = new Set(["Read", "Grep", "Glob"]);
const WRITE_TOOLS = new Set(["Edit", "Write"]);

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
): PermissionResult {
  if (READ_ONLY.has(toolName)) return { behavior: "allow", updatedInput: input };
  // Bash runs with cwd = sandbox. We do NOT parse shell strings for paths; a
  // `cd /elsewhere && ...` is out of scope for Phase 1 (documented limitation).
  if (toolName === "Bash") return { behavior: "allow", updatedInput: input };
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
function hasCredentials(): boolean {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return true;
  return existsSync(path.join(homedir(), ".claude", ".credentials.json"));
}

export async function runAgentSdk(
  agent: RelayAgent, prompt: string, workdir: string,
  onData?: (chunk: string) => void,
  onAbort?: (abort: () => void) => void,
): Promise<AgentResult> {
  if (!hasCredentials()) {
    const msg = "\n[forge: SDK lane has no Claude credentials on this machine. Run `claude setup-token` (or `claude login`) and retry.]\n";
    onData?.(msg);
    return { ok: false, output: msg };
  }

  const controller = new AbortController();
  onAbort?.(() => controller.abort());
  const timer = setTimeout(() => controller.abort(), agent.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let output = "";
  const append = (s: string) => { if (output.length < OUTPUT_CAP) output += s; onData?.(s); };
  let usage: { tokens: number; cost: number } | undefined;
  let ok = false;
  try {
    const response = query({
      prompt,
      options: {
        cwd: workdir,
        abortController: controller,
        canUseTool: async (toolName, toolInput) =>
          checkToolPermission(toolName, toolInput as Record<string, unknown>, workdir, onData),
      },
    });
    for await (const message of response) {
      if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "text") append(block.text);
        }
      } else if (message.type === "result") {
        ok = message.subtype === "success" && !message.is_error;
        const u = message.usage;
        const tokens = (u?.input_tokens ?? 0) + (u?.output_tokens ?? 0);
        usage = { tokens, cost: Math.round((message.total_cost_usd ?? 0) * 1e6) };
        if (message.subtype !== "success") append(`\n[forge: sdk result ${message.subtype}]\n`);
      }
    }
  } catch (e) {
    append(`\n[forge: sdk error: ${(e as Error).message}]\n`);
    ok = false;
  } finally {
    clearTimeout(timer);
  }
  return { ok, output: output.slice(0, OUTPUT_CAP), usage };
}
