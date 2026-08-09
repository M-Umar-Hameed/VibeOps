# Graft vs knowledgeGraph Evaluation

**Date:** 2026-08-09
**Verdict:** Neither replaces the other. Different substrates, minimal overlap.

## Summary

Graft (tier 1) builds a **code structure graph** via tree-sitter over `.ts/.tsx/.js` files: functions, types, classes, call edges. 1268 nodes, 4469 edges.

knowledgeGraph builds a **document similarity graph** via embeddings over `.md` files: READMEs, design docs, plans. 55 nodes, 200 edges.

They operate on disjoint file sets. Running both is **not** the stale-authoritative-duplication failure mode the re-index ticket targeted — the overlap is zero. The question "does Graft replace knowledgeGraph" is malformed: they answer different questions.

## Measurements

| Metric | Graft tier-1 | knowledgeGraph |
|--------|--------------|----------------|
| Wall-clock | 9.95s | 49.07s (49.03s indexing + 0.04s graph) |
| Output size | 8.1 MB (306 markdown cards) | 55 embedded docs |
| Nodes | 1268 (778 function, 305 file, 132 type, 23 method, 15 class, 15 interface) | 55 (all `repo` kind) |
| Edges | 4469 (call/reference edges) | 200 (cosine similarity ≥ 0.45) |
| Embedder model | N/A (tree-sitter, no LLM) | voyage-code-3 (Voyage API) |

Note: knowledgeGraph timing includes Voyage API latency for 55 embeddings. Local embedder would differ.

## Five-Question Comparison

| Question | Graft answer | knowledgeGraph answer |
|----------|--------------|----------------------|
| **Q1:** What calls `killTree` and which must `await` it? | **Correct.** `src/relay/invoke.ts#killTree` has 9 edges. Production callers: `runOne` (L47, `void`), `stopRun` (L778, `await`), `runAgent` (L89, `void`). Tests: `relay-pipeline.test.ts`, `relay-unit.test.ts`. | **Silent.** No `.ts` files indexed. Docs mention `killTree` (e.g., `agent-sdk-lane.md`) but doc-similarity edges don't answer "what calls X." |
| **Q2:** Where does forge pipeline decide an agent lane? | **Partial.** Shows `src/relay/dispatch.ts#runAgent` (L10-19) which contains the branch. Tier-1 shows signature only, not body logic — agent must read file. | **Silent.** |
| **Q3:** What writes to the `embeddings` table? | **Correct.** Two functions: `insertNoteEmbedding` (called by `saveNote`, `sweepUnindexedNotes`, `updateNote`), `upsertSourceDoc` (called by `indexRepoDocs`, `upsertVaultFile`, `ingestSessions`, plus routes/tests). | **Silent.** |
| **Q4:** Where does promote re-index repo docs (`indexRepoDocs` caller)? | **Correct.** `indexRepoDocs` called from `startPipeline` (L316), `forge-routes.ts#registerForgeRoutes`, `app.ts`. Note: `promoteSandbox` itself doesn't call it — it's in `startPipeline` after promote. | **Silent.** |
| **Q5:** What resolves a project vault path? | **Correct.** `resolveProjectVaultPath` (vault-path.ts), `resolveVaultPath` (watch.ts), `resolveVaultRefPath` (knowledge.ts). 15+ vault-related nodes. | **Silent.** |

**Score:** Graft 5/5 (4 correct, 1 partial). knowledgeGraph 0/5 (all silent on code-structure questions).

## Grep Comparison

The prior council ruling rejected CodeGraph because ripgrep answers "what calls X" instantly. Does Graft beat grep on these questions?

| Question | Grep answer | Graft advantage |
|----------|-------------|-----------------|
| Q1 | `rg killTree` finds all 14 references instantly. Must manually filter callers from definitions/comments. | Graft pre-computes call edges — shows only callers, with source → target direction. Marginal win for large codebases; negligible at 305 files. |
| Q2 | `rg 'type === "sdk"'` finds L17 instantly. | No advantage. |
| Q3 | `rg 'insert.*embeddings\|upsert'` finds both functions. | Graft shows callers transitively; grep requires second hop. Marginal win. |
| Q4 | `rg indexRepoDocs` finds 10 lines. | No advantage. |
| Q5 | `rg 'vault.*path' -i` finds all. | No advantage. |

**Verdict on grep:** Graft's call-graph edges are a convenience, not a capability gap. At 5,000 files ripgrep is still sub-second. The prior council ruling stands: an index is overhead for milliseconds saved.

## LLM Pass Cost

**Not measured.** Reason: substrate mismatch means the LLM pass cannot turn Graft (code structure) into a knowledgeGraph replacement (doc similarity). The LLM pass adds summaries/crux to code nodes — useful for code questions, irrelevant for doc similarity. A second recurring indexing cost must not be stacked on the unresolved corrupt-embeddings re-embedding decision.

## Recommendation

**Do not replace knowledgeGraph with Graft.** They are not substitutes.

**Case for this recommendation:**
- knowledgeGraph indexes documentation (design specs, plans, READMEs) that Graft ignores.
- Doc-to-doc similarity edges have different utility than call-graph edges.
- The "stale-but-authoritative" failure mode requires *overlapping* sources feeding the same prompt slot. These sources don't overlap.

**Case against (pro-Graft):**
- knowledgeGraph's doc-similarity edges may be low-value in practice — plan agents may not use them.
- Graft answers all five structural questions; knowledgeGraph answers none.
- Graft is faster (10s vs 49s) and has no API cost (tier-1 is local tree-sitter).
- If Graft replaces grep-based discovery, one Node dependency replaces per-query ripgrep invocations.

**Counter to the case against:**
- The prior council ruling (3/10 NO-GO) found that grep already works, and an index is 500+ LOC of maintenance for milliseconds saved. Graft's advantage over grep on these five questions is marginal — direction-aware edges vs manual filtering.
- knowledgeGraph serves a different purpose (doc similarity for semantic search); removing it loses that capability.
- Adding Graft as a *separate* code-structure source is a different proposal — evaluate as a follow-up ticket if desired.

## Out of Scope (Confirmed)

- No dependency added: `package.json`/`package-lock.json` unchanged.
- No app code changed: `git diff` empty except this report.
- All artifacts (Graft output, knowledgeGraph JSON) written to OS tempdir, not repo.

---

*Measured on this repo at commit `07047400a42f2c1fb9fc6166d0a1286557321d90`. Vendor claims (SWE-bench figures, 4x cost / 3x speed) not repeated.*
