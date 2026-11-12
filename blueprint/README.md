# blueprint

Standalone guards for running coding agents: a command firewall, an output budget, and a verify loop with git rollback. Node 24 built-ins only; Node runs the `.ts` files directly. Not wired into the VibeOps server. Design and measured results: `docs/evals/2026-11-09-supervision-vs-bare-agents.md` (Part 4).

| file | what it does |
|---|---|
| `firewall.ts` | `checkCommand(cmd, { workspace, dialect })` decides deny or allow for one shell command line. It parses the line (quotes, heredocs, `$(...)`, `sh -c`, `eval`, `find -exec`, npm scripts) instead of matching regexes. |
| `claude-hook.ts` | Claude Code `PreToolUse` adapter for the Bash and PowerShell tools. Fails closed (exit 2) on internal errors. |
| `output-budget.ts` | `createClip()` streams output into a bounded summary: head + tail + error-like lines from the middle. |
| `run.ts` | `runCommand` / `runGuarded`: spawn with the firewall, the clip and a process-tree kill on timeout. |
| `verify-loop.ts` | `verifyLoop()` runs agent step, then tests. After 3 consecutive failures it stops, stashes and rolls back to the starting commit, and raises an alert. |

Run the tests and the typecheck from the repo root:

```
node --test "blueprint/*.test.ts"
npx tsc -p blueprint/tsconfig.json
```

Wire the firewall into Claude Code (`.claude/settings.json`):

```json
{ "hooks": { "PreToolUse": [ { "matcher": "Bash|PowerShell",
  "hooks": [ { "type": "command", "command": "node G:/Github/tickets/blueprint/claude-hook.ts || exit 2", "timeout": 10 } ] } ] } }
```

`|| exit 2` makes Claude Code block the call if Node itself cannot start the hook. Claude Code treats any exit code other than 2 as "let the command run".

`GUARD_WORKSPACE` overrides the workspace (default: `CLAUDE_PROJECT_DIR`, then the hook's `cwd`). `GUARD_ALLOW_HOSTS` is a comma-separated egress allowlist. `VERIFY_ALERT_WEBHOOK` makes `defaultAlert` also POST the halt alert as JSON.
