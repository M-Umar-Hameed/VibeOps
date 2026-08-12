# The lessons clause is inert on work prompts

Date: 2026-08-12

## Question

`prompt-lessons` (1265 chars, unchanged for three weeks) was injected into every plan
and work prompt, prefixed "Prompting lessons learned (follow these)". Nobody had ever
measured whether it changes agent output. Keeping it and deleting it were equally
unevidenced.

## Method

Same agent (agy / Gemini 3.1 Pro, plan mode, no file writes), same task, two arms
differing only by the appended lessons clause. Two samples per arm.

- **Control task** — write a pure `clampLimit` function. Nothing in the doc applies.
  Detects whether the doc degrades unrelated work.
- **Trap task** — write a vitest integration test against a shared database. Line 10 of
  the doc ("Test isolation is mandatory — integration tests must not mutate shared
  state mid-suite") targets this case directly.

Harness and raw outputs: scratchpad `ab-harness.mjs`, `ab-out/`.

## Result

**Control: byte-identical output in both arms, both samples.** The same function,
character for character, with and without the doc.

**Trap: no difference.** Both arms used the isolation helper 2/2. Both arms produced
exactly one broken test out of two:

- `trap-without-1` calls `analyzer.run()` and then asserts that spy was not called.
  The test cannot pass.
- `trap-with-1` spies on `analyzer.execute` while never importing `analyzer`.
  ReferenceError.

The doc changed neither isolation behaviour nor defect rate.

## Conclusion and action

Stopped injecting the clause into **work** prompts (`src/forge/runs.ts`, work prompt
composition). Left the **plan** stage untouched, because it was not tested and the
evidence does not reach it.

The case for removal is not cost — 1265 chars is roughly 316 tokens, which is noise.
It is that most of the document addresses the supervisor ("Supervisor sweeps before
planning", "Plan lists all files and commands", "REPORT: and VERDICT: are role
boundaries") and was being handed to workers who cannot act on any of it, under a
"follow these" imperative, with no evidence it ever helped.

## Limits of this evidence

Four samples per task on one model, on toy tasks, scored by hand. This shows the doc is
inert for worker-shaped prompts on this model. It does not show the doc is harmless at
the plan stage, where the supervisor-facing lines are at least on-topic, and it does not
rule out an effect too small for n=2 to see.
