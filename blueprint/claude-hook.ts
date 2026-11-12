try {
  const { checkCommand } = await import("./firewall.ts");
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const dialect = input.tool_name === "Bash" ? "posix" : input.tool_name === "PowerShell" ? "powershell" : null;
  if (dialect) {
    const cwd: string = input.cwd ?? process.cwd();
    const v = checkCommand(String(input.tool_input?.command ?? ""), {
      workspace: process.env.GUARD_WORKSPACE ?? process.env.CLAUDE_PROJECT_DIR ?? cwd,
      cwd,
      dialect,
      allowHosts: (process.env.GUARD_ALLOW_HOSTS ?? "").split(",").filter(Boolean),
    });
    if (!v.allow) {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: `blocked by firewall [${v.rule}]: ${v.reason} (${v.segment})`,
          },
        }) + "\n",
      );
    }
  }
} catch (e) {
  process.stderr.write(`firewall hook error: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(2);
}
