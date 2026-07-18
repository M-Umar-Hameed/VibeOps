import { Hono } from "hono";
import { auth } from "./auth.js";
import { createTicket, updateTicket } from "../services/tickets.js";
import { addComment, listComments } from "../services/comments.js";
import { getTicket, getTicketHistory, listTickets, searchTickets } from "../services/history.js";
import { saveNote, updateNote, deleteNote, listNotes, getNote } from "../services/notes.js";
import { searchKnowledge, getKnowledgeSource, upsertSourceDoc, listSessionDocs, knowledgeGraph } from "../services/knowledge.js";
import { AuthError, ConflictError, ForbiddenError, NotFoundError, StaleVersionError } from "../services/errors.js";
import { listProjects, createProject, updateProjectRepo, gitInitProject, getProjectSettings, setProjectSetting } from "../services/projects.js";
import { listActors, createActor, revokeActor } from "../services/actors.js";
import { requireAdmin } from "./auth.js";
import { getSystemMetrics, getSystemLogs, getSystemTopology, getAiUsage, getSystemStatus } from "../services/system.js";
import { getSetting, setSetting } from "../services/settings.js";
import { getVaultStatus, startWatcher, stopWatcher } from "../ingest/watch.js";
import { fetchDocs } from "../knowledge/docs.js";
import { getEmbedder } from "../knowledge/embedder.js";
import type { Actor } from "../db/schema.js";
import { registerMcpRoutes } from "./mcp-routes.js";
import { registerForgeRoutes } from "./forge-routes.js";
import { registerSkillsRoutes } from "./skills-routes.js";
import { registerCouncilRoutes } from "./council-routes.js";
import { registerExportRoutes } from "./export-routes.js";

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

const COMMENT_KINDS = ["comment", "plan", "report", "review", "verification"] as const;

app.post("/tickets/:id/comments", async (c) => {
  const { body, kind } = await c.req.json();
  if (kind !== undefined && !COMMENT_KINDS.includes(kind)) {
    return c.json({ error: "kind must be comment|plan|report|review" }, 400);
  }
  return c.json(await addComment(c.get("actor").id, c.req.param("id"), body, kind), 201);
});

app.get("/tickets/:id/history", async (c) => c.json(await getTicketHistory(c.req.param("id"))));
app.get("/tickets/:id/comments", async (c) => c.json(await listComments(c.req.param("id"))));

app.post("/tickets/:id/verify", requireAdmin, async (c) => {
  const { note } = await c.req.json().catch(() => ({}));
  const body = `${note ?? "Verified by supervisor."}\n\nVERIFICATION: PASS`;
  await addComment(c.get("actor").id, c.req.param("id"), body, "verification");
  return c.json({ verified: true });
});
app.get("/tickets/:id", async (c) => c.json(await getTicket(c.req.param("id"))));
app.get("/tickets", async (c) =>
  c.json(await listTickets({ projectId: c.req.query("projectId"), status: c.req.query("status") })));
app.get("/search", async (c) => c.json(await searchTickets(c.req.query("q") ?? "")));

app.get("/projects", async (c) => c.json(await listProjects()));
app.post("/projects", async (c) => {
  const { key, name } = await c.req.json();
  return c.json(await createProject({ key, name }), 201);
});
app.patch("/projects/:id", requireAdmin, async (c) => {
  const { repoPath } = await c.req.json().catch(() => ({}));
  if (typeof repoPath !== "string") return c.json({ error: "repoPath must be a string" }, 400);
  try {
    return c.json(await updateProjectRepo(c.req.param("id"), repoPath));
  } catch (e) {
    if (e instanceof NotFoundError || e instanceof ConflictError) throw e;
    return c.json({ error: (e as Error).message }, 400);
  }
});
app.post("/projects/:id/git-init", requireAdmin, async (c) => c.json(await gitInitProject(c.req.param("id"))));

app.get("/projects/:id/settings", requireAdmin, async (c) => {
  return c.json(await getProjectSettings(c.req.param("id")));
});

