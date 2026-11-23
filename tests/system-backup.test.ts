import { expect, test } from "vitest";
import { join } from "node:path";
import { app } from "../src/api/app.js";
import { createActor } from "../src/services/actors.js";
import { vibeopsHome } from "../src/runtime/home.js";
import { withSetting } from "./helpers/settings.js";

process.env.EMBED_PROVIDER = "fake";

test("GET /system/backup: 403 for member, status shape for admin", async () => {
  const { apiKey: memberKey } = await createActor({ name: "backup-test-member", kind: "human", role: "member" });
  let res = await app.request("/system/backup", { headers: { Authorization: `Bearer ${memberKey}` } });
  expect(res.status).toBe(403);

  const { apiKey: adminKey } = await createActor({ name: "backup-test-admin", kind: "human", role: "admin" });
  const headers = { Authorization: `Bearer ${adminKey}` };
  res = await app.request("/system/backup", { headers });
  expect(res.status).toBe(200);
  const body = await res.json();
  for (const k of ["offsiteDir", "sameVolume", "lastLocalExport", "lastOffsiteExport", "lastOffsiteSnapshot"]) {
    expect(body).toHaveProperty(k);
  }
  expect(typeof body.sameVolume).toBe("boolean");

  await withSetting("backup.offsiteDir", join(vibeopsHome(), ".vibeops", "x"), async () => {
    const b = await (await app.request("/system/backup", { headers })).json();
    expect(b.offsiteDir).toBeNull();
    expect(typeof b.offsiteError).toBe("string");
  });
});
