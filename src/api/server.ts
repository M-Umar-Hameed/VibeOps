import { serve } from "@hono/node-server";
import { app } from "./app.js";
import { isEmbedded } from "../db/client.js";
import { runBootstrap } from "../bootstrap.js";
import { ensureIndex } from "../db/vector-setup.js";
import { applyEnvSettings } from "../services/settings.js";

const port = Number(process.env.PORT ?? 8787);
if (isEmbedded) {
  await ensureIndex();
  const { bootstrapped } = await runBootstrap(port);
  if (bootstrapped) console.log("first run: created Inbox project + owner key -> ~/.vibeops/credentials.json");
}
await applyEnvSettings();
// Embedded (installed desktop) mode is loopback-only; external-Postgres deployments
// legitimately serve other hosts.
// overrideGlobalObjects:false — hono's lightweight global Response breaks
// transformers.js model caching (`response instanceof Response` fails, so the
// local embedder can never download its model inside the server).
serve({ fetch: app.fetch, port, hostname: isEmbedded ? "127.0.0.1" : "0.0.0.0", overrideGlobalObjects: false });
console.log(`api on :${port}${isEmbedded ? " (embedded db)" : ""}`);
