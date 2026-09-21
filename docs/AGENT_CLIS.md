# Agent CLIs Configuration

The `~/.vibeops/relay.json` file configures how VibeOps communicates with local agent CLIs.

## Schema
```typescript
type RelayAgent = {
  cmd: string[];
  roles: string[];
  timeoutMs?: number;
  models?: RelayModel[];
  env?: Record<string, string>;
  type?: "cli" | "sdk";
  mcp?: boolean; // written by auto-wiring as a record that the lane is registered; set false to opt out
};

type RelayModel = {
  name: string;
  tier: "free" | "cheap" | "expensive";
  quality: number; // 1-5
};
```

### Placeholders and Variables
When substituting values into the `cmd` array, VibeOps provides four placeholders:
- `{model}`: The selected model name
- `{workdir}`: The absolute path to the project directory
- `{prompt}`: The raw prompt text (passed directly in the command line)
- `{promptFile}`: A temporary file (0600 permissions) containing the prompt. Used when prompt is too large or contains complex characters.

**Environment Variables (`env`):**
If you define `env` key-value pairs, these are merged *over* the process environment (agent variables win). The `{workdir}` placeholder is substituted inside `env` values. However, `{prompt}` and `{promptFile}` are intentionally excluded from environment variable substitution to prevent secrets or complex text from leaking into the shell environment.

For routing details on how roles are assigned and executed, see [docs/ROUTING.md](ROUTING.md) and [README.md#cross-model-pipeline-relay](../README.md#cross-model-pipeline-relay).

---

## claude

Install: `npm install -g @anthropic-ai/claude-code`

Login Flow: Run `claude login` once in a terminal on this machine. Signs in with your claude.ai account/subscription.

MCP Wiring: Run once to reach VibeOps tools:
`claude mcp add --transport http vibeops http://127.0.0.1:8787/mcp --header "Authorization: Bearer <key>"`
VibeOps does this for you: `ensureMcpWiring` (src/mcp/autowire.ts) registers the server at startup and records it as `"mcp": true` in `relay.json`. The command above is the manual fallback. Set `"mcp": false` to opt a lane out -- auto-wiring skips it and chat never nags about it.

```json
"claude": {
  "cmd": ["claude", "-p", "{promptFile}"],
  "roles": ["plan", "review"],
  "mcp": true
}
```

---

## agy

Install: Follow Antigravity installation docs.

Login Flow: Sign in through the Antigravity CLI/app's own sign-in flow (no single flag — see Antigravity's docs). VibeOps only invokes agy once it's authenticated.

MCP Wiring: Run once to reach VibeOps tools:
`agy mcp add --header "Authorization: Bearer <key>" vibeops http://127.0.0.1:8787/mcp`
VibeOps does this for you: `ensureMcpWiring` (src/mcp/autowire.ts) registers the server at startup and records it as `"mcp": true` in `relay.json`. The command above is the manual fallback. Set `"mcp": false` to opt a lane out -- auto-wiring skips it and chat never nags about it.

```json
"agy": {
  "cmd": ["agy", "--headless", "--prompt-file", "{promptFile}"],
  "roles": ["work"]
}
```

---

## codex

Install: `npm install -g @openai/codex`

Login Flow: Run `codex login` once in a terminal on this machine. Signs in with your ChatGPT/OpenAI account.

MCP Support: No streamable-HTTP MCP support verified (deferred in VibeOps one-click architecture). The lane remains tool-incapable (`mcp: false` / omitted).

```json
"codex": {
  "cmd": ["codex", "exec", "--oss", "--sandbox", "workspace-write", "-C", "{workdir}", "{prompt}"],
  "roles": ["work"]
}
```

---

## kimi

Install: `pip install kimi-cli` (or `uv tool install kimi-cli`). Run `kimi` once; the setup wizard stores your Moonshot key in the local keyring.

Login Flow: Authenticate this CLI in your terminal the way its provider expects. VibeOps only invokes the binary — it never sees or stores the credentials.

MCP Wiring: Run once to reach VibeOps tools:
`kimi mcp add --transport http vibeops http://127.0.0.1:8787/mcp --header "Authorization: Bearer <key>"`
VibeOps does this for you: `ensureMcpWiring` (src/mcp/autowire.ts) registers the server at startup and records it as `"mcp": true` in `relay.json`. The command above is the manual fallback. Set `"mcp": false` to opt a lane out -- auto-wiring skips it and chat never nags about it.

```json
"kimi": {
  "cmd": ["kimi", "-p", "{promptFile}"],
  "roles": ["work"],
  "mcp": true,
  "models": [
    {
      "name": "moonshot-ai/kimi-k2.7-code",
      "tier": "cheap",
      "quality": 4
    }
  ],
  "env": {
    "ANTHROPIC_BASE_URL": "https://api.moonshot.ai/anthropic"
  }
}
```
*Note: The model tier and quality shown are examples. Print mode (`-p`) auto-approves tools inside the sandbox worktree, which is a behavior of the Kimi CLI.*

---

## SDK lane (experimental)

Set `"type": "sdk"` on a work agent to run it first-party and in-loop via
`@anthropic-ai/claude-agent-sdk` instead of spawning a CLI. The relay (CLI) lane
stays the default; omit `type` or set `"cli"` to keep it.

An sdk agent needs no `cmd`. It uses your existing Claude Code credentials —
either `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`, or a `claude login`
on this machine. VibeOps stores no API key. If neither is present the run fails
with a message naming `claude setup-token`.

Phase 1 supports the **work** stage only; plan and review still run on the relay
lane. Writes are permitted only inside the run's sandbox worktree; reads are
unrestricted; other tools are denied and logged as
`[forge: permission-denied <tool> <path>]` in the live console.

