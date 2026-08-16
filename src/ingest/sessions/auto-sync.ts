import { getSetting } from "../../services/settings.js";
import { getEmbedder, type Embedder } from "../../knowledge/embedder.js";
import { ingestSessionsSerialized } from "./ingest.js";
import type { SessionSource } from "./source.js";

const DEFAULT_INTERVAL_MS = 30 * 60_000;

export interface AutoSyncOptions {
  intervalMs?: number;
  sources?: SessionSource[];
  embedder?: Embedder;
  runNow?: boolean;
}

async function defaultSources(): Promise<SessionSource[]> {
  const { makeClaudeMemSource } = await import("./claude-mem.js");
  const { makeClaudeCodeSource } = await import("./claude-code.js");
  const { makeCodexSource } = await import("./codex.js");
  const { makeAntigravitySource } = await import("./antigravity.js");
  return [makeClaudeMemSource(), makeClaudeCodeSource(), makeCodexSource(), makeAntigravitySource()];
}

// Returns null (no timer armed) when the off switch is set. Otherwise arms an
// unref'd interval and returns a stop() handle.
export async function startSessionAutoSync(opts: AutoSyncOptions = {}): Promise<{ stop: () => void } | null> {
  if ((await getSetting("sessions.autoSync")) === "false") return null;
  const intervalMs = opts.intervalMs
    ?? (Number(await getSetting("sessions.autoSyncIntervalMs")) || DEFAULT_INTERVAL_MS);
  const sources = opts.sources ?? (await defaultSources());
  const embedder = opts.embedder ?? getEmbedder();

  const sweep = async () => {
    // 1-day incremental window; hash-gated so a quiet sweep is near-free.
    const summary = await ingestSessionsSerialized(sources, embedder, 1);
    if (summary && Object.values(summary).some((s) => s.indexed > 0)) {
      console.log(`sessions auto-sync: ${JSON.stringify(summary)}`);
    }
  };
  const onErr = (e: unknown) => console.warn(`sessions auto-sync failed: ${(e as Error).message}`);

  if (opts.runNow) void sweep().catch(onErr);
  const timer = setInterval(() => void sweep().catch(onErr), intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
