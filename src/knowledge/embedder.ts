import { createHash } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";

export interface Embedder {
  embed(texts: string[]): Promise<number[][]>;
  model: string;
  dim: number;
}

export const MODEL_DIMS: Record<string, number> = {
  "voyage-3": 1024,
  "voyage-3-lite": 512,
  "voyage-3.5": 1024,
  "voyage-3.5-lite": 1024,
  "voyage-code-3": 1024,
  "voyage-4-large": 1024,
  "voyage-4": 1024,
  "voyage-4-lite": 1024,
  "voyage-3-large": 1024,
  "voyage-law-2": 1024,
  "voyage-finance-2": 1024,
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
  "text-embedding-004": 768,
  "all-MiniLM-L6-v2": 384,
};

// Matryoshka models accept output_dimension; we pin 1024 to match the vector
// column. Models absent here use their fixed native dim.
const OUTPUT_DIM_MODELS = new Set(["voyage-3.5", "voyage-3.5-lite", "voyage-code-3", "voyage-4-large", "voyage-4", "voyage-4-lite", "voyage-3-large"]);

// Deterministic pseudo-embedding for tests: hash-seeded unit-ish vector.
export class FakeEmbedder implements Embedder {
  model = "fake";
  constructor(public dim = 1024) {}
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      const h = createHash("sha256").update(t).digest();
      return Array.from({ length: this.dim }, (_, i) => (h[i % h.length] / 255) * 2 - 1);
    });
  }
}

export function padTo(v: number[], width: number): number[] {
  return v.length >= width ? v : [...v, ...new Array(width - v.length).fill(0)];
}

// Xenova/all-MiniLM-L6-v2 main branch commit sha, verified 2026-07-12. Bump deliberately.
const PINNED_REVISION = "751bff37182d3f1213fa05d7196b954e230abad9";

// Module-scoped so all LocalEmbedder instances share one pipeline load (dedupes
// concurrent first-embed downloads) and a failed load (e.g. offline first-run)
// doesn't stay cached as a rejection forever.
let pipePromise: Promise<(texts: string[], opts: object) => Promise<{ tolist(): number[][] }>> | undefined;

// Zero-key local model. `dim` is the TRUE model dim — the search discriminator —
// while returned vectors are zero-padded to the vector(1024) column width
// (padding shared zeros does not change cosine similarity).
export class LocalEmbedder implements Embedder {
  model = "all-MiniLM-L6-v2";
  dim = 384;
  private load() {
    // Lazy: the server must boot without loading ONNX; first embed pays the cost.
    pipePromise ??= import("@huggingface/transformers").then((t) => {
      t.env.cacheDir = join(homedir(), ".vibeops", "models");
      return t.pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", { dtype: "q8", revision: PINNED_REVISION }) as never;
    }).catch((e) => { pipePromise = undefined; throw e; });
    return pipePromise;
  }
  async embed(texts: string[]): Promise<number[][]> {
    const pipe = await this.load();
    const out = await pipe(texts, { pooling: "mean", normalize: true });
    return out.tolist().map((v) => padTo(v, 1024));
  }
}

// --- Voyage throttle + 429 retry: module-level, one queue per process ---
// ponytail: single promise-chain queue + adaptive interval; per-key queues only if multi-tenant ever matters.
const THROTTLED_INTERVAL_MS = 21_000; // ~3 req/min with margin, set on first 429
const INTERVAL_FLOOR_MS = 2_000;
const HALVE_AFTER_SUCCESSES = 20;
const RETRY_BACKOFF_MS = [30_000, 60_000, 120_000];

let voyageQueue: Promise<unknown> = Promise.resolve();
let adaptiveIntervalMs = 0; // 0 until first 429: paid RPM is high, don't slow the happy path
let successRun = 0;
let lastRequestStart = -Infinity;
let warned429 = false;

