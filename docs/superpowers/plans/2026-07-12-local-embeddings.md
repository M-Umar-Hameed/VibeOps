# Zero-Key Local Embeddings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `search_knowledge` works out of the box with no API key: a local ONNX model (all-MiniLM-L6-v2, 384-dim) embeds in-process, zero-padded into the existing `vector(1024)` column.

**Architecture:** New `LocalEmbedder` behind the existing pluggable `Embedder` seam (`src/knowledge/embedder.ts`). Lazy dynamic import of `@huggingface/transformers` so the server boots without loading ONNX. Vectors are zero-padded to 1024 (cosine similarity is unchanged by shared zero components); the `dim` column stores the true dim (384) as the model discriminator the existing `where dim = ...` filter uses. No schema change, no migration, no service changes. Provider default chain: explicit `EMBED_PROVIDER` → `VOYAGE_API_KEY` present → voyage → else local.

**Tech Stack:** `@huggingface/transformers` (transformers.js v4.2.0, ONNX runtime), model `Xenova/all-MiniLM-L6-v2` quantized (`dtype: "q8"`, ~23MB), cached in `~/.vibeops/models`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-12-local-embeddings-design.md`.
- The default test suite MUST stay offline — no model download in `npm test`. The real-model test is gated behind `LOCAL_EMBED_TEST=1`.
- `embeddings.embedding` stays `vector(1024)`. No drizzle migration in this slice.
- `dim` column = TRUE model dim (384 for local), never the padded width. Existing search filter (`src/services/knowledge.ts:82`) depends on this.
- Server boot must not import `@huggingface/transformers` eagerly (payload boot time + memory).
- Pin the `@huggingface/transformers` version exactly in package.json (install latest 3.x, record the resolved version in the task report).
- Never push. Commit per task on `master`.
- All commands from repo root `D:\Github\tickets` unless stated. Suite needs Docker PG on :5433 (`docker compose up -d db` if down).

---

### Task 1: LocalEmbedder + provider default chain

**Files:**
- Modify: `src/knowledge/embedder.ts`
- Test: `tests/local-embedder.test.ts` (create)
- Modify: `package.json` (dependency)

**Interfaces:**
- Consumes: existing `Embedder` interface, `MODEL_DIMS`, `FakeEmbedder`, `getEmbedder` in `src/knowledge/embedder.ts`.
- Produces: `export function padTo(v: number[], width: number): number[]`; `export class LocalEmbedder implements Embedder` with `model = "all-MiniLM-L6-v2"`, `dim = 384`, `embed(texts)` returning 1024-wide vectors; `getEmbedder()` default chain (explicit `EMBED_PROVIDER` wins → `VOYAGE_API_KEY` → voyage → local). Task 2 relies on `@huggingface/transformers` being in `dependencies`.

- [ ] **Step 1: Install the dependency**

```bash
npm install @huggingface/transformers
```

Then edit `package.json` to pin the exact resolved version (strip the `^`). Record the version.

- [ ] **Step 2: Write the failing tests**

Create `tests/local-embedder.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { FakeEmbedder, LocalEmbedder, getEmbedder, padTo } from "../src/knowledge/embedder.js";

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] ** 2; nb += b[i] ** 2; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

describe("padTo", () => {
  it("pads with trailing zeros to the target width", () => {
    expect(padTo([1, 2], 5)).toEqual([1, 2, 0, 0, 0]);
    expect(padTo([1, 2, 3], 3)).toEqual([1, 2, 3]);
  });

  it("preserves cosine similarity", () => {
    const a = [0.1, -0.4, 0.8], b = [0.3, 0.2, -0.5];
    expect(cosine(padTo(a, 10), padTo(b, 10))).toBeCloseTo(cosine(a, b), 12);
  });
});

describe("getEmbedder default chain", () => {
  const saved = { EMBED_PROVIDER: process.env.EMBED_PROVIDER, VOYAGE_API_KEY: process.env.VOYAGE_API_KEY };
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  };

  it("defaults to local with no env at all", () => {
    delete process.env.EMBED_PROVIDER; delete process.env.VOYAGE_API_KEY;
    try { expect(getEmbedder()).toBeInstanceOf(LocalEmbedder); } finally { restore(); }
  });

  it("prefers voyage when only a key is set", () => {
    delete process.env.EMBED_PROVIDER; process.env.VOYAGE_API_KEY = "k";
    try { expect(getEmbedder().model).toBe("voyage-3"); } finally { restore(); }
  });

  it("explicit provider wins over the key", () => {
    process.env.EMBED_PROVIDER = "fake"; process.env.VOYAGE_API_KEY = "k";
    try { expect(getEmbedder()).toBeInstanceOf(FakeEmbedder); } finally { restore(); }
  });
});

