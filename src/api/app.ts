import { Hono } from "hono";
import { auth } from "./auth.js";
import { createTicket, updateTicket } from "../services/tickets.js";
import { addComment } from "../services/comments.js";
import { getTicketHistory, listTickets, searchTickets } from "../services/history.js";
import { saveNote } from "../services/notes.js";
import { searchKnowledge } from "../services/knowledge.js";
import { AuthError, NotFoundError, StaleVersionError } from "../services/errors.js";
import type { Actor } from "../db/schema.js";

export const app = new Hono<{ Variables: { actor: Actor } }>();

app.onError((err, c) => {
  if (err instanceof StaleVersionError) return c.json({ error: err.message }, 409);
  if (err instanceof AuthError) return c.json({ error: err.message }, 401);
  if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
  return c.json({ error: "internal error" }, 500);
});

app.use("*", auth);

app.post("/tickets", async (c) => {
  const body = await c.req.json();
  return c.json(await createTicket(c.get("actor").id, body), 201);
});

app.patch("/tickets/:id", async (c) => {
  const { expectedVersion, ...patch } = await c.req.json();
  const t = await updateTicket(c.get("actor").id, c.req.param("id"), expectedVersion, patch);
  return c.json(t);
});

app.post("/tickets/:id/comments", async (c) => {
  const { body } = await c.req.json();
  return c.json(await addComment(c.get("actor").id, c.req.param("id"), body), 201);
});

app.get("/tickets/:id/history", async (c) => c.json(await getTicketHistory(c.req.param("id"))));
app.get("/tickets", async (c) =>
  c.json(await listTickets({ projectId: c.req.query("projectId"), status: c.req.query("status") })));
app.get("/search", async (c) => c.json(await searchTickets(c.req.query("q") ?? "")));

app.post("/notes", async (c) => {
  const { body, scope, refId } = await c.req.json();
  return c.json(await saveNote(c.get("actor").id, { body, scope, refId }), 201);
});

app.get("/knowledge", async (c) => {
  const q = c.req.query("q") ?? "";
  const limit = c.req.query("limit") ? Number(c.req.query("limit")) : undefined;
  return c.json(await searchKnowledge(q, { limit }));
});
