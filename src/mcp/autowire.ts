import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadRelayConfig } from "../relay/config.js";
import { writeRelayConfig } from "../relay/bootstrap-config.js";
import { mcpRegistration, binBasename, PROBE_TIMEOUT_MS } from "../relay/doctor.js";
import { winCommand } from "../relay/win-bin.js";
import { installClientConfig, clientEntryCurrent } from "./clients.js";
import { createActor } from "../services/actors.js";
import { getSetting, setSetting } from "../services/settings.js";

const execFileAsync = promisify(execFile);

// never let a lane's bearer key (or any bearer-looking token) escape into a
// failure message that gets logged or returned in an API response.
function redact(msg: string, key?: string): string {
  const scrubbed = key ? msg.split(key).join("<key>") : msg;
  return scrubbed.replace(/Bearer\s+\S+/g, "Bearer <key>");
}

// Registers the vibeops MCP server into every detected CLI lane's own config,
// so a CLI lane gets browser/knowledge tools without the user running
// anything. Never throws -- one broken CLI (or a missing/unparseable
// relay.json) must not stop the others or block server startup.
//
// ponytail: two known ceilings, both narrowed to kimi only. agy/gemini/claude
// are file-based: their entries are read back and compared (clientEntryCurrent)
// and installed by writing the file directly, never a child process. (1) kimi's
// registration is checked by server NAME only ("vibeops"); kimi's config file
// path isn't known, so a stale or revoked key still reports registered with no
// self-heal. (2) kimi's `mcp add` bearer token appears on the child process's
// command line -- that's the CLI's own surface, not something this code
// controls.
export async function ensureMcpWiring(opts: { homeDir?: string } = {}): Promise<{
  wired: string[];
  failed: { name: string; error: string }[];
}> {
  let config;
  try {
    config = loadRelayConfig(process.env.VIBEOPS_RELAY_CONFIG);
  } catch {
    return { wired: [], failed: [] };
  }

  const url = `http://127.0.0.1:${process.env.PORT ?? 8787}/mcp`;
  const wired: string[] = [];
  const failed: { name: string; error: string }[] = [];
  const needsFlag = new Set<string>();

  // ponytail: one shared bearer key for every CLI lane, stored in plaintext in
  // the settings table. The actors table only keeps a hash, and the key ends up
  // written in plaintext into each CLI's own config file anyway, so a shared
  // setting costs nothing extra. Per-lane actors (individually revocable) are
  // the upgrade path if that's ever wanted.
  let key: Promise<string> | undefined;
  const laneKey = (): Promise<string> => {
    if (!key) {
      key = (async () => {
        const saved = await getSetting("mcp.laneKey");
        if (saved) return saved;
        const { apiKey } = await createActor({ name: "mcp-lanes", kind: "agent" });
        await setSetting("mcp.laneKey", apiKey);
        return apiKey;
      })();
    }
    return key;
  };

  for (const [name, agent] of Object.entries(config.agents)) {
    if (agent.mcp === false) continue; // explicit opt-out -- never wire, never flag
    if (agent.type === "sdk" || agent.type === "http") continue;
    try {
      const reg = await mcpRegistration(config, name, { homeDir: opts.homeDir, fresh: true });
      if (reg === undefined) continue; // uncheckable CLI basename -- never guess
      const bin = binBasename(agent.cmd[0]);
      let needsInstall = !reg.registered;

      // File-based clients can be read back and compared against the entry we'd
      // write. A drifted url/key (rotated, revoked, port moved) means the
      // name-only "registered" check above is stale -- treat it as unregistered
      // and fall through to reinstall. No stored key means the lane was
      // hand-registered (by the user or a different install); leave it alone.
      if (!needsInstall && (bin === "agy" || bin === "gemini" || bin === "claude")) {
        const stored = await getSetting("mcp.laneKey");
        if (stored && !clientEntryCurrent(bin, url, stored, opts.homeDir)) needsInstall = true;
      }

      if (!needsInstall) {
        if (agent.mcp !== true) needsFlag.add(name);
        continue;
      }

      if (bin === "agy" || bin === "gemini" || bin === "claude") {
        installClientConfig(bin, url, await laneKey(), opts.homeDir);
      } else if (bin === "kimi") {
        // User-scoped: `kimi mcp add` defaults to a cwd-keyed "local" scope,
        // which `kimi mcp list` from a different cwd then reports missing.
        const args = [
          "mcp", "add", "-s", "user", "--transport", "http", "vibeops", url,
          "--header", `Authorization: Bearer ${await laneKey()}`,
        ];
        const { file, args: winArgs, verbatim } = winCommand(agent.cmd[0], args);
        try {
          await execFileAsync(file, winArgs, { timeout: PROBE_TIMEOUT_MS, windowsHide: true, windowsVerbatimArguments: verbatim });
        } catch {
          // never surface the original message -- it contains the bearer token
          throw new Error(`${bin} mcp add failed`);
        }
      }
      // Re-check with fresh:true: it both overwrites the stale {registered:false}
      // the pre-install check cached and confirms the write actually landed.
      const after = await mcpRegistration(config, name, { homeDir: opts.homeDir, fresh: true });
      if (!after?.registered) {
        failed.push({ name, error: "install reported success but the CLI still shows no vibeops server" });
        continue;
      }
      wired.push(name);
      needsFlag.add(name);
    } catch (e) {
      const resolvedKey = key ? await key.catch(() => undefined) : undefined;
      failed.push({ name, error: redact((e as Error).message, resolvedKey) });
    }
  }

  if (needsFlag.size) {
    try {
      const fresh = loadRelayConfig(process.env.VIBEOPS_RELAY_CONFIG);
      for (const name of needsFlag) {
        if (fresh.agents[name]) fresh.agents[name].mcp = true;
      }
      writeRelayConfig(fresh);
    } catch (e) {
      failed.push({ name: "relay.json", error: (e as Error).message });
    }
  }

  return { wired, failed };
}
