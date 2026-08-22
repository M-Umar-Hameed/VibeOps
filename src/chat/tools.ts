import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { searchKnowledge } from "../services/knowledge.js";
import { listTickets } from "../services/history.js";
import { exists, list, submitBatch, type ActionStep } from "../browser/channel.js";
import { validateSteps } from "../browser/validate.js";
import { hasActGrant, noActGrantReason } from "../browser/grants.js";
import { runMarks, marksAsText } from "../browser/marks-run.js";
import type { Actor } from "../db/schema.js";

export type ToolCall = { name: string; input: unknown; summary: string; grantOrigin?: string };

type TextResult = { content: [{ type: "text"; text: string }] };

function text(s: string): TextResult {
  return { content: [{ type: "text" as const, text: s }] };
}

// The model has no way to learn an instanceId on its own (live incident: the
// extension was linked and the agent still declared itself unable to connect).
// Omitted id -> the single live instance; ambiguity or absence explains itself.
function resolveInstance(instanceId: string | undefined): { id?: string; err?: string } {
  const live = list();
  if (!instanceId) {
    if (live.length === 1) return { id: live[0].instanceId };
    if (live.length === 0) return { err: "no browser extension is connected. Open the VibeOps Browser Agent extension settings and press Connect." };
    return { err: `multiple browser instances connected - pass instanceId. Connected: ${live.map((i) => `${i.instanceId} (${i.profileLabel})`).join(", ")}` };
  }
  if (!exists(instanceId)) {
    const connected = live.map((i) => i.instanceId).join(", ") || "none connected";
    return { err: `no browser instance "${instanceId}". Connected: ${connected}` };
  }
  return { id: instanceId };
}

async function browserStep(
  requestedId: string | undefined,
  steps: ActionStep[],
  name: string,
  rec: (name: string, input: unknown, summary: string) => void,
): Promise<TextResult> {
  const { id: instanceId, err } = resolveInstance(requestedId);
  if (!instanceId) {
    rec(name, { instanceId: requestedId }, "no instance");
    return text(err!);
  }
  const result = await submitBatch(instanceId, instanceId, steps);
  if (!result) {
    rec(name, { instanceId }, "timeout");
    return text("browser batch timed out (no extension response in 30s)");
  }
  // First failure wins; otherwise the LAST step is the answer (switchTab then
  // tabs returns the list after the switch).
  const step = result.results.find((r) => !r.ok) ?? result.results[result.results.length - 1];
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
  const rec = (name: string, input: unknown, summary: string, grantOrigin?: string) => {
    calls.push({ name, input, summary, ...(grantOrigin ? { grantOrigin } : {}) });
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
      "Snapshot the connected browser (read-only). instanceId optional when one browser is connected.",
      { instanceId: z.string().optional() },
      async ({ instanceId }) => browserStep(instanceId, [{ verb: "snapshot" }], "browser_snapshot", rec),
    ),
    tool(
      "browser_read",
      "Read an element by ref (read-only). instanceId optional when one browser is connected.",
      { instanceId: z.string().optional(), ref: z.string() },
      async ({ instanceId, ref }) => browserStep(instanceId, [{ verb: "read", ref }], "browser_read", rec),
    ),
    tool(
      "browser_tabs",
      "List the open browser tabs (id, url, title, active), optionally switching to one first by tabId (read-only; page actions then apply to the active tab). To open a URL in a NEW tab use browser_act with a newTab step.",
      { instanceId: z.string().optional(), switchTo: z.number().int().nonnegative().optional() },
      async ({ instanceId, switchTo }) => browserStep(
        instanceId,
        switchTo === undefined ? [{ verb: "tabs" }] : [{ verb: "switchTab", tabId: switchTo }, { verb: "tabs" }],
        "browser_tabs", rec,
      ),
    ),
    tool(
      "browser_marks",
      "Screenshot the browser with numbered boxes over every interactive element, and return the mark table as text plus a file path to the annotated PNG. Choose a target by its MARK NUMBER, then act on it with browser_act using the ref this returns. Works without vision: the table lists each mark's role and name.",
      { instanceId: z.string().optional() },
      async ({ instanceId: requestedId }) => {
        const { id: instanceId, err } = resolveInstance(requestedId);
        if (!instanceId) {
          rec("browser_marks", { instanceId: requestedId }, "no instance");
          return text(err!);
        }
        const run = await runMarks(instanceId);
        if (!run.ok) {
          rec("browser_marks", { instanceId }, `failed: ${run.error}`);
          return text(`browser refused: ${run.error}`);
        }
        rec("browser_marks", { instanceId }, `ok: ${run.marks.length} marks`);
        // Mark -> ref mapping is returned so the caller can act; the ref it acts
        // on still passes the same act grant as any other click.
        const refs = run.marks.map((m) => `${m.mark}=${m.ref}`).join(" ");
        return text(`${marksAsText(run.marks, run.imagePath)}\n\nrefs: ${refs}`);
      },
    ),
    tool(
      "browser_act",
      "Run mutating steps (click/type/select/press/navigate/newTab) on a browser instance; requires an act grant for targetOrigin. navigate and newTab need an act grant for the DESTINATION origin (http/https only); newTab {url} opens it in a new active tab, and later steps in the same batch run there.",
      { instanceId: z.string().optional(), targetOrigin: z.string(), steps: z.array(z.any()) },
      async ({ instanceId: requestedId, targetOrigin, steps }) => {
        const { id: instanceId, err } = resolveInstance(requestedId);
        if (!instanceId) {
          rec("browser_act", { instanceId: requestedId, targetOrigin }, "no instance");
          return text(err!);
        }
        const v = validateSteps(steps);
        if (!v.ok) {
          rec("browser_act", { instanceId, targetOrigin }, `invalid: ${v.error}`);
          return text(`invalid steps: ${v.error}`);
        }
        if (!(await hasActGrant(targetOrigin))) {
          const reason = noActGrantReason(targetOrigin);
          // grantOrigin is the exact origin the server just refused (the value
          // hasActGrant checked). The chat Allow affordance grants THIS and only
          // this — never an origin sourced from model text. DATA, not instructions.
          rec("browser_act", { instanceId, targetOrigin }, `refused: ${reason}`, targetOrigin);
          return text(`browser refused: ${reason}`);
        }
        const result = await submitBatch(instanceId, instanceId, v.steps as ActionStep[], { grant: "act", targetOrigin });
        if (!result) {
          rec("browser_act", { instanceId, targetOrigin }, "timeout");
          return text("browser batch timed out (no extension response in 30s)");
        }
        const failed = result.results.find((r) => !r.ok);
        if (failed) {
          rec("browser_act", { instanceId, targetOrigin }, `refused: ${failed.error ?? "unknown"}`);
          return text(`browser refused: ${failed.error ?? "unknown error"}`);
        }
        rec("browser_act", { instanceId, targetOrigin }, "ok");
        return text(JSON.stringify(result.snapshot ?? "").slice(0, 4000));
      },
    ),
  ];
}
