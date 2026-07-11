import { Hono } from "hono";
import { auth } from "./auth.js";
import { createTicket, updateTicket } from "../services/tickets.js";
import { addComment, listComments } from "../services/comments.js";
import { getTicket, getTicketHistory, listTickets, searchTickets } from "../services/history.js";
import { saveNote } from "../services/notes.js";
import { searchKnowledge, getKnowledgeSource } from "../services/knowledge.js";
import { AuthError, ConflictError, NotFoundError, StaleVersionError } from "../services/errors.js";
import { listProjects, createProject } from "../services/projects.js";
import { listActors } from "../services/actors.js";
import { getSystemMetrics, getSystemLogs, getSystemTopology } from "../services/system.js";
import type { Actor } from "../db/schema.js";

export const app = new Hono<{ Variables: { actor: Actor } }>();

app.onError((err, c) => {
  if (err instanceof StaleVersionError) return c.json({ error: err.message }, 409);
  if (err instanceof AuthError) return c.json({ error: err.message }, 401);
  if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
  if (err instanceof ConflictError) return c.json({ error: err.message }, 409);
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
app.get("/tickets/:id/comments", async (c) => c.json(await listComments(c.req.param("id"))));
app.get("/tickets/:id", async (c) => c.json(await getTicket(c.req.param("id"))));
app.get("/tickets", async (c) =>
  c.json(await listTickets({ projectId: c.req.query("projectId"), status: c.req.query("status") })));
app.get("/search", async (c) => c.json(await searchTickets(c.req.query("q") ?? "")));

app.get("/projects", async (c) => c.json(await listProjects()));
app.post("/projects", async (c) => {
  const { key, name } = await c.req.json();
  return c.json(await createProject({ key, name }), 201);
});
app.get("/actors", async (c) => c.json(await listActors()));

app.post("/notes", async (c) => {
  const { body, scope, refId } = await c.req.json();
  return c.json(await saveNote(c.get("actor").id, { body, scope, refId }), 201);
});

app.get("/knowledge", async (c) => {
  const q = c.req.query("q") ?? "";
  const n = Number(c.req.query("limit"));
  const limit = Number.isFinite(n) && n > 0 ? n : undefined;
  return c.json(await searchKnowledge(q, { limit }));
});

app.get("/knowledge/source", async (c) => {
  try {
    const kind = c.req.query("kind");
    const ref = c.req.query("ref");
    console.log("KNOWLEDGE SOURCE REQUEST:", { kind, ref });
    if (!kind || !ref) return c.json({ error: "Missing kind or ref" }, 400);
    const text = await getKnowledgeSource(kind, ref);
    return c.json({ text });
  } catch (err: any) {
    console.error("APP_TS ERROR:", err);
    return c.json({ error: err.message }, 500);
  }
});

app.get("/system/metrics", async (c) => c.json(await getSystemMetrics()));
app.get("/system/logs", async (c) => c.json(await getSystemLogs()));
app.get("/system/topology", async (c) => c.json(await getSystemTopology()));
