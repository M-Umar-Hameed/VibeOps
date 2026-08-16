import { serve } from "@hono/node-server";
import { app } from "./app.js";
import { isEmbedded, closeDb, embeddedDbError, db } from "../db/client.js";
import { runBootstrap } from "../bootstrap.js";
import { ensureIndex } from "../db/vector-setup.js";
import { applyEnvSettings } from "../services/settings.js";
import { startWatcher, rescanProjectVaults } from "../ingest/watch.js";
import { startSessionAutoSync } from "../ingest/sessions/auto-sync.js";
import { reapStaleTickets } from "../services/reaper.js";
import { markInterruptedRuns, reconcileMergedTickets } from "../forge/runs.js";
import { restoreCouncilSessions } from "../council/runs.js";
import { configureExport } from "../services/export-debounce.js";
import { timing } from "../services/metrics.js";

const port = Number(process.env.PORT ?? 8787);

if (embeddedDbError) {
  const { serveDegraded } = await import("./degraded.js");
  serveDegraded(embeddedDbError, port);
} else {
  await bootNormally();
}

async function bootNormally() {
  if (isEmbedded) {
    let t = Date.now();
    await ensureIndex();
    timing("boot.ensureIndex", Date.now() - t);
    t = Date.now();
    const { bootstrapped } = await runBootstrap(port);
    timing("boot.bootstrap", Date.now() - t);
    if (bootstrapped) console.log("first run: created owner key -> ~/.vibeops/credentials.json");
    const { reportAndClearRecovery } = await import("../db/recovery.js");
    t = Date.now();
    await reportAndClearRecovery(db).catch((e) => console.warn(`recovery report failed: ${(e as Error).message}`));
    timing("boot.recovery", Date.now() - t);
  }
  await applyEnvSettings();
  await restoreCouncilSessions();
  // Vault indexing is on by default; never blocks or crashes boot.
  void startWatcher().catch((e) => console.warn(`vault watcher failed to start: ${(e as Error).message}`));
  void rescanProjectVaults().catch((e) => console.warn(`project vault watchers failed to start: ${(e as Error).message}`));
  void reapStaleTickets().then(n => { if (n) console.log(`reaper: bounced ${n} stale ticket(s)`); }).catch(() => {});

  const runLogicalExport = isEmbedded
    ? async () => {
        try {
          const { writeBackup } = await import("../services/backup.js");
          const stamp = new Date().toISOString().replace(/[:.]/g, "-");
          const { path, counts } = await writeBackup(stamp);
          console.log(`logical export -> ${path} ${JSON.stringify(counts)}`);
        } catch (e) {
          console.warn(`logical export failed: ${(e as Error).message}`);
        }
      }
    : undefined;
  if (isEmbedded) {
    const { snapshotKnownGood, checkpointEmbedded } = await import("../db/client.js");
    void snapshotKnownGood()
      .then((p) => { if (p) console.log(`known-good snapshot -> ${p}`); })
      .catch((e) => console.warn(`known-good snapshot failed: ${(e as Error).message}`));
    void runLogicalExport!();
    setInterval(() => void runLogicalExport!(), 6 * 60 * 60_000).unref();
    configureExport(runLogicalExport!);
    // Periodic CHECKPOINT reduces WAL replay time after unclean exit; 2-min default, env-tunable.
    const checkpointMs = Number(process.env.VIBEOPS_CHECKPOINT_MS ?? 120_000);
    setInterval(
      () => void checkpointEmbedded().catch((e) => console.warn(`periodic checkpoint failed: ${(e as Error).message}`)),
      checkpointMs,
    ).unref();
  }

  // Mark interrupted runs but do NOT auto-resume: resume is a human action.
  async function handleInterruptedRuns() {
    const ticketIds = await markInterruptedRuns();
    if (ticketIds.length) console.log(`forge: marked ${ticketIds.length} interrupted run(s) — resume is a manual action`);
    const healed = await reconcileMergedTickets();
    if (healed.length) console.log(`forge: reconciled ${healed.length} already-merged ticket(s) to closed`);
  }
  void handleInterruptedRuns().catch(() => {});

  // Sessions auto-ingest on a 30-min interval (opt-out via setting
  // sessions.autoSync="false"; interval via sessions.autoSyncIntervalMs). Serialized
  // with the manual Sync button so the two never double-ingest. Never blocks boot.
  void startSessionAutoSync({ runNow: true })
    .catch((e) => console.warn(`sessions auto-sync failed to start: ${(e as Error).message}`));
  // Embedded (installed desktop) mode is loopback-only; external-Postgres deployments
  // legitimately serve other hosts.
  // overrideGlobalObjects:false — hono's lightweight global Response breaks
  // transformers.js model caching (`response instanceof Response` fails, so the
  // local embedder can never download its model inside the server).
  const server = serve({ fetch: app.fetch, port, hostname: isEmbedded ? "127.0.0.1" : "0.0.0.0", overrideGlobalObjects: false });
  const { installShutdown } = await import("./shutdown.js");
  installShutdown(server, closeDb, isEmbedded, runLogicalExport);
  console.log(`api on :${port}${isEmbedded ? " (embedded db)" : ""}`);
}
