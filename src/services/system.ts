import os from "os";

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
