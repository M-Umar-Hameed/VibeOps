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

```json
"claude": {
  "cmd": ["claude", "-p", "{promptFile}"],
  "roles": ["plan", "review"]
}
```

---

## agy

Install: Follow Antigravity installation docs.

Login Flow: Sign in through the Antigravity CLI/app's own sign-in flow (no single flag — see Antigravity's docs). VibeOps only invokes agy once it's authenticated.

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

```json
"kimi": {
  "cmd": ["kimi", "-p", "{promptFile}"],
  "roles": ["work"],
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

## First-Party SDK Lane
Forge supports running `@anthropic-ai/claude-agent-sdk` directly in-loop as an alternative to external CLIs for the **work** stage.
This skips stdio overhead and provides exact token accounting, though it runs under the Relay's process identity.

To use it, set the agent type to `"sdk"`. The `cmd` array is omitted.
```json
{
  "workdir": "/path/to/repo",
  "agents": {
    "claude": {
      "type": "sdk",
      "roles": ["work"]
    }
  }
}
```
*Note: SDK agents are only supported for the `work` stage in this release.*
