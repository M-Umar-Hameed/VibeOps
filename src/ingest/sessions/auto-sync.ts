import { getSetting, setSetting } from "../../services/settings.js";
import { getEmbedder, type Embedder } from "../../knowledge/embedder.js";
import { startSessionIngestJob } from "./ingest.js";
import type { SessionSource } from "./source.js";

const DEFAULT_INTERVAL_MS = 30 * 60_000;

export interface AutoSyncOptions {
  intervalMs?: number;
  sources?: SessionSource[];
  embedder?: Embedder;
  runNow?: boolean;
  isBusy?: () => boolean;
}

async function defaultSources(): Promise<SessionSource[]> {
  const { makeClaudeMemSource } = await import("./claude-mem.js");
  const { makeClaudeCodeSource } = await import("./claude-code.js");
  const { makeCodexSource } = await import("./codex.js");
  const { makeAntigravitySource } = await import("./antigravity.js");
  return [makeClaudeMemSource(), makeClaudeCodeSource(), makeCodexSource(), makeAntigravitySource()];
}

export const LAST_SWEEP_KEY = "sessions.lastSweepAt";
const DAY_MS = 86_400_000;

// Catch-up window: days since the last completed sweep + 1, clamped to [1, 30]
// (30 = Claude Code's default transcript retention). Missing/invalid -> 30.
export function sweepSinceDays(lastSweepAt: string | null, now = Date.now()): number {
  const t = lastSweepAt ? Date.parse(lastSweepAt) : NaN;
  if (Number.isNaN(t)) return 30;
  return Math.min(30, Math.max(1, Math.ceil((now - t) / DAY_MS) + 1));
}

// One sweep; null when another session ingest is already running. lastSweepAt advances only
// when the sweep finishes uncancelled, and records the sweep START so files touched mid-sweep are re-covered.
export async function sweepOnce(sources: SessionSource[], embedder: Embedder, key = LAST_SWEEP_KEY) {
  const startedAt = new Date().toISOString();
  const sinceDays = sweepSinceDays(await getSetting(key));
  const { job, promise, existing } = startSessionIngestJob(sources, embedder, sinceDays, "auto");
  if (existing) return null;
  const summary = await promise;
  if (!job.cancelRequested) await setSetting(key, startedAt);
  return summary;
}

// Returns null (no timer armed) when the off switch is set. Otherwise arms an
// unref'd interval and returns a stop() handle.
export async function startSessionAutoSync(opts: AutoSyncOptions = {}): Promise<{ stop: () => void } | null> {
  if ((await getSetting("sessions.autoSync")) === "false") return null;
  const intervalMs = opts.intervalMs
    ?? (Number(await getSetting("sessions.autoSyncIntervalMs")) || DEFAULT_INTERVAL_MS);
  const sources = opts.sources ?? (await defaultSources());
  const embedder = opts.embedder ?? getEmbedder();
  const isBusy = opts.isBusy ?? (await import("../../forge/runs.js")).hasAnyActiveRun;

  const sweep = async () => {
    if (isBusy()) return;
    const summary = await sweepOnce(sources, embedder);
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
