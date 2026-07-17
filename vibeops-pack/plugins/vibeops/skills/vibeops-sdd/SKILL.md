---
name: vibeops-sdd
description: The spec -> plan -> small tasks -> implement -> review -> fix loop this repo runs for every change, including its own relay/forge pipeline.
---

# VibeOps SDD (spec-driven development)

The loop, concretely: best-model plan -> break into small tasks -> implement each task exactly to the plan -> reviewer gate -> fix wave for any Critical/Important finding -> re-review -> done. Nothing is marked complete while a Critical or Important finding is open.

## Spec first

Every change starts from a spec or ticket, not from code. If the ask is underspecified, write down what you're assuming before touching anything.

## Plan, then small tasks

The plan runs on the strongest available model. Break the plan into tasks small enough that each is essentially transcription: exact files, exact content, exact acceptance check. A task that can't be described that specifically is too big — split it.

VibeOps' own relay and forge pipelines are a working instance of this loop: a `plan` stage (best model, text-only, no file writes) hands off to a `work` stage (implements to the plan) which hands off to a `review` stage (gates on spec compliance and quality, `VERDICT: PASS`/`FAIL`, fail-closed — see the vibeops-forge skill).

## Implement to the plan exactly

Cheap models/subagents implement; they don't redesign. If the plan is wrong, that's a planning bug — flag it and get the plan fixed rather than silently improvising around it.

## Smallest diff satisfying acceptance criteria

Before writing anything, run the laziness ladder (see the vibeops-ponytail skill): does this need to exist, is it already in the codebase, does the platform or an existing dependency already cover it. Write the least code that satisfies the acceptance criteria — no speculative abstractions, no unrequested cleanup of adjacent code.

## Leave one runnable check

Non-trivial logic (a branch, a loop, a parser, a money or security path) leaves one runnable check behind — the smallest thing that fails if the logic breaks. If the task's constraints make that impossible (a write-only, no-terminal worker, for example), say so explicitly instead of silently skipping it.

## Never claim done without verifying

Run the verification you left behind before reporting success. If you could not run it — no terminal access, no test harness available — say exactly that, rather than asserting the work passes.

## Reviewer gate

A review checks both spec compliance and code quality. Findings block completion until fixed and re-reviewed. Verdict format and fail-closed handling are in the vibeops-forge skill.
