import { describe, it, expect, vi, afterEach } from "vitest";
import { app } from "../src/api/app.js";
import { createActor } from "../src/services/actors.js";
import { createProject, setProjectSetting } from "../src/services/projects.js";
import { setSetting } from "../src/services/settings.js";

function uniq(p: string) { return `${p}-${Date.now()}-${Math.random().toString(36).slice(2)}`; }
async function adminHeaders() {
  const { apiKey } = await createActor({ name: uniq("sync-admin"), kind: "human", role: "admin" });
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
}
// Response-shaped stub matching connector usage (ok/status/statusText/headers.get/json).
function makeFetch(responses: any[]) {
  let i = 0;
  return vi.fn(async () => {
    const r = responses[i++];
    if (!r) throw new Error("Unexpected fetch call");
    return { ok: r.ok ?? true, status: r.status ?? 200, statusText: r.statusText ?? "OK",
      headers: new Headers(r.headers ?? {}), json: async () => r.data };
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("POST /sync/:projectId", () => {
  it("runs the bound connector, creates tickets, returns summary", async () => {
    const h = await adminHeaders();
    const project = await createProject({ key: uniq("sync-proj"), name: "S" });
    await setSetting("github.token", "t");                 // global credential (real row)
    await setProjectSetting(project.id, "github.repo", uniq("repo") + "/widgets"); // real binding

    vi.stubGlobal("fetch", makeFetch([
      { data: [{ number: 1, title: "Issue 1", body: "b", state: "open", updated_at: "2026-01-01T00:00:00Z" }] },
      { data: [] }, // comments for issue 1
    ]));

    const res = await app.request(`/sync/${project.id}`, { method: "POST", headers: h });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ created: 1, updated: 0, skipped: 0, commentsAdded: 0, failed: 0, bindings: 1 });
  });

  it("returns empty summary when project has no bindings", async () => {
    const h = await adminHeaders();
    const project = await createProject({ key: uniq("sync-empty"), name: "E" });
    const res = await app.request(`/sync/${project.id}`, { method: "POST", headers: h });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ created: 0, bindings: 0 });
  });

  it("requires admin", async () => {
    const { apiKey } = await createActor({ name: uniq("sync-member"), kind: "human", role: "member" });
    const project = await createProject({ key: uniq("sync-403"), name: "F" });
    const res = await app.request(`/sync/${project.id}`, {
      method: "POST", headers: { Authorization: `Bearer ${apiKey}` } });
    expect(res.status).toBe(403);
  });
});
