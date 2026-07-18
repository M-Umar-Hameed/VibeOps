import { expect, test, vi } from "vitest";
import { app } from "../src/api/app.js";
import { createActor } from "../src/services/actors.js";
import { setSetting } from "../src/services/settings.js";
import { db } from "../src/db/client.js";
import { settings } from "../src/db/schema.js";
import { eq } from "drizzle-orm";

process.env.EMBED_PROVIDER = "fake";

test("GET /system/status returns 200 with component array", async () => {
  const { apiKey } = await createActor({ name: "status-test-1", kind: "human", role: "member" });
  const headers = { Authorization: `Bearer ${apiKey}` };

  const res = await app.request("/system/status", { headers });
  expect(res.status).toBe(200);
  
  const body = await res.json();
  expect(Array.isArray(body.components)).toBe(true);

  const dbComponent = body.components.find((c: any) => c.name === "database");
  expect(dbComponent).toBeDefined();
  expect(dbComponent.status).toBe("up");

  const embedderComponent = body.components.find((c: any) => c.name === "embedder");
  expect(embedderComponent).toBeDefined();
  expect(embedderComponent.status).toBe("up");
});

test("GET /system/status connector flips off/on", async () => {
  const { apiKey } = await createActor({ name: "status-test-2", kind: "human", role: "member" });
  const headers = { Authorization: `Bearer ${apiKey}` };

  // Explicitly clear to guarantee "off" initially
  await db.delete(settings).where(eq(settings.key, "github.token"));

  let res = await app.request("/system/status", { headers });
  let body = await res.json();
  let gh = body.components.find((c: any) => c.name === "connector github");
  expect(gh.status).toBe("off");
  expect(gh.detail).toBe("not configured");

  await setSetting("github.token", "secret_test_token_123");
  try {
    res = await app.request("/system/status", { headers });
    body = await res.json();
    gh = body.components.find((c: any) => c.name === "connector github");
    expect(gh.status).toBe("up");
    expect(gh.detail).toBe("configured");

    const textRes = JSON.stringify(body);
    expect(textRes).not.toContain("secret_test_token_123");
  } finally {
    await db.delete(settings).where(eq(settings.key, "github.token"));
  }
});

test("GET /system/status handles missing relay config cleanly", async () => {
  const { apiKey } = await createActor({ name: "status-test-3", kind: "human", role: "member" });
  const headers = { Authorization: `Bearer ${apiKey}` };

  const oldConfig = process.env.VIBEOPS_RELAY_CONFIG;
  process.env.VIBEOPS_RELAY_CONFIG = "/nonexistent/relay.json";
  try {
    const res = await app.request("/system/status", { headers });
    expect(res.status).toBe(200);

    const body = await res.json();
    const rc = body.components.find((c: any) => c.name === "relay config");
    expect(rc).toBeDefined();
    expect(rc.status).toBe("down");
  } finally {
    if (oldConfig === undefined) {
      delete process.env.VIBEOPS_RELAY_CONFIG;
    } else {
      process.env.VIBEOPS_RELAY_CONFIG = oldConfig;
    }
  }
});
