import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app } from "../src/api/app.js";
import { createActor } from "../src/services/actors.js";
import { setChatAgent } from "../src/chat/turns.js";
import * as store from "../src/chat/store.js";

process.env.EMBED_PROVIDER = "fake";

function uniq(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function adminHeaders(): Promise<Record<string, string>> {
  const { apiKey } = await createActor({ name: uniq("chat-api-admin"), kind: "human", role: "admin" });
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
}

async function memberHeaders(): Promise<Record<string, string>> {
  const { apiKey } = await createActor({ name: uniq("chat-api-member"), kind: "human", role: "member" });
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
}

describe("chat API", () => {
  afterEach(() => {
    setChatAgent(async () => ({ ok: true, text: "default" }));
    delete process.env.VIBEOPS_RELAY_CONFIG;
  });

  it("GET /chat/models returns the roster with only the sdk lane toolCapable", async () => {
    const cfgPath = join(mkdtempSync(join(tmpdir(), "chat-models-cfg-")), "relay.json");
    writeFileSync(cfgPath, JSON.stringify({
      workdir: tmpdir(),
      agents: {
        "claude-sdk": { cmd: ["claude"], type: "sdk", roles: ["work"], models: [{ name: "opus", tier: "expensive", quality: 5 }] },
        agy: { cmd: ["agy", "{model}"], roles: ["plan", "work"], models: [{ name: "flash", tier: "cheap", quality: 3 }] },
      },
    }));
    process.env.VIBEOPS_RELAY_CONFIG = cfgPath;

    const h = await adminHeaders();
    const res = await app.request("/chat/models", { headers: h });
    expect(res.status).toBe(200);
    const roster = await res.json();
    const sdk = roster.find((r: any) => r.agent === "claude-sdk");
    const cli = roster.find((r: any) => r.agent === "agy");
    expect(sdk.toolCapable).toBe(true);
    expect(cli.toolCapable).toBe(false);
    expect(cli.models).toEqual([{ name: "flash" }]);
  });

  it("GET /chat/models: an http lane with saved models lists exactly those, skipping the catalog fetch", async () => {
    const cfgPath = join(mkdtempSync(join(tmpdir(), "chat-models-http-saved-")), "relay.json");
    writeFileSync(cfgPath, JSON.stringify({
      workdir: tmpdir(),
      agents: {
        openrouter: {
          type: "http", roles: [], baseUrl: "https://openrouter.ai/api/v1", keySetting: "openrouterApiKey",
          models: [{ name: "anthropic/claude-3.5-sonnet", tier: "cheap", quality: 4 }],
        },
      },
    }));
    process.env.VIBEOPS_RELAY_CONFIG = cfgPath;

    const h = await adminHeaders();
    const res = await app.request("/chat/models", { headers: h });
    expect(res.status).toBe(200);
    const roster = await res.json();
    const or = roster.find((r: any) => r.agent === "openrouter");
    expect(or.models).toEqual([{ name: "anthropic/claude-3.5-sonnet" }]);
  });

  it("GET /chat/models: an http lane without saved models and no key lists no models", async () => {
    const cfgPath = join(mkdtempSync(join(tmpdir(), "chat-models-http-nokey-")), "relay.json");
    writeFileSync(cfgPath, JSON.stringify({
      workdir: tmpdir(),
      agents: {
        openrouter: { type: "http", roles: [], baseUrl: "https://openrouter.ai/api/v1", keySetting: "openrouterApiKey" },
      },
    }));
    process.env.VIBEOPS_RELAY_CONFIG = cfgPath;

    const h = await adminHeaders();
    const res = await app.request("/chat/models", { headers: h });
    expect(res.status).toBe(200);
    const roster = await res.json();
    const or = roster.find((r: any) => r.agent === "openrouter");
    expect(or.models).toEqual([]);
  });

  it("POST /chat/sessions creates a session", async () => {
    const h = await adminHeaders();
    const res = await app.request("/chat/sessions", {
      method: "POST",
      headers: h,
      body: JSON.stringify({ title: "API test session", model: "opus" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBeDefined();
    expect(body.title).toBe("API test session");
    expect(body.model).toBe("opus");
  });

  it("GET /chat/sessions lists sessions", async () => {
    const h = await adminHeaders();
    // Create one
    await app.request("/chat/sessions", {
      method: "POST",
      headers: h,
      body: JSON.stringify({ title: "list test" }),
    });

    const res = await app.request("/chat/sessions", { headers: h });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.some((s: any) => s.title === "list test")).toBe(true);
  });

  it("GET /chat/sessions/:id returns session with messages", async () => {
    const h = await adminHeaders();
    const createRes = await app.request("/chat/sessions", {
      method: "POST",
      headers: h,
      body: JSON.stringify({ title: "detail test" }),
    });
    const { id } = await createRes.json();

    // Add a message directly via store for testing
    await store.appendMessage({ sessionId: id, role: "user", body: "test msg" });

    const res = await app.request(`/chat/sessions/${id}`, { headers: h });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.session.id).toBe(id);
    expect(body.messages.length).toBe(1);
    expect(body.messages[0].body).toBe("test msg");
  });

  it("GET /chat/sessions/:id returns 404 for unknown session", async () => {
    const h = await adminHeaders();
    const res = await app.request("/chat/sessions/00000000-0000-0000-0000-000000000000", { headers: h });
    expect(res.status).toBe(404);
  });

  it("POST /chat/sessions/:id/messages sends a message and returns 202", async () => {
    const h = await adminHeaders();
    const createRes = await app.request("/chat/sessions", {
      method: "POST",
      headers: h,
      body: JSON.stringify({}),
    });
    const { id } = await createRes.json();

    setChatAgent(async (params) => {
      params.onData?.("response");
      return { ok: true, text: "response" };
    });

    const res = await app.request(`/chat/sessions/${id}/messages`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ body: "hello from test" }),
    });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // Poll until done
    let status = "running";
    for (let i = 0; i < 30 && status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const outRes = await app.request(`/chat/sessions/${id}/output?after=0`, { headers: h });
      const out = await outRes.json();
      status = out.status;
    }
    expect(status).toBe("idle");

    // Check messages persisted
    const detailRes = await app.request(`/chat/sessions/${id}`, { headers: h });
    const detail = await detailRes.json();
    expect(detail.messages.length).toBe(2);
    expect(detail.messages[0].role).toBe("user");
    expect(detail.messages[1].role).toBe("assistant");
  });

  it("POST /chat/sessions/:id/messages returns 409 while turn is running", async () => {
    const h = await adminHeaders();
    const createRes = await app.request("/chat/sessions", {
      method: "POST",
      headers: h,
      body: JSON.stringify({}),
    });
    const { id } = await createRes.json();

    let resolveFirst: () => void;
    const blockPromise = new Promise<void>((r) => {
      resolveFirst = r;
    });

    setChatAgent(async () => {
      await blockPromise;
      return { ok: true, text: "done" };
    });

    // Start first message
    const first = app.request(`/chat/sessions/${id}/messages`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ body: "first" }),
    });

    // Wait for first to start
    await new Promise((r) => setTimeout(r, 50));

    // Second should get 409
    const second = await app.request(`/chat/sessions/${id}/messages`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ body: "second" }),
    });
    expect(second.status).toBe(409);
    const err = await second.json();
    expect(err.error).toContain("already running");

    // Cleanup
    resolveFirst!();
    await first;
  });

  it("GET /chat/sessions/:id/output returns incremental output", async () => {
    const h = await adminHeaders();
    const createRes = await app.request("/chat/sessions", {
      method: "POST",
      headers: h,
      body: JSON.stringify({}),
    });
    const { id } = await createRes.json();

    let chunks = ["hello", " world"];
    let chunkIndex = 0;
    setChatAgent(async (params) => {
      for (const c of chunks) {
        params.onData?.(c);
      }
      return { ok: true, text: "hello world" };
    });

    await app.request(`/chat/sessions/${id}/messages`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ body: "test" }),
    });

    // Poll a few times
    await new Promise((r) => setTimeout(r, 100));

    const out1 = await app.request(`/chat/sessions/${id}/output?after=0`, { headers: h });
    const body1 = await out1.json();
    expect(body1.chunk).toContain("hello");
    const next = body1.next;

    // Poll after the offset
    const out2 = await app.request(`/chat/sessions/${id}/output?after=${next}`, { headers: h });
    const body2 = await out2.json();
    // Should return empty or remaining
    expect(body2.next).toBeGreaterThanOrEqual(next);
  });

  it("chat routes require admin - member gets 403", async () => {
    const h = await memberHeaders();

    const res1 = await app.request("/chat/sessions", { headers: h });
    expect(res1.status).toBe(403);

    const res2 = await app.request("/chat/sessions", {
      method: "POST",
      headers: h,
      body: JSON.stringify({}),
    });
    expect(res2.status).toBe(403);
  });

  it("browser refusal surfaces in tool calls", async () => {
    const h = await adminHeaders();
    const createRes = await app.request("/chat/sessions", {
      method: "POST",
      headers: h,
      body: JSON.stringify({}),
    });
    const { id } = await createRes.json();

    // Set up agent that calls browser_snapshot which will fail
    // Since there's no browser connected, it will return "no such instance"
    setChatAgent(async (params) => {
      for (const t of params.tools) {
        if (t.name === "browser_snapshot") {
          await t.handler({ instanceId: "nonexistent" }, {});
        }
      }
      return { ok: true, text: "tried browser" };
    });

    await app.request(`/chat/sessions/${id}/messages`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ body: "snapshot please" }),
    });

    // Wait for completion
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const outRes = await app.request(`/chat/sessions/${id}/output?after=0`, { headers: h });
      const out = await outRes.json();
      if (out.status === "idle") break;
    }

    const detailRes = await app.request(`/chat/sessions/${id}`, { headers: h });
    const detail = await detailRes.json();

    // Should have tool call with "no such instance" in summary
    const assistantMsg = detail.messages.find((m: any) => m.role === "assistant");
    expect(assistantMsg?.toolCalls).toBeDefined();
    expect(assistantMsg.toolCalls.some((tc: any) => tc.summary.includes("no instance"))).toBe(
      true
    );
  });
});
