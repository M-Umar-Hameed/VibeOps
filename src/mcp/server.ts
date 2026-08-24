import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveActor } from "../services/actors.js";
import { createTicket, updateTicket } from "../services/tickets.js";
import { addComment } from "../services/comments.js";
import { getTicketHistory, searchTickets } from "../services/history.js";
import { saveNote, updateNote, deleteNote, listNotes } from "../services/notes.js";
import { searchKnowledge } from "../services/knowledge.js";
import { fetchDocs } from "../knowledge/docs.js";
import { exists, list, submitBatch, type ActionStep } from "../browser/channel.js";
import { validateSteps } from "../browser/validate.js";
import { hasActGrant, noActGrantReason } from "../browser/grants.js";
import { humanizeBrowserError } from "../browser/refusal.js";
import { runMarks, marksAsText } from "../browser/marks-run.js";
export async function buildServer(apiKey: string) {
  const actor = await resolveActor(apiKey);
  const server = new McpServer({ name: "tickets", version: "0.1.0" });

  server.registerTool("create_ticket",
    { inputSchema: { projectId: z.string(), title: z.string(), body: z.string().optional() } },
    async (a) => ({ content: [{ type: "text", text: JSON.stringify(await createTicket(actor.id, a)) }] }));

  server.registerTool("update_ticket",
    { inputSchema: { id: z.string(), expectedVersion: z.number(), status: z.enum(["open", "in_progress", "closed", "planned", "review"]).optional(), title: z.string().optional() } },
    async ({ id, expectedVersion, ...patch }) => ({
      content: [{ type: "text", text: JSON.stringify(await updateTicket(actor.id, id, expectedVersion, patch)) }],
    }));

  server.registerTool("comment",
    { inputSchema: { ticketId: z.string(), body: z.string(), kind: z.enum(["comment", "plan", "report", "review"]).optional() } },
    async ({ ticketId, body, kind }) => ({ content: [{ type: "text", text: JSON.stringify(await addComment(actor.id, ticketId, body, kind)) }] }));

  server.registerTool("search_tickets",
    { inputSchema: { q: z.string() } },
    async ({ q }) => ({ content: [{ type: "text", text: JSON.stringify(await searchTickets(q)) }] }));

  server.registerTool("get_ticket_history",
    { inputSchema: { ticketId: z.string() } },
    async ({ ticketId }) => ({ content: [{ type: "text", text: JSON.stringify(await getTicketHistory(ticketId)) }] }));

  server.registerTool("save_note",
    { inputSchema: { body: z.string(), scope: z.enum(["global", "project", "ticket"]), refId: z.string().optional(), title: z.string().optional() } },
    async ({ body, scope, refId, title }) => ({
      content: [{ type: "text", text: JSON.stringify(await saveNote(actor.id, { body, scope, refId, title })) }],
    }));

  server.registerTool("save_decision",
    { description: "Record a decision with its rationale so it is recalled unasked in matching contexts.",
      inputSchema: { text: z.string(), rationale: z.string(), domain: z.string().optional(), scope: z.enum(["global", "project", "ticket"]).default("global"), refId: z.string().optional() } },
    async ({ text, rationale, domain, scope, refId }) => ({
      content: [{ type: "text", text: JSON.stringify(await saveNote(actor.id, { body: text, rationale, domain, kind: "decision", scope, refId })) }],
    }));

  server.registerTool("save_rule",
    { description: "Record a standing rule for a domain; it fires in every matching context.",
      inputSchema: { text: z.string(), domain: z.string(), scope: z.enum(["global", "project", "ticket"]).default("global"), refId: z.string().optional() } },
    async ({ text, domain, scope, refId }) => ({
      content: [{ type: "text", text: JSON.stringify(await saveNote(actor.id, { body: text, domain, kind: "rule", scope, refId })) }],
    }));

  server.registerTool("update_note",
    { inputSchema: {
      id: z.string(), expectedVersion: z.number(), title: z.string().optional(), body: z.string().optional(),
      kind: z.enum(["note", "decision", "rule", "handoff"]).optional(),
      domain: z.string().nullable().optional(), rationale: z.string().optional(),
    } },
    async ({ id, expectedVersion, ...patch }) => ({
      content: [{ type: "text", text: JSON.stringify(await updateNote(actor.id, id, expectedVersion, patch)) }],
    }));

  server.registerTool("delete_note",
    { inputSchema: { id: z.string(), expectedVersion: z.number() } },
    async ({ id, expectedVersion }) => {
      await deleteNote(actor.id, id, expectedVersion);
      return { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] };
    });

  server.registerTool("list_notes",
    { inputSchema: { scope: z.enum(["global", "project", "ticket"]).optional(), refId: z.string().optional(), limit: z.number().optional() } },
    async (f) => ({ content: [{ type: "text", text: JSON.stringify(await listNotes(f)) }] }));

  server.registerTool("search_knowledge",
    { inputSchema: { query: z.string(), limit: z.number().optional(), project: z.string().optional() } },
    async ({ query, limit, project }) => ({
      content: [{ type: "text", text: JSON.stringify(await searchKnowledge(query, { limit, projectId: project, caller: "mcp:search_knowledge" })) }],
    }));

  server.registerTool("fetch_docs",
    { description: "Fetch version-current library documentation via Context7 (opt-in)",
      inputSchema: { library: z.string(), topic: z.string().optional() } },
    async ({ library, topic }) => {
      const { text } = await fetchDocs(library, topic);
      return { content: [{ type: "text", text }] };
    });

  // Browser verbs — same in-process channel + act-grant gate as the chat SDK path
  // (src/chat/tools.ts). Both callers hit hasActGrant/noActGrantReason from
  // src/browser/grants.ts, so there is ONE grant model and one browserGrants
  // setting, not two. Over the stdio entrypoint (npm run mcp) the channel is empty
  // and every verb self-explains "no extension connected"; the browser is reachable
  // only over the HTTP transport, which runs in the api process that holds it.
  // ponytail: resolveInstance duplicated from tools.ts (12 lines) to keep this change
  // inside the MCP file; extract to src/browser/verbs.ts if a third caller appears.
  const resolveInstance = (instanceId?: string): { id?: string; err?: string } => {
    const liveInst = list();
    if (!instanceId) {
      if (liveInst.length === 1) return { id: liveInst[0].instanceId };
      if (liveInst.length === 0) return { err: "no browser extension is connected. Open the VibeOps Browser Agent extension settings and press Connect." };
      return { err: `multiple browser instances connected - pass instanceId. Connected: ${liveInst.map((i) => `${i.instanceId} (${i.profileLabel})`).join(", ")}` };
    }
    if (!exists(instanceId)) {
      const connected = liveInst.map((i) => i.instanceId).join(", ") || "none connected";
      return { err: `no browser instance "${instanceId}". Connected: ${connected}` };
    }
    return { id: instanceId };
  };

  // Read-tier steps only; the LAST step's result is what the caller gets (e.g.
  // switchTab then tabs returns the tab list after the switch).
  const readOnly = async (instanceId: string | undefined, ...steps: ActionStep[]): Promise<string> => {
    const { id, err } = resolveInstance(instanceId);
    if (!id) return err!;
    const result = await submitBatch(id, id, steps);
    if (!result) return "browser batch timed out (no extension response in 30s)";
    const failed = result.results.find((r) => !r.ok);
    const s = failed ?? result.results[result.results.length - 1];
    if (!s?.ok) return `browser refused: ${humanizeBrowserError(s?.error)}`;
    return typeof s.value === "string" ? s.value : JSON.stringify(result.snapshot ?? s.value ?? "").slice(0, 4000);
  };

  server.registerTool("browser_snapshot",
    { description: "Snapshot the connected browser (read-only). instanceId optional when one browser is connected.",
      inputSchema: { instanceId: z.string().optional() } },
    async ({ instanceId }) => ({ content: [{ type: "text", text: await readOnly(instanceId, { verb: "snapshot" }) }] }));

  server.registerTool("browser_tabs",
    { description: "List the open browser tabs (id, url, title, active), optionally switching to one first by tabId (read-only; page actions then apply to the active tab). To open a URL in a NEW tab use browser_act with a newTab step.",
      inputSchema: { instanceId: z.string().optional(), switchTo: z.number().int().nonnegative().optional() } },
    async ({ instanceId, switchTo }) => ({ content: [{ type: "text", text: await readOnly(instanceId, ...(switchTo === undefined ? [{ verb: "tabs" } as const] : [{ verb: "switchTab", tabId: switchTo } as const, { verb: "tabs" } as const])) }] }));

  server.registerTool("browser_read",
    { description: "Read an element by ref (read-only). instanceId optional when one browser is connected.",
      inputSchema: { instanceId: z.string().optional(), ref: z.string() } },
    async ({ instanceId, ref }) => ({ content: [{ type: "text", text: await readOnly(instanceId, { verb: "read", ref }) }] }));

  server.registerTool("browser_marks",
    { description: "Screenshot the connected browser with numbered boxes over every interactive element; returns the mark table as text plus a file path to the annotated PNG. Choose a target by MARK NUMBER and act on its ref with browser_act. Works without vision: each mark lists its role and name.",
      inputSchema: { instanceId: z.string().optional() } },
    async ({ instanceId }) => {
      const { id, err } = resolveInstance(instanceId);
      if (!id) return { content: [{ type: "text", text: err! }] };
      const run = await runMarks(id);
      if (!run.ok) return { content: [{ type: "text", text: `browser refused: ${humanizeBrowserError(run.error)}` }] };
      const refs = run.marks.map((m) => `${m.mark}=${m.ref}`).join(" ");
      return { content: [{ type: "text", text: `${marksAsText(run.marks, run.imagePath)}

refs: ${refs}` }] };
    });

  server.registerTool("browser_act",
    { description: "Run mutating steps (click/type/select/press/navigate/newTab) on a browser instance; requires an act grant for targetOrigin. navigate and newTab need an act grant for the DESTINATION origin (http/https only); newTab {url} opens it in a new active tab, and later steps in the same batch run there.",
      inputSchema: { instanceId: z.string().optional(), targetOrigin: z.string(), steps: z.array(z.any()) } },
    async ({ instanceId, targetOrigin, steps }) => {
      const { id, err } = resolveInstance(instanceId);
      if (!id) return { content: [{ type: "text", text: err! }] };
      const v = validateSteps(steps);
      if (!v.ok) return { content: [{ type: "text", text: `invalid steps: ${v.error}` }] };
      // SECURITY GATE — identical to src/chat/tools.ts:122-123. Grant decided
      // server-side against browserGrants; the model-supplied targetOrigin is the
      // exact value checked and the value granted, never widened. MUTATION-TEST TARGET.
      if (!(await hasActGrant(targetOrigin))) {
        return { content: [{ type: "text", text: `browser refused: ${noActGrantReason(targetOrigin)}` }] };
      }
      const result = await submitBatch(id, id, v.steps as ActionStep[], { grant: "act", targetOrigin });
      if (!result) return { content: [{ type: "text", text: "browser batch timed out (no extension response in 30s)" }] };
      const failed = result.results.find((r) => !r.ok);
      if (failed) return { content: [{ type: "text", text: `browser refused: ${humanizeBrowserError(failed.error)}` }] };
      return { content: [{ type: "text", text: JSON.stringify(result.snapshot ?? "").slice(0, 4000) }] };
    });

  return server;
}
