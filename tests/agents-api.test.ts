import { expect, test } from "vitest";
import { createActor } from "../src/services/actors.js";
import { app } from "../src/api/app.js";

function uniq(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

test("GET /system/agents: admin-gated, returns agents summary", async () => {
  const { apiKey: adminKey } = await createActor({ name: uniq("agents-admin"), kind: "human", role: "admin" });
  const { apiKey: memberKey } = await createActor({ name: uniq("agents-member"), kind: "agent" });
  const adminH = { Authorization: `Bearer ${adminKey}` };
  const memberH = { Authorization: `Bearer ${memberKey}` };

  const memberRes = await app.request("/system/agents", { headers: memberH });
  expect(memberRes.status).toBe(403);
  expect(await memberRes.json()).toEqual({ error: "forbidden" });

  const adminRes = await app.request("/system/agents", { headers: adminH });
  expect(adminRes.status).toBe(200);
  const body = await adminRes.json();
  expect(body.sinceDays).toBe(7);
  expect(Array.isArray(body.agents)).toBe(true);
  expect(body.agents.map((a: { agent: string }) => a.agent).sort()).toEqual(["antigravity", "claude", "codex"]);

  const noAuthRes = await app.request("/system/agents");
  expect(noAuthRes.status).toBe(401);
});
