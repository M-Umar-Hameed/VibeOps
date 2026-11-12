// PreToolUse command hook for claude CLI / agy lanes. Exit 2 = block (reason on stderr); any internal error also exits 2 (fail closed).
import { commandRisk } from "./risk.js";

try {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { tool_name?: unknown; tool_input?: { command?: unknown }; cwd?: unknown };
  const tool = input.tool_name;
  if (tool === "Bash" || tool === "PowerShell") {
    const cmd = input.tool_input?.command;
    if (typeof cmd !== "string") throw new Error("tool_input.command is not a string");
    const workspace = process.env.CLAUDE_PROJECT_DIR || (typeof input.cwd === "string" ? input.cwd : "");
    if (!workspace) throw new Error("no workspace: CLAUDE_PROJECT_DIR and cwd are unset");
    const lifted = (process.env.VIBEOPS_ALLOW_COMMAND ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const hit = commandRisk(cmd, workspace, lifted, tool === "PowerShell" ? "powershell" : "posix");
    if (hit) {
      process.stderr.write(`blocked by the forge firewall (${hit.id}): ${hit.reason}\n`);
      process.exit(2);
    }
  }
} catch (e) {
  process.stderr.write(`forge firewall hook error: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(2);
}
