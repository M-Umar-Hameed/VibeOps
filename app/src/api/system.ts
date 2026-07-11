import { apiFetch } from "./client.js";

export type SystemMetrics = {
  uptime: number; // in hours
  ping: number; // in ms
  clusterHealth: number; // percentage
  cpuLoad: number; // percentage
  memoryUsed: number; // percentage
  ioWait: number; // in ms
};

export type SystemLog = {
  time: string;
  level: string;
  msg: string;
};

export type SystemTopology = {
  nodes: number;
  regions: string[];
};

export const system = {
  getMetrics: () => apiFetch("/system/metrics", {}) as Promise<SystemMetrics>,
  getLogs: () => apiFetch("/system/logs", {}) as Promise<SystemLog[]>,
  getTopology: () => apiFetch("/system/topology", {}) as Promise<SystemTopology>
};
