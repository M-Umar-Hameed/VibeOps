import { expect, test } from "vitest";
import { createActor } from "../src/services/actors.js";
import { app } from "../src/api/app.js";

test("REST: retrieve system endpoints", async () => {
  const { apiKey } = await createActor({ name: "sys", kind: "human" });
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
});
