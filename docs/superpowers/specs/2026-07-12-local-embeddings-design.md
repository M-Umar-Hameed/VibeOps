# Zero-Key Local Embeddings (Design Spec)

## Context

`search_knowledge` currently requires a Voyage API key (`EMBED_PROVIDER=voyage` is the default). The one-file installed app (Phase 7) therefore ships with a knowledge layer that silently cannot embed anything until the user provisions a key. This slice makes embeddings work out of the box with no API key: a local ONNX model runs in-process via transformers.js.

Decided autonomously with documented assumptions (user delegated: "you'll be in charge of working").

## Decision summary

- New provider `local`: `@huggingface/transformers` feature-extraction pipeline running `all-MiniLM-L6-v2` (quantized ONNX, ~23MB, 384 dimensions), mean-pooled + normalized.
- **Zero-padding, no migration:** the `embeddings.embedding` column stays `vector(1024)`. The local embedder pads its 384-dim vectors with trailing zeros to 1024 before returning them. Zero-padding does not change cosine similarity between same-model vectors (dot products and norms are unaffected by shared zero components). The `dim` column stores the TRUE dim (384) — it is the model-discriminator the existing `where dim = ...` search filter uses, not the stored vector width. This keeps the hnsw index and every service untouched.
- **Provider default chain** in `getEmbedder()`: explicit `EMBED_PROVIDER` wins; else if `VOYAGE_API_KEY` is set, voyage; else local. A fresh install with no env at all gets working search.
- **Model download:** lazily on first embed, from the Hugging Face hub, cached in `~/.vibeops/models` (transformers.js `env.cacheDir`). One-time ~23MB download; before it completes (or offline), embedding calls fail with a clear error and the caller's existing error paths apply (notes stay `indexed=false`, watcher skips and retries next run).
- **Sidecar payload:** `@huggingface/transformers` (and its `onnxruntime-node` dependency) are esbuild externals copied into the payload `node_modules` like pglite. The payload `resources/server` dir is shared by the win-x64 and linux-x64 bundles, so pruning keeps both of those onnxruntime binary sets and drops only the others (darwin, arm).

## Approaches considered

1. **Zero-pad 384-dim local model (chosen).** No migration, no index changes, one class + a pad helper. Mixed voyage(1024)/local(384) rows coexist; search already filters to the active dim.
2. **Native 1024-dim local model** (e.g. mxbai-embed-large). No padding, but ~300MB download and materially heavier RAM/CPU — wrong default for "works out of the box".
3. **Dimensionless `vector` column migration.** Cleanest data model, but pgvector cannot hnsw-index a dimensionless column, and it forces a migration + index answer for external-Postgres users. Most invasive, least gain.

Model choice within (1): MiniLM over bge-small-en-v1.5 because bge requires an asymmetric query prefix, which would split the `Embedder` interface into `embedQuery`/`embedDocuments` and ripple through every service. MiniLM is symmetric, standard, and good enough for local-first search. Upgrade path: add a bge/nomic provider later behind the same seam if retrieval quality warrants the interface split.

## Component changes

- `src/knowledge/embedder.ts` — `LocalEmbedder implements Embedder`: lazy dynamic `import("@huggingface/transformers")` (server must boot instantly and never load ONNX unless embedding is actually used), pipeline held as a memoized promise, `embed()` runs the pipeline (mean pooling + normalize) then pads each vector to 1024. `model = "all-MiniLM-L6-v2"`, `dim = 384`. `MODEL_DIMS` gains the entry. `getEmbedder()` default chain as above. A comment states the dim-vs-width contract.
- `scripts/build-server.mjs` — add the two packages to `external`, copy them into the payload `node_modules`, prune onnxruntime binaries for platforms the bundle does not ship (keep win-x64 + linux-x64).
- `README.md` — knowledge section: zero-key default, first-use download note, how to opt into Voyage/OpenAI-class quality with a key, mixed-dim behavior (switching providers makes the other provider's rows invisible to search until re-ingest).

Nothing else changes: `upsertSourceDoc`, `searchKnowledge`, notes, sessions, and the watcher all consume the `Embedder` interface as-is.

## Data flow

Identical to today. The only new behavior: first call to `LocalEmbedder.embed()` downloads and caches the model, subsequent calls are local inference. Rows written by the local provider carry `model='all-MiniLM-L6-v2', dim=384` with 1024-wide zero-padded vectors; search with the local provider pads the query vector identically and filters `dim = 384`.

## Error handling

- Model download failure / offline: `embed()` rejects; existing callers already treat embedding failure as non-fatal (note stays unindexed and is swept later; watcher logs and skips; ingest CLI reports the failure). No new machinery.
- `~/.vibeops/models` is inside the existing single backup unit; deleting it just re-downloads.

## Testing

- Unit (offline, default suite): zero-pad helper preserves cosine ordering and pads to exactly 1024; `getEmbedder()` default chain (no env → local, VOYAGE_API_KEY → voyage, explicit provider wins).
- Gated integration (`LOCAL_EMBED_TEST=1`, excluded from the default suite): real model download + embed, asserts 1024-wide vectors, dim tag 384, and self-similarity ≈ 1.
- Payload boot test unchanged — it must stay green with the heavier payload.

## Out of scope

- Reranking, hybrid search, multilingual models, GPU execution providers.
- Bundling the model inside the installer (first-use download keeps the installer small; revisit if offline-first-run becomes a requirement).
- Auto re-embedding existing voyage rows when switching providers (documented manual re-ingest instead).
