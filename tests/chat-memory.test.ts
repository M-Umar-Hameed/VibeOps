import { describe, it, expect } from "vitest";
import * as store from "../src/chat/store.js";
import { setChatAgent, runTurn } from "../src/chat/turns.js";
import { createActor } from "../src/services/actors.js";
import { createProject } from "../src/services/projects.js";
import { saveNote } from "../src/services/notes.js";
import { buildChatTools } from "../src/chat/tools.js";
import { db } from "../src/db/client.js";
import { notes } from "../src/db/schema.js";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/mcp/server.js";

process.env.EMBED_PROVIDER = "fake";
const uniq = (p: string) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

describe("chat memory injection", () => {
  it("a project rule reaches the agent's system prompt, fenced as memory", async () => {
    const { actor } = await createActor({ name: uniq("chat-mem"), kind: "human" });
    const project = await createProject({ key: uniq("k"), name: uniq("Widgets") });
    const rule = `${uniq("rule")} never call the vendor API from tests`;
    await saveNote(actor.id, { body: rule, scope: "project", refId: project.id, kind: "rule" });
    const sess = await store.createSession("mem", "sonnet", project.id);

    let seenSystem = "";
    setChatAgent(async (params) => { seenSystem = params.systemPrompt ?? ""; return { ok: true, text: "ok" }; });
    await runTurn(actor, sess.id, "hello");

    expect(seenSystem).toContain(rule);
    // ponytail: brief's literal assertion was toContain("<memory>"), but the brief's
    // own Step 3 code fences via fenceUntrusted("memory", memory), which emits
    // <UNTRUSTED label="memory"> (the format already load-bearing across
    // council-personas/forge-runs/prompt-injection/relay-unit tests). Asserting the
    // actual, correct fence here rather than changing fenceUntrusted's format.
    expect(seenSystem).toContain('<UNTRUSTED label="memory">');
  });

});

describe("explicit memory tools", () => {
  it("save_decision and save_rule on the chat lane create typed notes scoped to the session project", async () => {
    const { actor } = await createActor({ name: uniq("tools"), kind: "human" });
    const project = await createProject({ key: uniq("k"), name: uniq("Proj") });
    const tools = buildChatTools(actor, [], project.id);
    const dec = tools.find((t) => t.name === "save_decision") as any;
    const rule = tools.find((t) => t.name === "save_rule") as any;

    await dec.handler({ text: "Use alarms", rationale: "MV3 kills workers", domain: "Extension" }, {});
    await rule.handler({ text: "Never raw SQL", domain: "DB" }, {});

    const rows = await db.select().from(notes).where(eq(notes.refId, project.id));
    const d = rows.find((n) => n.kind === "decision")!;
    const r = rows.find((n) => n.kind === "rule")!;
    expect(d.body).toBe("Use alarms");
    expect(d.rationale).toBe("MV3 kills workers");
    expect(d.domain).toBe("extension");
    expect(d.scope).toBe("project");
    expect(r.body).toBe("Never raw SQL");
    expect(r.domain).toBe("db");
  });

  it("without a session project the tools save globally", async () => {
    const { actor } = await createActor({ name: uniq("tools-g"), kind: "human" });
    const tools = buildChatTools(actor, []);
    const marker = uniq("global-rule");
    await (tools.find((t) => t.name === "save_rule") as any).handler({ text: marker, domain: "ops" }, {});
    const [row] = await db.select().from(notes).where(eq(notes.body, marker));
    expect(row.scope).toBe("global");
  });

  it("the MCP server exposes the same tools", async () => {
    const { apiKey } = await createActor({ name: uniq("mcp-mem"), kind: "agent" });
    const server = await buildServer(apiKey);
    const [c, s] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0.0.0" });
    await Promise.all([server.connect(s), client.connect(c)]);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["save_decision", "save_rule"]));
    const marker = uniq("mcp-rule");
    const res = await client.callTool({ name: "save_rule", arguments: { text: marker, domain: "Ops", scope: "global" } });
    const saved = JSON.parse((res.content as any)[0].text);
    expect(saved.kind).toBe("rule");
    expect(saved.domain).toBe("ops");
  });
});
