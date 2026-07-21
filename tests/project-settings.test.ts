import { describe, it, expect } from "vitest";
import { app } from "../src/api/app.js";
import { createActor } from "../src/services/actors.js";
import { createProject } from "../src/services/projects.js";

function uniq(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function adminHeaders(): Promise<Record<string, string>> {
  const { apiKey } = await createActor({ name: uniq("ps-admin"), kind: "human", role: "admin" });
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
}

describe("project settings", () => {
  it("CRUD + allowlist + delete-on-empty", async () => {
    const h = await adminHeaders();
    const project = await createProject({ key: uniq("ps-proj"), name: "PS" });

    let res = await app.request(`/projects/${project.id}/settings`, { headers: h });
    expect(await res.json()).toEqual({});

    res = await app.request(`/projects/${project.id}/settings/bogus.key`, {
      method: "PUT", headers: h, body: JSON.stringify({ value: "abc" })
    });
    expect(res.status).toBe(400);

    res = await app.request(`/projects/${project.id}/settings/github.repo`, {
      method: "PUT", headers: h, body: JSON.stringify({ value: "owner/repo" })
    });
    expect(res.status).toBe(200);

    res = await app.request(`/projects/${project.id}/settings`, { headers: h });
    expect(await res.json()).toEqual({ "github.repo": "owner/repo" });

    res = await app.request(`/projects/${project.id}/settings/github.repo`, {
      method: "PUT", headers: h, body: JSON.stringify({ value: "" })
    });
    expect(res.status).toBe(200);

    res = await app.request(`/projects/${project.id}/settings`, { headers: h });
    expect(await res.json()).toEqual({});
  });

  it("normalizes a pasted GitHub URL to owner/repo on save", async () => {
    const h = await adminHeaders();
    const project = await createProject({ key: uniq("ps-norm"), name: "N" });

    let res = await app.request(`/projects/${project.id}/settings/github.repo`, {
      method: "PUT", headers: h, body: JSON.stringify({ value: "https://github.com/Foo/bar" })
    });
    expect(res.status).toBe(200);

    res = await app.request(`/projects/${project.id}/settings`, { headers: h });
    expect(await res.json()).toEqual({ "github.repo": "Foo/bar" });
  });
});
