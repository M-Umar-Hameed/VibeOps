import { serve } from "@hono/node-server";
import { app } from "./app.js";
import { isEmbedded } from "../db/client.js";
import { runBootstrap } from "../bootstrap.js";
import { ensureIndex } from "../db/vector-setup.js";
import { applyEnvSettings } from "../services/settings.js";
import { startWatcher } from "../ingest/watch.js";
import { reapStaleTickets } from "../services/reaper.js";
import { markInterruptedRuns, startPipeline } from "../forge/runs.js";
import { getSetting } from "../services/settings.js";
import { listActors } from "../services/actors.js";
import { getTicket } from "../services/history.js";
import { loadRelayConfig } from "../relay/config.js";

const port = Number(process.env.PORT ?? 8787);
if (isEmbedded) {
  await ensureIndex();
  const { bootstrapped } = await runBootstrap(port);
  if (bootstrapped) console.log("first run: created Inbox project + owner key -> ~/.vibeops/credentials.json");
}
await applyEnvSettings();
// Vault indexing is on by default; never blocks or crashes boot.
void startWatcher().catch((e) => console.warn(`vault watcher failed to start: ${(e as Error).message}`));
void reapStaleTickets().then(n => { if (n) console.log(`reaper: bounced ${n} stale ticket(s)`); }).catch(() => {});

async function handleInterruptedRuns() {
  const ticketIds = await markInterruptedRuns();
  if (ticketIds.length) console.log(`forge: marked ${ticketIds.length} interrupted run(s)`);
  if ((await getSetting("forge.autoResume")) !== "true") return;
  const config = loadRelayConfig(process.env.VIBEOPS_RELAY_CONFIG);
  const admin = (await listActors()).find((a) => a.role === "admin");
  if (!admin) return;
  let resumes = 0;
  for (const id of ticketIds) {
    if (resumes >= 2) break;
    try {
      const t = await getTicket(id);
      if (t.status === "open" || t.status === "planned") {
        await startPipeline(admin.id, config, {
          ticketId: id, planAgent: "auto", workAgent: "auto", reviewAgent: "auto"
        });
        resumes++;
      }
    } catch (e) {
      console.warn(`forge: auto-resume failed for ticket ${id}:`, (e as Error).message);
    }
  }
}
void handleInterruptedRuns().catch(() => {});

// Sessions auto-ingest (opt-out via setting sessions.autoSync = "false"): the
// manual Sync button stays for on-demand runs; incremental 1-day window keeps
// the boot pass cheap. Never blocks or crashes boot.
async function autoSyncSessions(): Promise<void> {
  try {
    const { getSetting } = await import("../services/settings.js");
    if ((await getSetting("sessions.autoSync")) === "false") return;
    const { ingestSessions } = await import("../ingest/sessions/ingest.js");
    const { makeClaudeMemSource } = await import("../ingest/sessions/claude-mem.js");
    const { makeClaudeCodeSource } = await import("../ingest/sessions/claude-code.js");
    const { makeCodexSource } = await import("../ingest/sessions/codex.js");
    const { makeAntigravitySource } = await import("../ingest/sessions/antigravity.js");
    const { getEmbedder } = await import("../knowledge/embedder.js");
    const summary = await ingestSessions(
      [makeClaudeMemSource(), makeClaudeCodeSource(), makeCodexSource(), makeAntigravitySource()],
      getEmbedder(), 1,
    );
    console.log(`sessions auto-sync: ${JSON.stringify(summary)}`);
  } catch (e) {
    console.warn(`sessions auto-sync failed: ${(e as Error).message}`);
  }
}
void autoSyncSessions();
setInterval(() => void autoSyncSessions(), 6 * 60 * 60_000).unref();
// Embedded (installed desktop) mode is loopback-only; external-Postgres deployments
// legitimately serve other hosts.
// overrideGlobalObjects:false — hono's lightweight global Response breaks
// transformers.js model caching (`response instanceof Response` fails, so the
// local embedder can never download its model inside the server).
serve({ fetch: app.fetch, port, hostname: isEmbedded ? "127.0.0.1" : "0.0.0.0", overrideGlobalObjects: false });
console.log(`api on :${port}${isEmbedded ? " (embedded db)" : ""}`);
