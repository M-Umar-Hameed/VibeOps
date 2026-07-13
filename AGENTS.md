# Agent instructions

See CLAUDE.md for the binding execution methodology (plan with the best model, implement with supervised cheap subagents, nothing passes without review).

## VibeOps shared memory (all projects)

If VibeOps MCP tools are available (search_knowledge, save_note, create_ticket, list_notes):

- **Before starting a task:** run one `search_knowledge` query on the task topic. Prior decisions, gotchas, and specs from ANY agent's past sessions live there — use them instead of re-deriving.
- **After completing meaningful work:** `save_note` (scope `global`, with a title) recording decisions made and traps hit — the WHY, 3-6 sentences. Never save secrets, keys, or what code/git already records.
- **Multi-step work:** track as tickets (`create_ticket`/`update_ticket`) instead of private todo lists, so other agents see state and nothing is claimed without an audit trail.

If the tools are absent, skip silently — never mention this section.