// Real model download + inference — excluded from the default (offline) suite.
describe.skipIf(!process.env.LOCAL_EMBED_TEST)("LocalEmbedder (live, LOCAL_EMBED_TEST=1)", () => {
  it("embeds to 1024-wide padded vectors with true dim 384", async () => {
    const e = new LocalEmbedder();
    const [a, b] = await e.embed(["postgres backup strategy", "postgres backup strategy"]);
    expect(e.dim).toBe(384);
    expect(a).toHaveLength(1024);
    expect(a.slice(384).every((x) => x === 0)).toBe(true);
    expect(cosine(a, b)).toBeCloseTo(1, 5);
  }, 120_000);
});
```

Note: constructing `LocalEmbedder` must NOT load ONNX — the import happens inside `embed()` — so the chain tests stay offline.

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/local-embedder.test.ts`
Expected: FAIL — `padTo` / `LocalEmbedder` not exported.

- [ ] **Step 4: Implement in `src/knowledge/embedder.ts`**

Add imports at the top:

```ts
import { join } from "node:path";
import { homedir } from "node:os";
```

Add to `MODEL_DIMS`:

```ts
  "all-MiniLM-L6-v2": 384,
```

Add after `FakeEmbedder`:

```ts
export function padTo(v: number[], width: number): number[] {
  return v.length >= width ? v : [...v, ...new Array(width - v.length).fill(0)];
}

// Zero-key local model. `dim` is the TRUE model dim — the search discriminator —
// while returned vectors are zero-padded to the vector(1024) column width
// (padding shared zeros does not change cosine similarity).
export class LocalEmbedder implements Embedder {
  model = "all-MiniLM-L6-v2";
  dim = 384;
  private pipe?: Promise<(texts: string[], opts: object) => Promise<{ tolist(): number[][] }>>;
  private load() {
    // Lazy: the server must boot without loading ONNX; first embed pays the cost.
    this.pipe ??= import("@huggingface/transformers").then((t) => {
      t.env.cacheDir = join(homedir(), ".vibeops", "models");
      return t.pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", { dtype: "q8" }) as never;
    });
    return this.pipe;
  }
  async embed(texts: string[]): Promise<number[][]> {
    const pipe = await this.load();
    const out = await pipe(texts, { pooling: "mean", normalize: true });
    return out.tolist().map((v) => padTo(v, 1024));
  }
}
```

Replace `getEmbedder`:

```ts
export function getEmbedder(): Embedder {
  const provider = process.env.EMBED_PROVIDER
    ?? (process.env.VOYAGE_API_KEY ? "voyage" : "local");
  if (provider === "fake") return new FakeEmbedder(1024);
  if (provider === "local") return new LocalEmbedder();
  const model = process.env.EMBED_MODEL ?? "voyage-3";
  if (!MODEL_DIMS[model]) throw new Error(`unknown embed model: ${model}`);
  if (provider === "voyage") return new VoyageEmbedder(model, process.env.VOYAGE_API_KEY ?? "");
  throw new Error(`unsupported EMBED_PROVIDER: ${provider}`);
}
```

If the transformers.js v3 API differs from the sketch (e.g. `pipeline` typing, `env.cacheDir` name), adapt to the real API — the contract that must hold is: lazy import, cache under `~/.vibeops/models`, q8 MiniLM, mean-pool + normalize, padTo(…, 1024). Note any deviation in your report.

- [ ] **Step 5: Run offline tests**

Run: `npx vitest run tests/local-embedder.test.ts`
Expected: PASS (live describe skipped).

- [ ] **Step 6: Run the live gated test once**

Run: `LOCAL_EMBED_TEST=1 npx vitest run tests/local-embedder.test.ts`
Expected: PASS (downloads ~23MB on first run; needs network to huggingface.co). Confirm `~/.vibeops/models` now contains the model cache. If the sandbox blocks huggingface.co, report it — the controller runs this step.

- [ ] **Step 7: Full suite + typecheck**