```json
"sonnet-sdk": {
  "type": "sdk",
  "roles": ["work"]
}
```

To fall back, change `"type"` to `"cli"` (with a `cmd`) or remove the agent.

First-run setup writes this lane for you as `claude-sdk` whenever a Claude Code
login is present on the machine, so a fresh install has a work lane even when no
agent CLI is on `PATH`.

---

## Sandbox containment

VibeOps runs the **work** stage inside a per-ticket git worktree sandbox. What
actually confines a work agent's *writes* depends entirely on the lane:

| Lane | Write confinement | Enforced by |
| --- | --- | --- |
| `claude` (CLI) | **Walled at launch.** VibeOps adds `--restricted` (file tools confined to the working folder), `--permission-mode acceptEdits` for the work stage only (other roles get no edit rights), `--permission-prompts none`, and allow rules from `forge.allowedCommands`; the prompt goes on stdin. Any other shell command is denied. | Claude Code `--restricted` (application-level, not an OS boundary) |
| `agy` (`--dangerously-skip-permissions`) | **Not confined by VibeOps.** Runs with `--dangerously-skip-permissions`; `--sandbox` is not added because its effect on Windows is unverified. | None |
| `codex` (`--sandbox workspace-write`) | Confined to the workspace/cwd. VibeOps adds `--sandbox workspace-write` at launch when the cmd has none. | codex's own OS-level workspace-write sandbox |
| `kimi` (`-p` print mode) | **Not confined beyond cwd.** Print mode auto-approves tools inside the worktree; it is not an OS write-jail. | Kimi CLI behaviour (not an OS boundary) |
| `sdk` lane | `Write`/`Edit` are confined to the sandbox by `checkToolPermission`; `allowedTools` from `forge.allowedCommands`; any other `Bash` call is denied. | Tool-permission gate (application-level, not an OS boundary) |

The wall is on by default; set `forge.agentWall` to `false` to turn it off. `forge.allowedCommands` (JSON string array) overrides the default allow-list: `npm test`, `npm run`, `npx vitest`, `npx tsc`, `git status`, `git diff`, `git log`, `git show`.

Limits: the allow-list runs project code (`npm test`, `npm run`, `npx` scripts), so an agent that edits a script and then runs it can still write outside the folder. The wall stops accidental writes, not determined ones; the sentinel below stays the backstop. `git ... --output` is denied. Only the value `false` disables the wall. For non-JavaScript repos set `forge.allowedCommands` through `PATCH /settings/forge.allowedCommands`. Under the wall claude has only `Read`, `Edit`, `Write`, `Glob`, `Grep`, `Bash` and `PowerShell` (no web fetch or search, subagents or skills).

### The Bash gap and the sentinel (interim control)

A work agent's shell (in the `agy` and `kimi` lanes, or any lane with the wall off) can copy, move, or
delete files **outside** the sandbox. This escapes every diff-based control: a
write outside the worktree produces no git diff, so the protected-path policy
never sees it. It reached the installed application
(`%LOCALAPPDATA%\VibeOps\resources\server\server.mjs`) in a live incident.

Until a full OS boundary lands, the work stage runs a **sandbox-escape
sentinel**: before the work agent runs, VibeOps snapshots the bytes+hash of a
configurable set of known-sensitive files (`forge.sensitivePaths`, default: the
installed server payload). After the work agent finishes, any changed file is
**restored to its pre-run bytes**, the tamper is printed to the run output as
`[forge: SANDBOX-ESCAPE ...]`, and the run is **failed**.

This is detection-and-revert for an **enumerated** set — not a general write
jail. It does NOT cover: paths not in `forge.sensitivePaths`, a delete of a file
with no snapshot, or the live `~/.vibeops` database (which the server itself
writes during a run and so cannot be snapshot-guarded this way).

### Escalation: the general boundary is not yet shipped

A general, enforced "writes only inside the sandbox" boundary for `Bash` was
evaluated and is a feature-sized project on Windows, not a bounded change:

- **Shell-string parsing is rejected** — quoting, environment expansion, and
  chained commands make it unsound; a regex that looks like a control is worse
  than none.
- **Job objects** do not govern the filesystem.
- **SAFER "Basic User"** stays at Medium integrity — the user's own profile
  remains writable, so it does not contain this attack.
- **MIC Low-integrity / SAFER "Untrusted" child** would block write-up to
  Medium-integrity targets, but launching such a child needs native token
  manipulation and would likely break `node`/`npm install`/`vitest`.
- **Recommended target:** run the sdk work stage as a dedicated restricted local
  user with write access only to the sandbox root, launched out-of-process. This
  is genuinely OS-enforced but requires one-time admin setup and credential
  storage (DPAPI / Windows Credential Manager), plus re-architecting
  `runAgentSdk` into a separate runner process. Tracked as follow-up.
- **Optional Windows hardening** meanwhile: an `icacls /deny` write ACE on the
  enumerated `forge.sensitivePaths` for the work-stage duration (prevents rather
  than reverts, same enumerated scope as the sentinel).

## Concurrency

- **Cap setting:** `forge.maxActiveRuns` (default 3) limits simultaneous pipeline runs. Invalid or empty values fall back to the default.
- **Council context setting:** `council.contextTokenBudget` caps the repository briefing injected into council persona prompts. Empty/`unlimited` (default) = no token cap, structural caps only; `0` = no briefing, no repo scan; `N` = briefing truncated to ~N estimated tokens, lowest-priority sections dropped first.
- **Node_modules leak guard:** the work stage snapshots top-level `node_modules` entries before running; additions through the shared junction are reverted and fail the run. In-place nested edits are not caught (ceiling documented in code).
- **Promote conflict:** `promoteSandbox` aborts on merge conflict, names the conflicting files in the error, and leaves the sandbox and branch intact for rework.
