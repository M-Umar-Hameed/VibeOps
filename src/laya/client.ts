import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

// Laya is a local structured-decision model reached over MCP stdio: one forward
// pass, no text generation, so no hallucination and no network per call. Measured
// on this machine (CPU, LAYA_DEVICE=cpu): ~1.3s to connect, ~7.6s for the FIRST
// decision because the checkpoint is fetched from huggingface.co, then 217-291ms
// warm. Every caller here is on a request path, so every failure is fail-open:
// a null return means "no opinion" and the caller keeps its existing behaviour.

export type LayaDecision = {
  values: Record<string, unknown>;
  confidence: Record<string, number>;
};

// Laya ships a calibration warning for some checkpoint entries ("values outside
// [0.5, 5] ... treat confidence as uncalibrated"), so a threshold is a filter,
// never a guarantee. Keep thresholds high and always keep the fallback path.
//
// A cold call pays connect (~1.3s) plus the checkpoint load (~7s) before it can
// answer; a warm one answers in 217-291ms. One flat 15s budget was enough warm
// and too tight cold under load, which silently turned real answers into nulls.
// Hence two budgets - and callers on a latency-sensitive path pass their own.
const COLD_TIMEOUT_MS = 45_000;
const WARM_TIMEOUT_MS = 10_000;

let clientPromise: Promise<Client> | undefined;
let warned = false;
let inflight = 0;
let idleTimer: ReturnType<typeof setTimeout> | undefined;

// The spawned model process costs ~3.4 GB of commit and used to be held for the
// life of the sidecar after a single decision. Since the sidecar now runs
// always-on in the tray, that is most of the day for nothing. Drop it after an
// idle period instead; the next call pays the reconnect (~1.3s) plus a checkpoint
// load, which is the right trade for a tool asked a few questions an hour.
const DEFAULT_IDLE_MS = 5 * 60_000;

function idleMs(): number {
  const raw = Number(process.env.LAYA_IDLE_MS);
  if (Number.isFinite(raw) && raw >= 0) return raw; // 0 disables the idle close
  return DEFAULT_IDLE_MS;
}

function armIdleClose(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = undefined;
  const ms = idleMs();
  if (ms === 0) return;
  idleTimer = setTimeout(() => { if (inflight === 0) void closeLaya(); }, ms);
  idleTimer.unref?.();
}

function warnOnce(msg: string): void {
  if (warned) return;
  warned = true;
  console.warn(`laya unavailable, falling back: ${msg}`);
}

// Configured, never hardcoded: the binary lives in a per-machine virtualenv.
// Unset means the feature is off, which is why callers must work without it.
async function resolveCommand(): Promise<string | null> {
  if (process.env.LAYA_COMMAND) return process.env.LAYA_COMMAND;
  try {
    const { getSetting } = await import("../services/settings.js");
    const v = await getSetting("laya.command");
    return v && v.trim() ? v.trim() : null;
  } catch {
    return null; // no database (CLI/relay callers): treat as disabled
  }
}

async function connect(): Promise<Client> {
  const command = await resolveCommand();
  if (!command) throw new Error("laya.command is not set");
  const { Client: Ctor } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const transport = new StdioClientTransport({
    command,
    args: [],
    // LAYA_PRELOAD=0 keeps the checkpoint off the boot path; it loads on the
    // first decision instead, so an idle sidecar pays nothing for laya.
    // Torch and OpenMP default to one thread per core for a model answering one
    // short question at a time. Measured: caps take the spawned process from
    // 3606 MB commit / 23 threads to 3379 MB / 11 threads - only ~6% of the
    // memory, but half the threads, and it costs nothing we use. The real saving
    // is the idle close below, which drops all of it.
    env: {
      ...process.env,
      LAYA_DEVICE: process.env.LAYA_DEVICE ?? "cpu",
      LAYA_PRELOAD: "0",
      OMP_NUM_THREADS: process.env.OMP_NUM_THREADS ?? "1",
      MKL_NUM_THREADS: process.env.MKL_NUM_THREADS ?? "1",
      TORCH_NUM_THREADS: process.env.TORCH_NUM_THREADS ?? "1",
      TOKENIZERS_PARALLELISM: process.env.TOKENIZERS_PARALLELISM ?? "false",
    } as Record<string, string>,
  });
  const client = new Ctor({ name: "vibeops", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

function timeoutMs(cold: boolean, override?: number): number {
  if (override !== undefined && Number.isFinite(override) && override > 0) return override;
  const raw = Number(process.env.LAYA_TIMEOUT_MS);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return cold ? COLD_TIMEOUT_MS : WARM_TIMEOUT_MS;
}

// Module-scoped so one spawned laya is shared, and a failed connect does not
// stay cached as a rejection forever (same shape as the embedder's pipePromise).
function load(): Promise<Client> {
  clientPromise ??= connect().catch((e) => { clientPromise = undefined; throw e; });
  return clientPromise;
}

/**
 * Project `state` onto a JSON schema of enums/booleans/bounded integers.
 * Returns null whenever laya cannot answer, so callers keep their own default.
 */
export async function layaDecide(
  state: Record<string, unknown>,
  schema: Record<string, unknown>,
  opts: { minConfidence?: number; timeoutMs?: number } = {},
): Promise<LayaDecision | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Cold means nothing is connected yet, so this call also pays the model load.
  const cold = clientPromise === undefined;
  const budget = timeoutMs(cold, opts.timeoutMs);
  inflight++;
  try {
    const client = await load();
    const args: Record<string, unknown> = { state, schema };
    if (opts.minConfidence !== undefined) args.min_confidence = opts.minConfidence;
    // A wedged model must not hold a request open: bound every call.
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`laya timed out after ${budget}ms`)), budget);
    });
    const res = await Promise.race([client.callTool({ name: "laya_decide", arguments: args }), deadline]);
    const text = (res as { content?: Array<{ type: string; text?: string }> }).content?.[0]?.text;
    if (!text) return null;
    const parsed = JSON.parse(text) as LayaDecision;
    if (!parsed || typeof parsed !== "object" || !parsed.values) return null;
    return { values: parsed.values, confidence: parsed.confidence ?? {} };
  } catch (e) {
    warnOnce((e as Error).message);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
    inflight--;
    armIdleClose();
  }
}

// One boolean field, with a confidence floor. Returns null when laya has no
// usable answer; callers must treat null as "decide it the old way".
export async function layaBoolean(
  state: Record<string, unknown>,
  field: string,
  minConfidence: number,
  opts: { timeoutMs?: number } = {},
): Promise<boolean | null> {
  const d = await layaDecide(
    state,
    { type: "object", properties: { [field]: { type: "boolean" } } },
    { minConfidence, timeoutMs: opts.timeoutMs },
  );
  const v = d?.values?.[field];
  if (typeof v !== "boolean") return null;
  const c = d?.confidence?.[field];
  if (typeof c === "number" && c < minConfidence) return null;
  return v;
}

// The stdio transport owns a spawned Python process; Windows will not reap it for
// us, so shutdown must close it or an idle torch process survives the sidecar.
export async function closeLaya(): Promise<void> {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = undefined;
  const p = clientPromise;
  clientPromise = undefined;
  if (!p) return;
  try { await (await p).close(); } catch { /* already gone */ }
}

// Test seam: drop the memoised client without closing a real one.
export function resetLayaForTests(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = undefined;
  clientPromise = undefined;
  inflight = 0;
  warned = false;
}