app.put("/projects/:id/settings/:key", requireAdmin, async (c) => {
  const { value } = await c.req.json();
  if (typeof value !== "string") return c.json({ error: "value must be a string" }, 400);
  try {
    await setProjectSetting(c.req.param("id"), c.req.param("key"), value);
    return c.json({ ok: true });
  } catch (e) {
    if (e instanceof NotFoundError) throw e;
    return c.json({ error: (e as Error).message }, 400);
  }
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

app.post("/actors/:id/revoke", requireAdmin, async (c) => c.json(await revokeActor(c.req.param("id"))));

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

app.get("/knowledge/sessions", async (c) => {
  const actor = c.get("actor");
  if (!actor || (actor.role !== "member" && actor.role !== "admin")) {
    throw new ForbiddenError("forbidden");
  }
  const n = Number(c.req.query("limit"));
  const limit = Number.isFinite(n) && n > 0 ? n : undefined;
  return c.json(await listSessionDocs(limit));
});

app.get("/knowledge/graph", async (c) => {
  const actor = c.get("actor");
  if (!actor || (actor.role !== "member" && actor.role !== "admin")) {
    throw new ForbiddenError("forbidden");
  }
  const n = Number(c.req.query("limit"));
  const limit = Number.isFinite(n) && n > 0 ? n : 60;
  return c.json(await knowledgeGraph(limit));
});

app.get("/knowledge/source", async (c) => {
  const kind = c.req.query("kind");
  const ref = c.req.query("ref");
  if (!kind || !ref) return c.json({ error: "Missing kind or ref" }, 400);
  return c.json({ text: await getKnowledgeSource(kind, ref) });
});

app.get("/knowledge/docs", async (c) => {
  const library = c.req.query("library");
  if (!library) return c.json({ error: "Missing library" }, 400);
  const topic = c.req.query("topic") || undefined;
  const result = await fetchDocs(library, topic);
  if (result.ok && c.req.query("save") === "1") {
    await upsertSourceDoc("session", `docs:context7:${library}`, result.text, getEmbedder());
  }
  return c.json(result);
});

// Session-start primer: a compact plain-text digest for agent hooks to inject
// as context. Member-level (just `auth`, no requireAdmin) — every agent primes.
app.get("/prime", async (c) => {
  const q = c.req.query("q") ?? "";
  const n = Number(c.req.query("limit"));
  const limit = Math.min(Number.isFinite(n) && n > 0 ? n : 5, 10);
  const hits = await searchKnowledge(q, { limit });
  if (!hits.length) return c.text(`VibeOps primer: no relevant knowledge for "${q}".`);
  const lines = [`VibeOps primer for "${q}" (${hits.length} hits):`];
  for (const h of hits) {
    const content = h.content.replace(/\r?\n/g, " ").slice(0, 400);
    lines.push(`- [${h.sourceKind} ${h.score.toFixed(2)} ${h.createdAt.slice(0, 10)}] ${content}`);
  }
  return c.text(lines.join("\n").slice(0, 4000));
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
app.get("/system/status", requireAdmin, async (c) => c.json(await getSystemStatus()));
app.get("/system/logs", requireAdmin, async (c) => c.json(await getSystemLogs()));
app.get("/system/topology", async (c) => c.json(await getSystemTopology()));
app.get("/system/ai-usage", async (c) => c.json(await getAiUsage()));
app.get("/system/agents", requireAdmin, async (c) => {
  const { getAgents } = await import("../system/agents.js");
  const n = Number(c.req.query("sinceDays"));
  return c.json(await getAgents(Number.isFinite(n) && n >= 0 ? n : 7));
});

app.get("/system/first-run", async (c) => {
  const projs = await listProjects();
  const nonInboxCount = projs.filter(p => p.key !== "inbox").length;
  const { existsSync } = await import("node:fs");
  const { homedir } = await import("node:os");
  const { join } = await import("node:path");
  const relayPath = process.env.VIBEOPS_RELAY_CONFIG ?? join(homedir(), ".vibeops", "relay.json");
  return c.json({ firstRun: nonInboxCount === 0 && !existsSync(relayPath) });
});

app.post("/relay/bootstrap", requireAdmin, async (c) => {
  const { existsSync, writeFileSync } = await import("node:fs");
  const { homedir } = await import("node:os");
  const { join } = await import("node:path");
  const relayPath = process.env.VIBEOPS_RELAY_CONFIG ?? join(homedir(), ".vibeops", "relay.json");
  
  if (existsSync(relayPath)) return c.json({ error: "relay.json already exists" }, 409);

  const templates: Record<string, any> = {
    claude: { cmd: ["claude", "-p", "{promptFile}"], roles: ["plan", "review"] },
    agy: { cmd: ["agy", "exec", "-C", "{workdir}", "{prompt}"], roles: ["work", "plan"] },
    codex: { cmd: ["codex", "exec", "-C", "{workdir}", "{prompt}"], roles: ["work"] },
    gemini: { cmd: ["gemini", "prompt", "--", "{prompt}"], roles: ["plan", "review"] }
  };

  const { runDoctor } = await import("../relay/doctor.js");
  const mockConfig = { workdir: join(homedir(), ".vibeops", "sandbox"), agents: templates };
  const statuses = await runDoctor(mockConfig as any, { fresh: true });

  const passedAgents: Record<string, any> = {};
  for (const s of statuses) {
    if (s.probe.ok) passedAgents[s.name] = templates[s.name];
  }

  const newConfig = { workdir: join(homedir(), ".vibeops", "sandbox"), agents: passedAgents };
  writeFileSync(relayPath, JSON.stringify(newConfig, null, 2), "utf-8");
  return c.json({ config: newConfig });
});

registerMcpRoutes(app);
registerForgeRoutes(app);
registerSkillsRoutes(app);
registerCouncilRoutes(app);
registerExportRoutes(app);