// VOYAGE_MIN_INTERVAL_MS forces a fixed interval and disables adaptation.
function forcedIntervalMs(): number | null {
  const raw = process.env.VOYAGE_MIN_INTERVAL_MS;
  if (raw === undefined || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function retryAfterMs(res: Response): number | null {
  const h = res.headers.get("retry-after");
  if (h === null || h.trim() === "") return null;
  const n = Number(h);
  return Number.isFinite(n) && n >= 0 ? n * 1000 : null;
}

// Test-only: reset module throttle state between cases.
export function resetVoyageThrottle(): void {
  voyageQueue = Promise.resolve();
  adaptiveIntervalMs = 0;
  successRun = 0;
  lastRequestStart = -Infinity;
  warned429 = false;
}

export class VoyageEmbedder implements Embedder {
  dim: number;
  constructor(public model: string, private apiKey: string) {
    const d = MODEL_DIMS[model];
    if (!d) throw new Error(`unknown embed model: ${model}`);
    this.dim = d;
  }
  async embed(texts: string[]): Promise<number[][]> {
    // All Voyage requests serialize through the module chain; the chain holds
    // only the newest promise, so memory stays bounded.
    const run = voyageQueue.then(() => this.embedWithRetry(texts));
    voyageQueue = run.catch(() => undefined);
    return run;
  }
  private async embedWithRetry(texts: string[]): Promise<number[][]> {
    for (let attempt = 0; ; attempt++) {
      const wait = lastRequestStart + (forcedIntervalMs() ?? adaptiveIntervalMs) - Date.now();
      if (wait > 0) await sleep(wait);
      lastRequestStart = Date.now();
      const res = await this.request(texts);
      if (res.ok) {
        if (forcedIntervalMs() === null && adaptiveIntervalMs > INTERVAL_FLOOR_MS && ++successRun >= HALVE_AFTER_SUCCESSES) {
          adaptiveIntervalMs = Math.max(INTERVAL_FLOOR_MS, adaptiveIntervalMs / 2);
          successRun = 0;
        }
        const data = (await res.json()) as { data: { embedding: number[] }[] };
        // Pad sub-1024 dims to the vector(1024) column width, same as the local
        // embedder — shared zero padding preserves cosine similarity.
        return data.data.map((d) => padTo(d.embedding, 1024));
      }
      // 5xx/other: single failure -> throw (unchanged behavior). 429: retry up
      // to 3 times, so the sticky fallback only sees truly exhausted 429s.
      if (res.status !== 429 || attempt >= RETRY_BACKOFF_MS.length) {
        throw new Error(`voyage embed failed: ${res.status}`);
      }
      successRun = 0;
      if (forcedIntervalMs() === null && adaptiveIntervalMs < THROTTLED_INTERVAL_MS) adaptiveIntervalMs = THROTTLED_INTERVAL_MS;
      if (!warned429) {
        warned429 = true;
        console.warn("voyage 429, retrying with backoff");
      }
      await sleep(retryAfterMs(res) ?? RETRY_BACKOFF_MS[attempt]);
    }
  }
  private async request(texts: string[]): Promise<Response> {
    const body: Record<string, unknown> = { input: texts, model: this.model };
    if (OUTPUT_DIM_MODELS.has(this.model)) body.output_dimension = this.dim;
    return fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
    });
  }
}

// Sticky process-wide fallback: after the first Voyage embed failure (429, 5xx,
// network) the whole process embeds locally for the rest of its lifetime, so new
// rows and queries stay in one vector space. Voyage rows written earlier keep
// their 1024-dim tag and are simply not queried again (dim discriminator).
let voyageFellBack = false;

// Test-only: reset the sticky flag between cases in a shared module instance.
export function resetVoyageFallback(): void {
  voyageFellBack = false;
}

export class VoyageWithLocalFallback implements Embedder {
  model: string;
  dim: number;
  private local?: Embedder;
  constructor(private primary: Embedder, private makeLocal: () => Embedder = () => new LocalEmbedder()) {
    this.model = primary.model;
    this.dim = primary.dim;
  }
  async embed(texts: string[]): Promise<number[][]> {
    if (!voyageFellBack) {
      try {
        return await this.primary.embed(texts);
      } catch (e) {
        // Sync check-and-set in the catch: at most one warn even under concurrent
        // in-flight batches (no await between check and set).
        if (!voyageFellBack) {
          voyageFellBack = true;
          console.warn(`${(e as Error).message}, falling back to local embedder`);
        }
      }
    }
    const local = (this.local ??= this.makeLocal());
    this.model = local.model;
    this.dim = local.dim;
    return local.embed(texts);
  }
}

export function getEmbedder(): Embedder {
  const provider = process.env.EMBED_PROVIDER
    ?? (process.env.VOYAGE_API_KEY ? "voyage" : "local");
  if (provider === "fake") return new FakeEmbedder(1024);
  if (provider === "local") return new LocalEmbedder();
  const model = process.env.EMBED_MODEL ?? "voyage-3";
  if (!MODEL_DIMS[model]) throw new Error(`unknown embed model: ${model}`);
  if (provider === "voyage") {
    if (voyageFellBack) return new LocalEmbedder();
    return new VoyageWithLocalFallback(new VoyageEmbedder(model, process.env.VOYAGE_API_KEY ?? ""));
  }
  throw new Error(`unsupported EMBED_PROVIDER: ${provider}`);
}
