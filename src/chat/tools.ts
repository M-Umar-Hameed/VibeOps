import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { searchKnowledge } from "../services/knowledge.js";
import { listTickets } from "../services/history.js";
import { exists, list, submitBatch, type ActionStep } from "../browser/channel.js";
import type { Actor } from "../db/schema.js";

export type ToolCall = { name: string; input: unknown; summary: string };

type TextResult = { content: [{ type: "text"; text: string }] };

function text(s: string): TextResult {
  return { content: [{ type: "text" as const, text: s }] };
}

async function browserStep(
  instanceId: string,
  steps: ActionStep[],
  name: string,
  rec: (name: string, input: unknown, summary: string) => void,
): Promise<TextResult> {
  if (!exists(instanceId)) {
    const connected = list().map((i) => i.instanceId).join(", ") || "none connected";
    rec(name, { instanceId }, "no such instance");
    return text(`no browser instance "${instanceId}". Connected: ${connected}`);
  }
  const result = await submitBatch(instanceId, instanceId, steps);
  if (!result) {
    rec(name, { instanceId }, "timeout");
    return text("browser batch timed out (no extension response in 30s)");
  }
  const step = result.results[0];
  if (!step?.ok) {
    rec(name, { instanceId }, `refused: ${step?.error ?? "unknown"}`);
    return text(`browser refused: ${step?.error ?? "unknown error"}`);
  }
  rec(name, { instanceId }, "ok");
  const val = typeof step.value === "string"
    ? step.value
    : JSON.stringify(result.snapshot ?? step.value ?? "").slice(0, 4000);
  return text(val);
}

export function buildChatTools(actor: Actor, calls: ToolCall[], projectId?: string) {
  const rec = (name: string, input: unknown, summary: string) => {
    calls.push({ name, input, summary });
  };

  return [
    tool(
      "knowledge_search",
      "Search the knowledge/RAG index.",
      { query: z.string() },
      async ({ query }) => {
        const hits = await searchKnowledge(query, { limit: 5, projectId, caller: `chat:${actor.id}` });
        const body = hits.length
          ? hits.map((h) => `- [${h.citation}] (${h.score.toFixed(2)}) ${h.content.slice(0, 300)}`).join("\n")
          : "no matches";
        rec("knowledge_search", { query }, `${hits.length} hit(s)`);
        return text(body);
      },
    ),
    tool(
      "board_tickets",
      "List board tickets, optionally filtered by status.",
      { status: z.string().optional() },
      async ({ status }) => {
        const rows = await listTickets({ status, limit: 200 });
        const body = rows.length
          ? rows.map((t) => `- ${t.id.slice(0, 8)} [${t.status}] ${t.title}`).join("\n")
          : "no tickets";
        rec("board_tickets", { status }, `${rows.length} ticket(s)`);
        return text(body);
      },
    ),
    tool(
      "browser_snapshot",
      "Snapshot a connected browser instance (read-only).",
      { instanceId: z.string() },
      async ({ instanceId }) => browserStep(instanceId, [{ verb: "snapshot" }], "browser_snapshot", rec),
    ),
    tool(
      "browser_read",
      "Read an element by ref from a browser instance (read-only).",
      { instanceId: z.string(), ref: z.string() },
      async ({ instanceId, ref }) => browserStep(instanceId, [{ verb: "read", ref }], "browser_read", rec),
    ),
  ];
}
