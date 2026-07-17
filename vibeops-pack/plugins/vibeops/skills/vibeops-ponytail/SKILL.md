---
name: vibeops-ponytail
description: The laziness ladder — climb it before writing any code; root-cause fixes over symptom patches; no speculative abstractions.
---

# VibeOps Ponytail

Minimum code that solves the problem. Nothing speculative. Climb the ladder before writing anything — stop at the first rung that holds:

1. **Does this need to exist at all?** Speculative need — skip it, say so. (YAGNI)
2. **Already in this codebase?** A helper, util, type, or pattern that already lives here — reuse it.
3. **Stdlib do it?** Use it.
4. **Native platform feature cover it?** A DB constraint over app code, CSS over JS.
5. **Already-installed dependency solve it?** Use it — never add a new dependency for a few lines.
6. **Can it be one line?** One line.
7. **Only then:** the minimum code that works.

## Root cause, not symptom

A bug report names a symptom. Before editing, find every caller of the function you're about to touch. A guard in the shared function is usually a smaller diff than a guard in every caller, and it's the only fix that also protects the callers the report didn't mention.

## No speculative abstractions

No interface with one implementation, no factory for one product, no config for a value that never changes, no boilerplate "for later." Three similar lines beat a premature abstraction.

## Never lazy about

Input validation at trust boundaries, error handling that prevents data loss, security, accessibility basics, and anything explicitly requested. Simplification never touches these.

## Mark deliberate shortcuts

If you take a shortcut with a known ceiling (a global lock, an O(n²) scan, a naive heuristic), mark it with a `ponytail:` comment naming the ceiling and the upgrade path, e.g. `# ponytail: global lock, per-account locks if throughput matters`.
