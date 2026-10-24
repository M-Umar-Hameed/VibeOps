import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import type { Hono } from "hono";
import { desc, isNotNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { forgeRuns } from "../db/schema.js";
import type { Actor } from "../db/schema.js";
import { loadRelayConfig, validateRelayConfig } from "../relay/config.js";
import type { RelayAccount } from "../relay/config.js";
import { relayConfigPath, writeRelayConfig } from "../relay/bootstrap-config.js";
import { ACCOUNT_ENV, laneKind } from "../relay/accounts.js";
import { readAccountState } from "../relay/account-state.js";
import { accountRunStats, canCheckLogin, checkLogin, copyClaudeSettings, defaultAccountDir, insideAccountsRoot, loginCommand } from "../relay/accounts-admin.js";
import { hasAnyActiveRun } from "../forge/runs.js";
import { requireAdmin } from "./auth.js";

type AppEnv = { Variables: { actor: Actor } };
const RUNS_ACTIVE = "wait until runs finish";
// ponytail: stats cover the newest 500 runs; a per-account counter table is the upgrade path.
const STATS_ROW_LIMIT = 500;
const own = (o: unknown, k: string) => !!o && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k);
const claudeKind = (k: string) => k === "claude" || k === "claude-sdk";

// relay.json as written, so a save keeps every field the user put there.
function readRaw(): { cfg: Record<string, any> } | { error: string; status: 404 | 500 } {
  let raw: string;
  try { raw = readFileSync(relayConfigPath(), "utf-8"); } catch { return { error: "relay.json not found", status: 404 }; }
  try { return { cfg: JSON.parse(raw) }; } catch { return { error: "invalid relay.json", status: 500 }; }
}

function save(cfg: unknown): string | null {
  try { writeRelayConfig(cfg); return null; } catch (e) { return (e as Error).message; }
}

