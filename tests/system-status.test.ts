import { expect, test, vi } from "vitest";
import { app } from "../src/api/app.js";
import { createActor } from "../src/services/actors.js";
import { setSetting } from "../src/services/settings.js";
import { db } from "../src/db/client.js";
import { settings } from "../src/db/schema.js";
import { eq } from "drizzle-orm";

process.env.EMBED_PROVIDER = "fake";

import { expect, test } from "vitest";
import { app } from "../src/api/app.js";
import { createActor } from "../src/services/actors.js";

process.env.EMBED_PROVIDER = "fake";

test("GET /system/status returns 200 with new shape for admin, 403 for member", async () => {
  const { apiKey: memberKey } = await createActor({ name: "status-test-member", kind: "human", role: "member" });
  let res = await app.request("/system/status", { headers: { Authorization: `Bearer ${memberKey}` } });
  expect(res.status).toBe(403);

  const { apiKey: adminKey } = await createActor({ name: "status-test-admin", kind: "human", role: "admin" });
  res = await app.request("/system/status", { headers: { Authorization: `Bearer ${adminKey}` } });
  expect(res.status).toBe(200);
  
  const body = await res.json();
  expect(body.db).toBeDefined();
  expect(body.embedder).toBeDefined();
  expect(body.watcher).toBeDefined();
  expect(body.activeRuns).toBeTypeOf("number");
  expect(body.uptimeMs).toBeTypeOf("number");
});
