import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveActor } from "../services/actors.js";
import { createTicket, updateTicket } from "../services/tickets.js";
import { addComment } from "../services/comments.js";
import { getTicketHistory, searchTickets } from "../services/history.js";
import { saveNote, updateNote, deleteNote, listNotes } from "../services/notes.js";
import { searchKnowledge } from "../services/knowledge.js";

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

  server.registerTool("update_note",
    { inputSchema: { id: z.string(), expectedVersion: z.number(), title: z.string().optional(), body: z.string().optional() } },
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
    { inputSchema: { query: z.string(), limit: z.number().optional() } },
    async ({ query, limit }) => ({
      content: [{ type: "text", text: JSON.stringify(await searchKnowledge(query, { limit })) }],
    }));

  return server;
}
