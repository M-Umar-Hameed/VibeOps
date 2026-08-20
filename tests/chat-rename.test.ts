import { describe, it, expect } from "vitest";
import { app } from "../src/api/app.js";
import { createActor } from "../src/services/actors.js";

process.env.EMBED_PROVIDER = "fake";

function uniq(p: string) { return `${p}-${Date.now()}-${Math.random().toString(36).slice(2)}`; }

async function adminHeaders(): Promise<Record<string, string>> {
  const { apiKey } = await createActor({ name: uniq("chat-rename-admin"), kind: "human", role: "admin" });
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
}

describe("PATCH /chat/sessions/:id", () => {
  it("renames a session; GET /chat/sessions returns the new title", async () => {
    const h = await adminHeaders();
    const create = await app.request("/chat/sessions", {
      method: "POST", headers: h, body: JSON.stringify({ title: "old title" }),
    });
    const { id } = await create.json();

    const patch = await app.request(`/chat/sessions/${id}`, {
      method: "PATCH", headers: h, body: JSON.stringify({ title: "new title" }),
    });
    expect(patch.status).toBe(200);
    expect((await patch.json()).title).toBe("new title");

    const list = await app.request("/chat/sessions", { headers: h });
    const rows = await list.json();
    expect(rows.find((s: any) => s.id === id)?.title).toBe("new title");
  });

  it("trims the title before saving", async () => {
    const h = await adminHeaders();
    const create = await app.request("/chat/sessions", {
      method: "POST", headers: h, body: JSON.stringify({ title: "x" }),
    });
    const { id } = await create.json();

    const patch = await app.request(`/chat/sessions/${id}`, {
      method: "PATCH", headers: h, body: JSON.stringify({ title: "  spaced  " }),
    });
    expect(patch.status).toBe(200);
    expect((await patch.json()).title).toBe("spaced");
  });

  it("returns 404 for a missing session", async () => {
    const h = await adminHeaders();
    const res = await app.request("/chat/sessions/00000000-0000-0000-0000-000000000000", {
      method: "PATCH", headers: h, body: JSON.stringify({ title: "whatever" }),
    });
    expect(res.status).toBe(404);
  });

  it("rejects an empty/whitespace title with 400", async () => {
    const h = await adminHeaders();
    const create = await app.request("/chat/sessions", {
      method: "POST", headers: h, body: JSON.stringify({ title: "keep" }),
    });
    const { id } = await create.json();

    const res = await app.request(`/chat/sessions/${id}`, {
      method: "PATCH", headers: h, body: JSON.stringify({ title: "   " }),
    });
    expect(res.status).toBe(400);
  });
});
