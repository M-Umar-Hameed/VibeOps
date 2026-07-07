import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { resolveActor } from "../services/actors.js";
import { createTicket, updateTicket } from "../services/tickets.js";
import { addComment } from "../services/comments.js";
import { getTicketHistory, searchTickets } from "../services/history.js";

export async function buildServer(apiKey: string) {
  const actor = await resolveActor(apiKey);
  const server = new McpServer({ name: "tickets", version: "0.1.0" });

  server.registerTool("create_ticket",
    { inputSchema: { projectId: z.string(), title: z.string(), body: z.string().optional() } },
    async (a) => ({ content: [{ type: "text", text: JSON.stringify(await createTicket(actor.id, a)) }] }));

  server.registerTool("update_ticket",
    { inputSchema: { id: z.string(), expectedVersion: z.number(), status: z.enum(["open", "in_progress", "closed"]).optional(), title: z.string().optional() } },
    async ({ id, expectedVersion, ...patch }) => ({
      content: [{ type: "text", text: JSON.stringify(await updateTicket(actor.id, id, expectedVersion, patch)) }],
    }));

  server.registerTool("comment",
    { inputSchema: { ticketId: z.string(), body: z.string() } },
    async ({ ticketId, body }) => ({ content: [{ type: "text", text: JSON.stringify(await addComment(actor.id, ticketId, body)) }] }));

  server.registerTool("search_tickets",
    { inputSchema: { q: z.string() } },
    async ({ q }) => ({ content: [{ type: "text", text: JSON.stringify(await searchTickets(q)) }] }));

  server.registerTool("get_ticket_history",
    { inputSchema: { ticketId: z.string() } },
    async ({ ticketId }) => ({ content: [{ type: "text", text: JSON.stringify(await getTicketHistory(ticketId)) }] }));

  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = await buildServer(process.env.TICKETS_API_KEY!);
  await server.connect(new StdioServerTransport());
}
