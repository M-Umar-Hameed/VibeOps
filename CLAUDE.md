# Execution methodology (binding for every phase)

How work in this repo is executed. Not optional. Applies to all phases and slices.

## 1. Plan with the best model, code with the cheapest — agent-driven

- **Planning, design, task-breakdown, and review** run on the **best available model**. Thinking is where the money goes.
- **Implementation** runs on the **cheapest model that can do the job**, as a **subagent** — never the main thread writing feature code inline.
- This only works because of rule 2: the best-model planner breaks each task down until implementing it is essentially **transcription**. A cheap model can transcribe fully-specified code; it cannot design. So the split is: expensive brains plan and judge, cheap hands type.
- Trivial controller-side fixes (a one-line config, a known typo, a test-isolation tweak the controller fully understands) may be done inline. New feature code goes to an implementation subagent.

## 2. The supervisor gate — nothing passes until the supervisor passes it

Run like a 20-year tech supervisor directing several 5–10-year developers:

- **Break every task small enough to hand to one mid-level developer** and be reviewed independently. A task is the smallest unit that carries its own test cycle. If a task can't be described as fully-specified transcription, it's too big — split it.
- **Each task is a controlled environment**: exact files, exact code, exact test, exact commands. The developer (implementer subagent) does only that task, then reports with test evidence.
- **A review gate follows every task.** The supervisor (controller + a reviewer subagent) checks spec compliance AND code quality. **Nothing is marked complete while a Critical or Important finding is open.** Findings → fix subagent → re-review → repeat until clean.
- The controller verifies the load-bearing claims itself (runs the suite, reads the key diff) rather than trusting a subagent's "all green."

## 3. Minimal code always (ponytail)

Every task writes the **least code that works**. Climb the ladder before writing anything:

1. Does this need to exist at all? (YAGNI — skip it, say so.)
2. Already in this codebase? Reuse it.
3. Stdlib / native platform feature? Use it.
4. Already-installed dependency? Use it. Never add a new dep for a few lines.
5. One line? One line.
6. Only then: the minimum code that works.

No speculative abstraction, no interface with one implementation, no config for a value that never changes, no boilerplate "for later". Deletion over addition. Boring over clever. Mark deliberate shortcuts with a `ponytail:` comment naming the ceiling and upgrade path.

Never minimal about: input validation at trust boundaries, error handling that prevents data loss, security, or anything explicitly requested.

## The loop, concretely

For each task: best-model plan → cheap subagent implements the fully-specified task with TDD → controller generates the diff → reviewer subagent gates (spec + quality) → fix subagent for Critical/Important → re-review → controller verifies the suite → mark complete in the ledger. After all tasks, one best-model whole-branch review before the work is called done.

## UI work

Any change under `app/` follows `docs/UI_GUIDELINES.md`. Plans for UI tickets cite it; reviews of UI diffs check against it.
