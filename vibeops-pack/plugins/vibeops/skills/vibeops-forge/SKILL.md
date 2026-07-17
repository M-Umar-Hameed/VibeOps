---
name: vibeops-forge
description: How to behave as a forge pipeline worker or reviewer — sandboxed worktree, narration, commit and path rules, rework findings.
---

# VibeOps Forge

Forge runs a ticket through plan -> work -> review, each stage possibly a different model, with work-stage output confined to a sandboxed git worktree until a human promotes it.

## You are in an isolated worktree

During the work stage you run inside `~/.vibeops/sandbox/<ticketId>`, on branch `forge/<ticketId>` — not the real repo. Worktree isolation confines the diff, not the process, so still behave as if it were the real repo: don't write outside your working directory.

## Relative paths only

All file paths are relative to your current working directory. Never use absolute paths and never write outside your working directory, even if the plan you were given shows absolute paths. A worker that gets write-approval-denied on an absolute path and reports success anyway is a real failure mode this rule exists to prevent.

## Never git commit

Do not run `git commit`. After your work stage succeeds, the supervisor commits everything in the sandbox for you (`git add -A && git commit`). The branch, not any commit you might make, is the durable artifact.

## Narrate your reasoning out loud

Before each step, print what you are about to do and why. Your narration is read live by the supervisor and by the reviewing model — there is no hidden chain-of-thought here, the raw console output is the observability layer.

## Ending your work stage: REPORT:

End your output with a section starting `REPORT:` summarizing what you did. This becomes the ticket's `report` comment.

## Ending a review stage: VERDICT:

Reviewers end their output with exactly one line: `VERDICT: PASS` or `VERDICT: FAIL`, followed by findings if `FAIL`. Rules:

- The **last** line-anchored `VERDICT:` line in your output wins — narrate freely before it ("I would pass this, but...") and the final line still decides.
- Fail-closed: no `VERDICT:` line at all, or anything other than `PASS`, is treated as `FAIL`.
- `PASS` leaves the ticket in `review`, awaiting a human Promote action. `FAIL` bounces the ticket to `planned` and keeps the sandbox for rework.

## Rework passes receive prior findings

If a review failed, the next work stage's prompt includes a "Previous review findings" block quoting the last review comment verbatim. Address every one of those findings — repeating a mistake the reviewer already flagged is the single most common rework failure.

## Plan and review stages run in the real repo

Plan and review stages run read/text-only in the real working directory, not the sandbox. The plan stage must output the plan as text and must not create, modify, or delete any files.
