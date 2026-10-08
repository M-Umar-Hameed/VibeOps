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
const DEFAULT_TIMEOUT_MS = 15_000;

let clientPromise: Promise<Client> | undefined;
let warned = false;

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
    env: { ...process.env, LAYA_DEVICE: process.env.LAYA_DEVICE ?? "cpu", LAYA_PRELOAD: "0" } as Record<string, string>,
  });
  const client = new Ctor({ name: "vibeops", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

function timeoutMs(): number {
  const raw = Number(process.env.LAYA_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
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
  opts: { minConfidence?: number } = {},
): Promise<LayaDecision | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const client = await load();
    const args: Record<string, unknown> = { state, schema };
    if (opts.minConfidence !== undefined) args.min_confidence = opts.minConfidence;
    // A wedged model must not hold a request open: bound every call.
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`laya timed out after ${timeoutMs()}ms`)), timeoutMs());
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
  }
}

// One boolean field, with a confidence floor. Returns null when laya has no
// usable answer; callers must treat null as "decide it the old way".
export async function layaBoolean(
  state: Record<string, unknown>,
  field: string,
  minConfidence: number,
): Promise<boolean | null> {
  const d = await layaDecide(state, { type: "object", properties: { [field]: { type: "boolean" } } }, { minConfidence });
  const v = d?.values?.[field];
  if (typeof v !== "boolean") return null;
  const c = d?.confidence?.[field];
  if (typeof c === "number" && c < minConfidence) return null;
  return v;
}

// The stdio transport owns a spawned Python process; Windows will not reap it for
// us, so shutdown must close it or an idle torch process survives the sidecar.
export async function closeLaya(): Promise<void> {
  const p = clientPromise;
  clientPromise = undefined;
  if (!p) return;
  try { await (await p).close(); } catch { /* already gone */ }
}

// Test seam: drop the memoised client without closing a real one.
export function resetLayaForTests(): void {
  clientPromise = undefined;
  warned = false;
}
