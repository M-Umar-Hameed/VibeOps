import { commandRisk } from "./risk.js";
import type { Dialect } from "./firewall.js";

const DIALECT: Dialect = process.platform === "win32" ? "powershell" : "posix";
const out = (d: { decision: "allow" | "deny"; reason?: string }) => process.stdout.write(JSON.stringify(d) + "\n");

try {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { toolCall?: { name?: unknown; args?: { CommandLine?: unknown } }; cwd?: unknown; workspacePaths?: unknown };
  if (input.toolCall?.name !== "run_command") {
    out({ decision: "allow" });
  } else {
    const cmd = input.toolCall.args?.CommandLine;
    if (typeof cmd !== "string") throw new Error("toolCall.args.CommandLine is not a string");
    const wp = Array.isArray(input.workspacePaths) && typeof input.workspacePaths[0] === "string" ? input.workspacePaths[0] : "";
    const workspace = wp || (typeof input.cwd === "string" ? input.cwd : "");
    if (!workspace) throw new Error("no workspace: workspacePaths and cwd are unset");
    const lifted = (process.env.VIBEOPS_ALLOW_COMMAND ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const hit = commandRisk(cmd, workspace, lifted, DIALECT);
    out(hit ? { decision: "deny", reason: `blocked by the forge firewall (${hit.id}): ${hit.reason}` } : { decision: "allow" });
  }
} catch (e) {
  out({ decision: "deny", reason: `forge firewall hook error: ${e instanceof Error ? e.message : String(e)}` });
}
