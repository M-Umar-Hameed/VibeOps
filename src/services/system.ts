import os from "os";
import { db } from "../db/client.js";
import { aiUsageLogs, agentSessions, tickets } from "../db/schema.js";
import { sql, eq, isNotNull, desc } from "drizzle-orm";

import { getEmbedder } from "../knowledge/embedder.js";
import { getVaultStatus } from "../ingest/watch.js";

import { listRuns, listRunsWithHistory } from "../forge/runs.js";


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

const BOOT_TIME = new Date().toISOString();

export async function getSystemLogs() {
  const logs: { at: string; level: string; message: string }[] = [];
  logs.push({ at: BOOT_TIME, level: "info", message: "Server booted" });
  
  try {
    const runs = await listRunsWithHistory();
    for (const r of runs.slice(0, 20)) {
      logs.push({
        at: r.startedAt,
        level: "info",
        message: `Forge run ${r.id.substring(0, 8)} started (ticket: ${r.ticketId}, stage: ${r.stage})`
      });
      if (r.finishedAt) {
        logs.push({
          at: r.finishedAt,
          level: r.status === "failed" ? "error" : r.status === "interrupted" ? "warn" : "info",
          message: `Forge run ${r.id.substring(0, 8)} settled (ticket: ${r.ticketId}, status: ${r.status})`
        });
      }
    }
  } catch (e) {
    // Ignore error if runs cannot be listed
  }
  
  return logs.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 50);
}

// perTicketLimit widened only by tests: fixture tickets can never crack the
// real top-10 in the shared accumulating DB.
export async function getAiUsage(perTicketLimit = 10) {
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
  
  const perTicket = await db.select({
    ticketId: aiUsageLogs.ticketId,
    title: sql<string>`coalesce(${tickets.title}, cast(${aiUsageLogs.ticketId} as text))`,
    tokens: sql<number>`cast(sum(${aiUsageLogs.tokens}) as integer)`,
    calls: sql<number>`cast(count(*) as integer)`
  })
  .from(aiUsageLogs)
  .leftJoin(tickets, eq(aiUsageLogs.ticketId, tickets.id))
  .where(isNotNull(aiUsageLogs.ticketId))
  .groupBy(aiUsageLogs.ticketId, tickets.title)
  .orderBy(desc(sql`sum(${aiUsageLogs.tokens})`))
  .limit(perTicketLimit);

  const totalCost = usageStats.reduce((acc, curr) => acc + ((curr.cost || 0) / 1e6), 0);
  const totalTokens = usageStats.reduce((acc, curr) => acc + Number(curr.tokens || 0), 0);

  return {
    overview: {
      totalTokens,
      totalCost,
      activeStrategy: "Cost-Optimized"
    },
    usage: usageStats,
    agents: agentStats,
    perTicket
  };
}

export async function getSystemStatus() {
  let dbStatus = "ok";
  try {
    await db.execute(sql`select 1`);
  } catch (e) {
    dbStatus = "error";
  }

  let embedderName = "unknown";
  try {
    embedderName = getEmbedder().model;
  } catch (e) {}

  let watcherState = { status: "stopped", indexed: 0 };
  try {
    const v = await getVaultStatus();
    watcherState = {
      status: v.isRunning ? "running" : "stopped",
      indexed: v.indexedCount ?? 0,
    };
  } catch (e) {}

  let activeRuns = 0;
  try {
    activeRuns = listRuns().filter((r) => r.status === "running").length;
  } catch (e) {}

  const uptimeMs = process.uptime() * 1000;

  return {
    db: dbStatus,
    embedder: embedderName,
    watcher: watcherState,
    activeRuns,
    uptimeMs
  };
}
