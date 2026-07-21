# VibeOps User Guide

## What is VibeOps
VibeOps is a self-hosted operations console that orchestrates your autonomous coding agents through a supervised work-order queue. It provides a shared memory and an append-only audit trail so multiple agents can collaborate on the same tasks without starting cold. Humans and agents work together in a continuous loop of planning, sandboxed execution, adversarial review, and final human promotion.

## Install
Grab the Windows installer (or build from source per [README.md#install-one-file](../README.md#install-one-file)). On your first boot, VibeOps self-creates everything it needs: an embedded PGlite database, your vault, the **Inbox** project, and your owner credentials at `~/.vibeops/credentials.json`. The application spawns a local server on `127.0.0.1:8787`. If you ever uninstall the app, the `~/.vibeops` directory is intentionally left untouched so your data remains safe.

## Connect your agents
VibeOps never asks for your AI provider API keys. You install and sign in to each agent CLI yourself, once, on your machine, through the vendor's own login. VibeOps only invokes those binaries and verifies they work via Run checks. Your usage and billing stay on your existing subscriptions. VibeOps never sees or stores these credentials.

| Agent | Install Command | Login Flow |
| --- | --- | --- |
| claude | `npm install -g @anthropic-ai/claude-code` (or winget `Anthropic.ClaudeCode`) | run `claude` once and follow the sign-in prompt |
| agy | Antigravity CLI installer from the vendor (not on npm) | run `agy` once and follow the sign-in prompt |
| codex | `npm install -g @openai/codex` | `codex login` |
| kimi | `pip install kimi-cli` (or `uv tool install kimi-cli`) | run `kimi` once; the setup wizard stores your Moonshot key locally |

Once logged in, go to **Settings > AI Models > AI Accounts** and click **Run checks** to verify the connection. See [docs/AGENT_CLIS.md](AGENT_CLIS.md) for detailed relay wiring instructions.

## Your first work order
To create your first work order in Forge, type your task description. You can attach context by pasting an image directly or clicking **Attach image**. Click **Create task** to put it in the queue. 

The pipeline orchestrates the task through plan, work, and review stages. Once the agent finishes, review the proposed diff. If the changes look correct, click **Promote** to merge them. Note that Promote unlocks after a passing review; if you click Request changes, the run bounces back and your feedback is injected into the next attempt. For a full walkthrough, see [docs/QUICKSTART.md](QUICKSTART.md).

## Projects & workspaces
VibeOps organizes work into projects. Use **Add project** to create a new one, or **Import from folder...** to batch-import existing directories. A local git repository badge appears in the Sidebar for projects bound to a repository. You can also click **Initialize git** to create a new repository for an empty project.

## Connect GitHub issues
In the **Integrations** tab, you can bind a project to a GitHub repository by providing a token and setting the Repository to the `owner/repo` format. Click **Sync now** to pull issues into your VibeOps queue. This integration is two-way: closing a ticket in VibeOps will mirror the closure in GitHub on the second sync.

## Knowledge & vault
VibeOps provides a persistent knowledge base for your agents. Just drop markdown or PDF files into `~/.vibeops/vault` and they are automatically indexed. The system falls back to a local, zero-key embedder if this is empty, meaning knowledge search works immediately without any API keys.

## Troubleshooting
- **Too Many Requests (429):** The VibeOps window is holding a stale VibeOps API key (stored in the app's own settings store), not a provider key. Restart the app; if it persists, copy the key from `~/.vibeops/credentials.json` into Settings > Local Node.
- **Red dot in Agent Doctor:** The CLI is either not installed or not authenticated. Run the vendor login command again.
- **Empty diff on forge run:** This is often caused by missing agent permission flags (e.g., missing `--sandbox` or dangerously flags).
- **Where logs live:** Agent token usage is observed by VibeOps from local session logs, across ALL projects, and surfaced in the UI under Settings > AI Models > Token Usage.
