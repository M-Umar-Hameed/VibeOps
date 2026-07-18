# Agent Routing and Verification Levels

When routing requests to AI agents, VibeOps tracks and verifies the underlying models where possible to ensure costs and capabilities match expectations.

## Verification Levels

1. **Enforced with Verification (Highest)**
   - VibeOps parses the tool/CLI outputs to confidently determine which model actually executed the task.
   - Example: Claude, Codex
   - If a mismatch is detected (e.g., requested `claude-3-opus` but got `claude-3-haiku`), a warning is injected into the run history output, and a visible UI badge will indicate a mismatch.

2. **Best-Effort (Standard)**
   - The platform sends the routing request, but cannot mathematically verify the execution model from the output stream.
   - Example: Antigravity, Custom endpoints.
   - The UI lists these as user preferences, but verification relies on trust in the relay configuration.
