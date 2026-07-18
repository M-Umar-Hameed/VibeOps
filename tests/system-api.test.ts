import { expect, test, vi } from "vitest";
import { createActor } from "../src/services/actors.js";
import { app } from "../src/api/app.js";

vi.mock("../src/forge/runs.js", () => ({
  listRuns: () => [],
  listRunsWithHistory: async () => [
    {
      id: "fake-run-123456",
      ticketId: "t1",
      status: "passed",
      stage: "review",
      agents: { plan: "a", work: "b", review: "c" },
      startedAt: new Date("2026-07-18T10:00:00Z").toISOString(),
      finishedAt: new Date("2026-07-18T10:05:00Z").toISOString()
    }
  ]
}));

test("REST: retrieve system endpoints", async () => {
  const { apiKey } = await createActor({ name: "sys", kind: "human", role: "admin" });
  const h = { Authorization: `Bearer ${apiKey}` };

  let res = await app.request("/system/metrics", { headers: h });
  expect(res.status).toBe(200);
  let data = await res.json();
  expect(typeof data.uptime).toBe("number");
  expect(typeof data.cpuLoad).toBe("number");
  expect(typeof data.memoryUsed).toBe("number");

  res = await app.request("/system/topology", { headers: h });
  expect(res.status).toBe(200);
  data = await res.json();
  expect(data.nodes).toBe(1);
  expect(Array.isArray(data.regions)).toBe(true);

  res = await app.request("/system/logs", { headers: h });
  expect(res.status).toBe(200);
  data = await res.json();
  expect(Array.isArray(data)).toBe(true);
  
  // Verify derived rows
  const bootLog = data.find((l: any) => l.message === "Server booted");
  expect(bootLog).toBeDefined();
  
  const startLog = data.find((l: any) => l.message.includes("Forge run fake-run started"));
  expect(startLog).toBeDefined();
  expect(startLog.level).toBe("info");

  const settleLog = data.find((l: any) => l.message.includes("Forge run fake-run settled"));
  expect(settleLog).toBeDefined();
  expect(settleLog.level).toBe("info");
});