export function registerRelayAccountsRoutes(app: Hono<AppEnv>): void {
  app.get("/relay/accounts", requireAdmin, async (c) => {
    if (!existsSync(relayConfigPath())) return c.json({ runsActive: hasAnyActiveRun(), lanes: [] });
    let config;
    try { config = loadRelayConfig(relayConfigPath()); } catch (e) { return c.json({ error: (e as Error).message }, 400); }
    const rows = await db.select({
      id: forgeRuns.id, startedAt: forgeRuns.startedAt, planAgent: forgeRuns.planAgent,
      workAgent: forgeRuns.workAgent, reviewAgent: forgeRuns.reviewAgent, accounts: forgeRuns.accounts,
    }).from(forgeRuns).where(isNotNull(forgeRuns.accounts)).orderBy(desc(forgeRuns.startedAt)).limit(STATS_ROW_LIMIT);
    const { perAccount, recent } = accountRunStats(rows);
    const lanes = [];
    for (const [name, agent] of Object.entries(config.agents)) {
      const kind = laneKind(agent);
      if (!kind || !ACCOUNT_ENV[kind]) continue;
      const accounts = [];
      for (const a of [...(agent.accounts ?? [])].sort((x, y) => x.priority - y.priority)) {
        const stats = perAccount.get(`${name}\u0000${a.id}`);
        accounts.push({ ...a, state: await readAccountState(a.configDir), runs: stats?.runs ?? 0, lastRunAt: stats?.lastRunAt ?? null, login: loginCommand(kind, a.configDir) });
      }
      lanes.push({ agent: name, kind, canCheckLogin: canCheckLogin(kind), copiesClaudeSettings: claudeKind(kind), accounts, recent: recent.get(name) ?? [] });
    }
    return c.json({ runsActive: hasAnyActiveRun(), lanes });
  });

  app.post("/relay/agents/:name/accounts", requireAdmin, async (c) => {
    if (hasAnyActiveRun()) return c.json({ error: RUNS_ACTIVE }, 409);
    const name = c.req.param("name");
    const { label, configDir, copySettings } = await c.req.json().catch(() => ({}));
    if (typeof label !== "string" || !label.trim() || label.length > 80) return c.json({ error: "label must be 1-80 characters" }, 400);
    if (configDir !== undefined && (typeof configDir !== "string" || !isAbsolute(configDir))) return c.json({ error: "configDir must be an absolute path" }, 400);
    if (copySettings !== undefined && typeof copySettings !== "boolean") return c.json({ error: "copySettings must be a boolean" }, 400);
    const r = readRaw();
    if ("error" in r) return c.json({ error: r.error }, r.status);
    if (!own(r.cfg.agents, name)) return c.json({ error: "agent not found" }, 404);
    const lane = r.cfg.agents[name];
    const kind = laneKind(lane) ?? "";
    if (!ACCOUNT_ENV[kind]) return c.json({ error: `accounts are not supported for agent "${name}"` }, 400);
    const id = `acct-${randomUUID().slice(0, 8)}`;
    const existing: RelayAccount[] = lane.accounts ?? [];
    const account: RelayAccount = { id, label: label.trim(), configDir: configDir ?? defaultAccountDir(name, id), priority: Math.max(0, ...existing.map((a) => a.priority)) + 1 };
    lane.accounts = [...existing, account];
    // Validate before touching the disk: a refused configDir must not leave a folder behind.
    try { validateRelayConfig(r.cfg, relayConfigPath()); } catch (e) { return c.json({ error: (e as Error).message }, 400); }
    mkdirSync(account.configDir, { recursive: true });
    const copied = copySettings === true && claudeKind(kind) ? copyClaudeSettings(account.configDir) : [];
    const err = save(r.cfg);
    if (err) return c.json({ error: err }, 400);
    return c.json({ account, copied, login: loginCommand(kind, account.configDir) }, 201);
  });

  app.put("/relay/agents/:name/accounts/order", requireAdmin, async (c) => {
    if (hasAnyActiveRun()) return c.json({ error: RUNS_ACTIVE }, 409);
    const name = c.req.param("name");
    const { ids } = await c.req.json().catch(() => ({}));
    if (!Array.isArray(ids) || !ids.every((x) => typeof x === "string")) return c.json({ error: "ids must be an array of account ids" }, 400);
    const r = readRaw();
    if ("error" in r) return c.json({ error: r.error }, r.status);
    if (!own(r.cfg.agents, name)) return c.json({ error: "agent not found" }, 404);
    const accounts: RelayAccount[] = r.cfg.agents[name].accounts ?? [];
    if (ids.length !== accounts.length || new Set(ids).size !== ids.length || !accounts.every((a) => ids.includes(a.id))) {
      return c.json({ error: "ids must list every account of the lane once" }, 400);
    }
    r.cfg.agents[name].accounts = ids.map((id: string, i: number) => ({ ...accounts.find((a) => a.id === id)!, priority: i + 1 }));
    const err = save(r.cfg);
    if (err) return c.json({ error: err }, 400);
    return c.json({ accounts: r.cfg.agents[name].accounts });
  });

  app.patch("/relay/agents/:name/accounts/:id", requireAdmin, async (c) => {
    if (hasAnyActiveRun()) return c.json({ error: RUNS_ACTIVE }, 409);
    const name = c.req.param("name");
    const { label, disabled, ...extra } = await c.req.json().catch(() => ({}));
    if (Object.keys(extra).length > 0) return c.json({ error: "extra fields not allowed" }, 400);
    if (label !== undefined && (typeof label !== "string" || !label.trim() || label.length > 80)) return c.json({ error: "label must be 1-80 characters" }, 400);
    if (disabled !== undefined && typeof disabled !== "boolean") return c.json({ error: "disabled must be a boolean" }, 400);
    const r = readRaw();
    if ("error" in r) return c.json({ error: r.error }, r.status);
    if (!own(r.cfg.agents, name)) return c.json({ error: "agent not found" }, 404);
    const acct = (r.cfg.agents[name].accounts ?? []).find((a: RelayAccount) => a.id === c.req.param("id"));
    if (!acct) return c.json({ error: "account not found" }, 404);
    if (label !== undefined) acct.label = label.trim();
    if (disabled !== undefined) acct.disabled = disabled;
    const err = save(r.cfg);
    if (err) return c.json({ error: err }, 400);
    return c.json({ account: acct });
  });

  app.delete("/relay/agents/:name/accounts/:id", requireAdmin, async (c) => {
    if (hasAnyActiveRun()) return c.json({ error: RUNS_ACTIVE }, 409);
    const name = c.req.param("name");
    const id = c.req.param("id");
    const { deleteFolder } = await c.req.json().catch(() => ({}));
    const r = readRaw();
    if ("error" in r) return c.json({ error: r.error }, r.status);
    if (!own(r.cfg.agents, name)) return c.json({ error: "agent not found" }, 404);
    const lane = r.cfg.agents[name];
    const accounts: RelayAccount[] = lane.accounts ?? [];
    const acct = accounts.find((a) => a.id === id);
    if (!acct) return c.json({ error: "account not found" }, 404);
    if (deleteFolder === true && !insideAccountsRoot(acct.configDir)) {
      return c.json({ error: "only folders under ~/.vibeops/accounts are deleted here; delete this folder by hand" }, 400);
    }
    const rest = accounts.filter((a) => a.id !== id);
    // config.ts rejects an empty accounts array: the last removal drops the key.
    if (rest.length) lane.accounts = rest; else delete lane.accounts;
    const err = save(r.cfg);
    if (err) return c.json({ error: err }, 400);
    if (deleteFolder === true) rmSync(acct.configDir, { recursive: true, force: true });
    return c.json({ removed: id, folderDeleted: deleteFolder === true });
  });

  // Writes only the DB account state, never relay.json: allowed while runs are active.
  app.post("/relay/agents/:name/accounts/:id/check", requireAdmin, async (c) => {
    const name = c.req.param("name");
    let config;
    try { config = loadRelayConfig(relayConfigPath()); } catch (e) { return c.json({ error: (e as Error).message }, 400); }
    if (!own(config.agents, name)) return c.json({ error: "agent not found" }, 404);
    const agent = config.agents[name];
    const acct = agent.accounts?.find((a) => a.id === c.req.param("id"));
    if (!acct) return c.json({ error: "account not found" }, 404);
    const kind = laneKind(agent);
    if (!canCheckLogin(kind)) return c.json({ error: `login check is not available for lane kind "${kind}"` }, 400);
    return c.json(await checkLogin(agent, acct));
  });
}
