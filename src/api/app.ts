import { Hono } from "hono";
import { auth } from "./auth.js";
import { createTicket, updateTicket } from "../services/tickets.js";
import { addComment, listComments } from "../services/comments.js";
import { getTicket, getTicketHistory, listTickets, searchTickets } from "../services/history.js";
import { saveNote, updateNote, deleteNote, listNotes, getNote } from "../services/notes.js";
import { searchKnowledge, getKnowledgeSource } from "../services/knowledge.js";
import { AuthError, ConflictError, ForbiddenError, NotFoundError, StaleVersionError } from "../services/errors.js";
import { listProjects, createProject } from "../services/projects.js";
import { listActors, createActor } from "../services/actors.js";
import { requireAdmin } from "./auth.js";
import { getSystemMetrics, getSystemLogs, getSystemTopology, getAiUsage } from "../services/system.js";
import { getSetting, setSetting } from "../services/settings.js";
import { getVaultStatus, startWatcher, stopWatcher } from "../ingest/watch.js";
import { getEmbedder } from "../knowledge/embedder.js";
import type { Actor } from "../db/schema.js";
import { registerMcpRoutes } from "./mcp-routes.js";

export const app = new Hono<{ Variables: { actor: Actor } }>();

app.onError((err, c) => {
  if (err instanceof StaleVersionError) return c.json({ error: err.message }, 409);
  if (err instanceof AuthError) return c.json({ error: err.message }, 401);
  if (err instanceof ForbiddenError) return c.json({ error: err.message }, 403);
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
app.post("/actors", requireAdmin, async (c) => {
  const { name, kind, role } = await c.req.json().catch(() => ({}));
  if (typeof name !== "string" || !name.trim()) return c.json({ error: "name required" }, 400);
  if (kind !== "human" && kind !== "agent") return c.json({ error: "kind must be human|agent" }, 400);
  if (role !== undefined && role !== "admin" && role !== "member") return c.json({ error: "role must be admin|member" }, 400);
  const { actor, apiKey } = await createActor({ name: name.trim(), kind, role });
  // Never serialize apiKeyHash — the plaintext key below is the one-time secret.
  return c.json({ actor: { id: actor.id, name: actor.name, kind: actor.kind, role: actor.role }, apiKey }, 201);
});

app.post("/notes", async (c) => {
  const { body, scope, refId, title } = await c.req.json();
  return c.json(await saveNote(c.get("actor").id, { body, scope, refId, title }), 201);
});
app.get("/notes", async (c) => {
  const scope = c.req.query("scope");
  if (scope && !["global", "project", "ticket"].includes(scope)) {
    return c.json({ error: "invalid scope" }, 400);
  }
  return c.json(await listNotes({
    scope: scope as never, refId: c.req.query("refId"),
    limit: Number(c.req.query("limit")) || undefined,
  }));
});
app.get("/notes/:id", async (c) => c.json(await getNote(c.req.param("id"))));
app.patch("/notes/:id", async (c) => {
  const { expectedVersion, title, body } = await c.req.json();
  const v = Number(expectedVersion);
  if (!Number.isInteger(v)) return c.json({ error: "expectedVersion required" }, 400);
  return c.json(await updateNote(c.get("actor").id, c.req.param("id"), v, { title, body }));
});
app.delete("/notes/:id", async (c) => {
  const { expectedVersion } = await c.req.json().catch(() => ({}));
  const v = Number(expectedVersion ?? c.req.query("expectedVersion"));
  if (!Number.isInteger(v)) return c.json({ error: "expectedVersion required" }, 400);
  await deleteNote(c.get("actor").id, c.req.param("id"), v);
  return c.json({ ok: true });
});

app.get("/knowledge", async (c) => {
  const q = c.req.query("q") ?? "";
  const n = Number(c.req.query("limit"));
  const limit = Number.isFinite(n) && n > 0 ? n : undefined;
  return c.json(await searchKnowledge(q, { limit }));
});

app.get("/knowledge/source", async (c) => {
  const kind = c.req.query("kind");
  const ref = c.req.query("ref");
  if (!kind || !ref) return c.json({ error: "Missing kind or ref" }, 400);
  return c.json({ text: await getKnowledgeSource(kind, ref) });
});

app.get("/settings/:key", requireAdmin, async (c) => c.json({ value: await getSetting(c.req.param("key")) }));
app.patch("/settings/:key", requireAdmin, async (c) => {
  const { value } = await c.req.json();
  await setSetting(c.req.param("key"), value);
  return c.json({ ok: true });
});

app.get("/knowledge/obsidian", async (c) => c.json(await getVaultStatus()));
app.post("/knowledge/obsidian/start", requireAdmin, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  await startWatcher(body.vaultPath);
  return c.json(await getVaultStatus());
});
app.post("/knowledge/obsidian/stop", requireAdmin, async (c) => {
  await stopWatcher();
  return c.json(await getVaultStatus());
});

app.post("/ingest/sessions", requireAdmin, async (c) => {
  const { sinceDays } = await c.req.json().catch(() => ({}));
  const days = Number.isFinite(Number(sinceDays)) && Number(sinceDays) >= 0 ? Number(sinceDays) : 30;
  const { ingestSessions } = await import("../ingest/sessions/ingest.js");
  const { makeClaudeMemSource } = await import("../ingest/sessions/claude-mem.js");
  const { makeClaudeCodeSource } = await import("../ingest/sessions/claude-code.js");
  const { makeCodexSource } = await import("../ingest/sessions/codex.js");
  const { makeAntigravitySource } = await import("../ingest/sessions/antigravity.js");
  const summary = await ingestSessions(
    [makeClaudeMemSource(), makeClaudeCodeSource(), makeCodexSource(), makeAntigravitySource()],
    getEmbedder(), days,
  );
  return c.json(summary);
});

app.get("/system/metrics", async (c) => c.json(await getSystemMetrics()));
app.get("/system/logs", requireAdmin, async (c) => c.json(await getSystemLogs()));
app.get("/system/topology", async (c) => c.json(await getSystemTopology()));
app.get("/system/ai-usage", async (c) => c.json(await getAiUsage()));
app.get("/system/agents", requireAdmin, async (c) => {
  const { getAgents } = await import("../system/agents.js");
  const n = Number(c.req.query("sinceDays"));
  return c.json(await getAgents(Number.isFinite(n) && n >= 0 ? n : 7));
});

registerMcpRoutes(app);