Run: `npm test && npx tsc --noEmit`
Expected: all pass (the changed default cannot affect existing tests: every suite path sets `EMBED_PROVIDER` explicitly or injects an embedder).

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json src/knowledge/embedder.ts tests/local-embedder.test.ts
git commit -m "feat: zero-key local embeddings via transformers.js MiniLM"
```

---

### Task 2: Bundle the local-embedding stack into the sidecar payload

**Files:**
- Modify: `scripts/build-server.mjs`
- Test: existing `tests/sidecar-payload.test.ts` must stay green.

**Interfaces:**
- Consumes: Task 1's `@huggingface/transformers` pinned dependency; existing build script structure (esbuild `external` array + pglite copy step).
- Produces: payload `resources/server/node_modules` containing `@huggingface/transformers` and its runtime deps for BOTH win-x64 and linux-x64 (the server payload dir is shared by both platform bundles); `server.mjs` still boots without touching ONNX.

- [ ] **Step 1: Read the current script**

Read `scripts/build-server.mjs` fully. It bundles `src/api/server.ts` to ESM `server.mjs` with `external: ["@electric-sql/pglite"]` and copies the pglite package + `drizzle/` into the output dir.

- [ ] **Step 2: Add the external**

In the esbuild options, extend:

```js
external: ["@electric-sql/pglite", "@huggingface/transformers"],
```

- [ ] **Step 3: Copy the dependency tree into the payload**

Hand-copying the transitive tree (onnxruntime-node, sharp platform packages, etc.) is fragile. Instead, npm-install the single pinned package directly into the payload with platform overrides. After the existing pglite copy step, add:

```js
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Local-embeddings stack: npm resolves the native tree (onnxruntime, sharp) into
// the payload. Two passes because the payload serves BOTH bundle platforms:
// default install resolves this (win-x64) machine's optionals, the second pass
// force-adds the linux-x64 optionals npm would otherwise skip.
const tfVersion = JSON.parse(readFileSync("package.json", "utf-8")).dependencies["@huggingface/transformers"];
execSync(`npm install --prefix "${out}" --no-save --omit=dev @huggingface/transformers@${tfVersion}`, { stdio: "inherit" });
execSync(`npm install --prefix "${out}" --no-save --omit=dev --force --os=linux --cpu=x64 @huggingface/transformers@${tfVersion}`, { stdio: "inherit" });
```

(`out` = the payload output dir variable already used by the pglite copy — reuse it, don't introduce a new one. If the second pass prunes the win binaries — verify by listing — swap strategies: install into a temp prefix per OS and merge the `node_modules` trees, linux over win, letting distinct platform packages coexist.)

- [ ] **Step 4: Verify the payload**

```bash
npm run build:sidecar
node -e "const fs=require('fs');const p='app/src-tauri/resources/server/node_modules';for (const d of ['@huggingface/transformers','onnxruntime-node']) console.log(d, fs.existsSync(p+'/'+d));"
```

Expected: both `true`. Also verify both platforms' native bits exist (onnxruntime-node ships all platforms in one package under `bin/`; sharp uses per-platform `@img/sharp-*` packages — expect both `@img/sharp-win32-x64` and `@img/sharp-linux-x64` if sharp is in the tree).

- [ ] **Step 5: Payload boot test**

Run: `npx vitest run tests/sidecar-payload.test.ts`
Expected: PASS — boots embedded, serves 401. This proves `server.mjs` still boots with the heavier payload and no eager ONNX import.

- [ ] **Step 6: Full suite + typecheck**

Run: `npm test && npx tsc --noEmit`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add scripts/build-server.mjs
git commit -m "feat: bundle local embedding stack into sidecar payload"
```

---

### Task 3: End-to-end zero-key verification + README

**Files:**
- Modify: `README.md` (knowledge/embedding sections)
- No production code changes expected; this task is live verification + docs.

**Interfaces:**
- Consumes: Task 1's provider chain (no env → local), Task 2's payload; existing REST routes `POST /notes` and `GET /knowledge?q=` (knowledge search — NOT `/search`, which is ticket text search) and bootstrap credentials at `$HOME/.vibeops/credentials.json`.
- Produces: verified zero-key search on Windows payload and WSL linux payload; README documents the zero-key default.

- [ ] **Step 1: Windows payload zero-key round-trip**

```bash
R=app/src-tauri/resources
export HOME_TMP=$(mktemp -d)
HOME="$HOME_TMP" USERPROFILE="$HOME_TMP" PORT=18988 VIBEOPS_MIGRATIONS_DIR=$R/server/drizzle \
  $R/node/win-x64/node.exe $R/server/server.mjs &
sleep 20
KEY=$(node -e "console.log(require('$HOME_TMP/.vibeops/credentials.json').apiKey)")
curl -s -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"body":"the database backup runs nightly at 2am","scope":"global"}' http://127.0.0.1:18988/notes
curl -s -H "Authorization: Bearer $KEY" "http://127.0.0.1:18988/knowledge?q=when+do+backups+run"
```

Expected: note created with no embed key in the environment (first call downloads the model into `$HOME_TMP/.vibeops/models`, so allow time / re-check); search returns the note chunk with a sensible score. Kill the server after. If the note write reports embed failure due to model download timing, re-POST once — the design allows retry semantics via `indexed=false` sweep, but the search assertion must eventually pass.

- [ ] **Step 2: WSL linux payload zero-key round-trip**

Same flow on Ubuntu via `wsl -e bash -c "..."` using `$R/node/linux-x64/node` (copy to a native path first, as in Phase 7: `cp $R/node/linux-x64/node /tmp/vnode`). Expected: identical outcome — proves the linux onnxruntime/sharp binaries shipped correctly.

- [ ] **Step 3: README**

In the knowledge section, document: zero-key default (local MiniLM, first-use ~23MB download to `~/.vibeops/models`, works offline afterward); `EMBED_PROVIDER`/`VOYAGE_API_KEY` opt-in for API-grade quality; switching providers makes the other provider's rows invisible to search until re-ingest (dim filter); `~/.vibeops/models` is part of the backup unit and safe to delete (re-downloads).

- [ ] **Step 4: Full gates**

Run: `npm test && npx tsc --noEmit && (cd app && npm test && npx tsc --noEmit)`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: zero-key local embeddings default"
```

---

## Final review (controller)

After all tasks: generate review package from the pre-slice commit to HEAD, dispatch opus whole-branch final review (correctness, security incl. supply chain of the model download, minimalism, spec fidelity), apply Critical/Important fixes, re-gate, update `.superpowers/sdd/progress.md` and cross-session memory.
