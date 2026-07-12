import os from "os";
import { db } from "../db/client.js";
import { aiUsageLogs, agentSessions } from "../db/schema.js";
import { sql } from "drizzle-orm";

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
