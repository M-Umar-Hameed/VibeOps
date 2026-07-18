import os from "os";
import { db } from "../db/client.js";
import { aiUsageLogs, agentSessions } from "../db/schema.js";
import { sql } from "drizzle-orm";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { forgeRuns } from "../db/schema.js";
import { getEmbedder } from "../knowledge/embedder.js";
import { getVaultStatus } from "../ingest/watch.js";
import { getSetting } from "./settings.js";
import { loadRelayConfig } from "../relay/config.js";
import { listRuns } from "../forge/runs.js";
import { listMarketplaces } from "../skills/marketplace.js";

type ComponentStatus = { name: string; status: "up" | "down" | "off" | "unknown"; detail: string };

export async function getSystemMetrics() {
  const uptime = os.uptime();
  const totalmem = os.totalmem();
  const freemem = os.freemem();
  const memoryUsed = totalmem === 0 ? 0 : Math.round(((totalmem - freemem) / totalmem) * 100);
  
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    for (const type in cpu.times) {
      total += cpu.times[type as keyof typeof cpu.times];
    }
    idle += cpu.times.idle;
  }
  const cpuLoad = total === 0 ? 0 : Math.round(((total - idle) / total) * 100);
  
  return {
    uptime: Number((uptime / 3600).toFixed(1)),
    ping: 0,
    clusterHealth: 100,
    cpuLoad,
    memoryUsed,
    ioWait: 0
  };
}

export async function getSystemTopology() {
  return {
    nodes: 1,
    regions: [os.hostname().substring(0, 3).toUpperCase() || "LOC"]
  };
}

export async function getSystemLogs() {
  return [];
}

export async function getAiUsage() {
  const usageStats = await db.select({
    provider: aiUsageLogs.provider,
    model: aiUsageLogs.model,
    tokens: sql<number>`cast(sum(${aiUsageLogs.tokens}) as integer)`,
    cost: sql<number>`cast(sum(${aiUsageLogs.cost}) as integer)`
  }).from(aiUsageLogs).groupBy(aiUsageLogs.provider, aiUsageLogs.model);

  const agentStats = await db.select({
    agentName: agentSessions.agentName,
    status: agentSessions.status,
    count: sql<number>`cast(count(*) as integer)`
  }).from(agentSessions).groupBy(agentSessions.agentName, agentSessions.status);
  
  const totalCost = usageStats.reduce((acc, curr) => acc + ((curr.cost || 0) / 1e6), 0);
  const totalTokens = usageStats.reduce((acc, curr) => acc + Number(curr.tokens || 0), 0);

  return {
    overview: {
      totalTokens,
      totalCost,
      activeStrategy: "Cost-Optimized"
    },
    usage: usageStats,
    agents: agentStats
  };
}

export async function getSystemStatus(): Promise<{ components: ComponentStatus[] }> {
  const components: ComponentStatus[] = [];

  try {
    await db.execute(sql`select 1`);
    components.push({ name: "database", status: "up", detail: "" });
  } catch (e) {
    components.push({ name: "database", status: "down", detail: (e as Error).message });
  }

  try {
    const e = getEmbedder();
    components.push({ name: "embedder", status: "up", detail: `${e.model} (${e.dim}d)` });
  } catch (e) {
    components.push({ name: "embedder", status: "down", detail: (e as Error).message });
  }

  try {
    const v = await getVaultStatus();
    components.push({
      name: "vault watcher",
      status: v.isRunning ? "up" : "off",
      detail: v.isRunning ? v.vaultPath : "stopped",
    });
  } catch (e) {
    components.push({ name: "vault watcher", status: "down", detail: (e as Error).message });
  }

  try {
    const off = (await getSetting("sessions.autoSync")) === "false";
    components.push({ name: "sessions auto-sync", status: off ? "off" : "up", detail: "6h interval" });
  } catch (e) {
    components.push({ name: "sessions auto-sync", status: "down", detail: (e as Error).message });
  }

  try {
    const config = loadRelayConfig(process.env.VIBEOPS_RELAY_CONFIG);
    for (const [name, agent] of Object.entries(config.agents)) {
      const bin = agent.cmd[0];
      if (isAbsolute(bin)) {
        const up = existsSync(bin);
        components.push({ name: `agent ${name}`, status: up ? "up" : "down", detail: up ? "found" : "not found" });
      } else {
        components.push({ name: `agent ${name}`, status: "unknown", detail: "resolved via PATH" });
      }
    }
  } catch (e) {
    components.push({ name: "relay config", status: "down", detail: (e as Error).message });
  }

  try {
    const [row] = await db.select({ count: sql<number>`cast(count(*) as int)` }).from(forgeRuns);
    const active = listRuns().filter((r) => r.status === "running").length;
    components.push({ name: "forge", status: "up", detail: `${active} active, ${row?.count ?? 0} total runs` });
  } catch (e) {
    components.push({ name: "forge", status: "down", detail: (e as Error).message });
  }

  try {
    const n = (await listMarketplaces()).length;
    components.push({ name: "marketplaces", status: "up", detail: n === 0 ? "none added" : `${n} added` });
  } catch (e) {
    components.push({ name: "marketplaces", status: "down", detail: (e as Error).message });
  }

  const CONNECTORS: { name: string; key: string }[] = [
    { name: "connector github", key: "github.token" },
    { name: "connector gitlab", key: "gitlab.token" },
    { name: "connector jira", key: "jira.apiToken" },
    { name: "connector asana", key: "asana.pat" },
  ];
  for (const c of CONNECTORS) {
    try {
      const v = await getSetting(c.key);
      components.push({ name: c.name, status: v ? "up" : "off", detail: v ? "configured" : "not configured" });
    } catch (e) {
      components.push({ name: c.name, status: "down", detail: (e as Error).message });
    }
  }

  return { components };
}
