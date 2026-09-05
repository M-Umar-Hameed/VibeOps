import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { events } from "./events.js";
import { auth } from "./auth.js";
import { createTicket, updateTicket } from "../services/tickets.js";
import { addComment, listComments } from "../services/comments.js";
import { getTicket, getTicketHistory, listTickets, searchTickets } from "../services/history.js";
import { assertTicketId, sandboxExists } from "../forge/sandbox.js";
import { saveNote, updateNote, deleteNote, listNotes, getNote } from "../services/notes.js";
import { searchKnowledge, getKnowledgeSource, upsertSourceDoc, listSessionDocs, knowledgeGraph, indexRepoDocs } from "../services/knowledge.js";
import { recallBlock } from "../services/recall.js";
import { fenceUntrusted, UNTRUSTED_CLAUSE } from "../relay/prompts.js";
import { latestHandoff } from "../services/handoff.js";
import { AuthError, ConflictError, ForbiddenError, NotFoundError, StaleVersionError } from "../services/errors.js";
import { listProjects, createProject, updateProjectRepo, gitInitProject, getProjectSettings, setProjectSetting, scanFolder, importProjects, deleteProject, normalizePath } from "../services/projects.js";
import { clearProjectKnowledge } from "../services/knowledge.js";
import { activeRunForProject, activeStageForTicket } from "../forge/runs.js";
import { syncProject } from "../sync/run.js";
import { listActors, createActor, revokeActor } from "../services/actors.js";
import { requireAdmin } from "./auth.js";
import { bump, snapshot } from "../services/metrics.js";
import { getSystemMetrics, getSystemLogs, getSystemTopology, getAiUsage, getSystemStatus, getKnowledgeUsage } from "../services/system.js";
import { getSetting, setSetting } from "../services/settings.js";
import { getCorsOrigins } from "../services/settings-cache.js";
import { getVaultStatus, startWatcher, stopWatcher, rescanProjectVaults, getProjectVaultStatus } from "../ingest/watch.js";
import { fetchDocs } from "../knowledge/docs.js";
import { getEmbedder } from "../knowledge/embedder.js";
import { execFileSync } from "node:child_process";
import { loadRelayConfig } from "../relay/config.js";
import { db } from "../db/client.js";
import { projects, type Actor } from "../db/schema.js";
import { registerMcpRoutes } from "./mcp-routes.js";
import { registerForgeRoutes, lastVerdict } from "./forge-routes.js";
import { requestShutdown, isShutdownWired } from "./shutdown.js";
import { registerSkillsRoutes } from "./skills-routes.js";
import { registerCouncilRoutes } from "./council-routes.js";
import { registerExportRoutes } from "./export-routes.js";
import { registerBrowserRoutes } from "./browser-routes.js";
import { registerChatRoutes } from "./chat-routes.js";
import { armExport } from "../services/export-debounce.js";

export const app = new Hono<{ Variables: { actor: Actor } }>();

app.onError((err, c) => {
  if (err instanceof StaleVersionError) return c.json({ error: err.message }, 409);
  if (err instanceof AuthError) return c.json({ error: err.message }, 401);
  if (err instanceof ForbiddenError) return c.json({ error: err.message }, 403);
  if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
  if (err instanceof ConflictError) return c.json({ error: err.message }, 409);
  return c.json({ error: "internal error" }, 500);
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const BAD_JSON = Symbol("bad json");
async function jsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return BAD_JSON;
  }
}

// CORS: opt-in exact-origin allowlist from the `cors.origins` setting
// (comma-separated). Empty/unset => no Access-Control-Allow-Origin is emitted,
// so a fresh install behaves exactly as before and any non-allowlisted origin
// is refused by the browser. Exact match only; never `*`, never blind Origin
// reflection. Registered before `auth` so the credential-less OPTIONS preflight
// is answered here (204) instead of being 401'd by auth.
// Cached (settings-cache.ts, 10s TTL) and invalidated on setSetting/setOverride;
// a per-request DB read here fronted every request.
app.use("*", cors({
  origin: async (origin) => {
    if (!origin) return null;
    const raw = await getCorsOrigins();
    if (!raw) return null;
    const allowed = raw.split(",").map((o) => o.trim()).filter(Boolean);
    return allowed.includes(origin) ? origin : null;
  },
  allowHeaders: ["Authorization", "Content-Type"],
  allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE"],
}));

app.use("*", async (c, next) => {
  bump("req." + c.req.method);
  await next();
});

app.use("*", auth);

// Arm a debounced logical export after any successful durable mutation. The
// boot / 6h / clean-shutdown exports miss writes made in the hours before an
// UNCLEAN exit; this shrinks that loss window from ~6h to minutes. No-op in
// non-embedded mode (no export fn configured). Read-only and failed (>=400)
// requests never arm.
app.use("*", async (c, next) => {
  await next();
  const m = c.req.method;
  if ((m === "POST" || m === "PATCH" || m === "PUT" || m === "DELETE") && c.res.status < 400) {
    armExport();
  }
});

// Push transport (Structural S3): one SSE stream fed by the in-process event
// bus. Member-authed by the global `auth` middleware above (no key => 401).
// The offset-poll endpoints stay as the reconnect/fallback path.
app.get("/events", (c) =>
  streamSSE(c, async (stream) => {
    const onEvent = (e: { type: string; payload: unknown }) => {
      // Fire-and-forget: a slow client must never block the emitter.
      void stream.writeSSE({ event: e.type, data: JSON.stringify(e.payload) });
    };
    events.on("event", onEvent);
    // Heartbeat comment: keeps proxies from idling the socket and surfaces a
    // dead peer (write throws -> stream aborts). unref so a missed abort can't
    // hold the process open.
    const heartbeat = setInterval(() => { void stream.write(": keepalive\n\n"); }, 25_000);
    heartbeat.unref?.();
    // Hold the stream open until the client disconnects; abort removes the
    // listener so reconnects can't leak listeners unbounded.
    await new Promise<void>((resolve) => {
      stream.onAbort(() => {
        clearInterval(heartbeat);
        events.off("event", onEvent);
        resolve();
      });
    });
  }));

app.post("/tickets", async (c) => {
  const body = await jsonBody(c);
  if (body === BAD_JSON) return c.json({ error: "invalid JSON body" }, 400);
  const { projectId, title } = (body ?? {}) as { projectId?: unknown; title?: unknown };
  if (typeof projectId !== "string" || !UUID.test(projectId)) {
    return c.json({ error: "projectId must be a uuid" }, 400);
  }
  if (typeof title !== "string" || !title.trim()) {
    return c.json({ error: "title required" }, 400);
  }
  return c.json(await createTicket(c.get("actor").id, body as { projectId: string; title: string }), 201);
});

app.patch("/tickets/:id", async (c) => {
  const { expectedVersion, ...patch } = await c.req.json();
  const t = await updateTicket(c.get("actor").id, c.req.param("id"), expectedVersion, patch);
  return c.json(t);
});

const COMMENT_KINDS = ["comment", "plan", "report", "review", "verification"] as const;

app.post("/tickets/:id/comments", async (c) => {
  const id = c.req.param("id");
  try { assertTicketId(id); } catch { return c.json({ error: "invalid ticket id" }, 400); }
  const parsed = await jsonBody(c);
  if (parsed === BAD_JSON) return c.json({ error: "invalid JSON body" }, 400);
  const { body, kind } = (parsed ?? {}) as { body?: any; kind?: any };
  if (kind !== undefined && !COMMENT_KINDS.includes(kind)) {
    return c.json({ error: "kind must be comment|plan|report|review" }, 400);
  }
  // The close-gate already ignores non-admin verification comments; blocking
  // them here too keeps members from posting misleading gate-shaped noise.
  if (kind === "verification" && c.get("actor").role !== "admin") {
    return c.json({ error: "verification comments require admin" }, 403);
  }
  return c.json(await addComment(c.get("actor").id, c.req.param("id"), body, kind), 201);
});

app.get("/tickets/:id/history", async (c) => {
  const id = c.req.param("id");
  try { assertTicketId(id); } catch { return c.json({ error: "invalid ticket id" }, 400); }
  await getTicket(id);
  return c.json(await getTicketHistory(id));
});
app.get("/tickets/:id/comments", async (c) => {
  const id = c.req.param("id");
  try { assertTicketId(id); } catch { return c.json({ error: "invalid ticket id" }, 400); }
  await getTicket(id);
  return c.json(await listComments(id));
});

app.post("/tickets/:id/verify", requireAdmin, async (c) => {
  const { note } = await c.req.json().catch(() => ({}));
  const body = `${note ?? "Verified by supervisor."}\n\nVERIFICATION: PASS`;
  await addComment(c.get("actor").id, c.req.param("id"), body, "verification");
  return c.json({ verified: true });
});
app.get("/tickets/:id", async (c) => {
  try {
    assertTicketId(c.req.param("id"));
  } catch {
    return c.json({ error: "invalid ticket id" }, 400);
  }
  return c.json(await getTicket(c.req.param("id")));
});
const TICKET_LIST_MAX = 200;
app.get("/tickets", async (c) => {
  const n = Number(c.req.query("limit"));
  const limit = Number.isFinite(n) && n > 0 ? Math.min(n, TICKET_LIST_MAX) : undefined;
  const list = await listTickets({ projectId: c.req.query("projectId"), status: c.req.query("status"), limit });
  // Fold sandbox status for review rows so the forge screen needs no per-ticket
  // /sandbox poll (kills the client N+1). Bounded by the number of review
  // tickets; non-review rows are returned untouched.
  const hasReview = list.some((t) => t.status === "review");
  const admins = hasReview ? new Set((await listActors()).filter((a) => a.role === "admin").map((a) => a.id)) : undefined;
  const enriched = await Promise.all(list.map(async (t) => {
    const stage = activeStageForTicket(t.id);
    const base = t.status === "review"
      ? { ...t, sandbox: { exists: sandboxExists(t.id), lastVerdict: await lastVerdict(t.id, admins) } }
      : t;
    return stage ? { ...base, activeRun: { stage } } : base;
  }));
  return c.json(enriched);
});
app.get("/search", async (c) => c.json(await searchTickets(c.req.query("q") ?? "")));

app.get("/projects", async (c) => c.json(await listProjects()));
app.post("/projects", async (c) => {
  const parsed = await jsonBody(c);
  if (parsed === BAD_JSON) return c.json({ error: "invalid JSON body" }, 400);
  const { key, name } = (parsed ?? {}) as { key?: unknown; name?: unknown };
  if (typeof key !== "string" || !key.trim()) return c.json({ error: "key required" }, 400);
  if (typeof name !== "string" || !name.trim()) return c.json({ error: "name required" }, 400);
  const p = await createProject({ key, name });
  void rescanProjectVaults();
  return c.json(p, 201);
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
app.post("/projects/:id/index-repo", requireAdmin, async (c) =>
  c.json(await indexRepoDocs(c.req.param("id"))));
app.get("/projects/:id/vault", async (c) => c.json(await getProjectVaultStatus(c.req.param("id"))));

app.delete("/projects/:id/knowledge", requireAdmin, async (c) => {
  const removed = await clearProjectKnowledge(c.req.param("id"));
  return c.json({ removed });
});

app.delete("/projects/:id", requireAdmin, async (c) => {
  const id = c.req.param("id");
  if (!UUID.test(id)) return c.json({ error: "invalid project id" }, 400);
  const runId = await activeRunForProject(id);
  if (runId) return c.json({ error: `project has an active forge run: ${runId}`, runId }, 409);
  await deleteProject(id);
  return c.json({ ok: true });
});

app.post("/projects/scan", requireAdmin, async (c) => {
  const { path } = await c.req.json().catch(() => ({}));
  if (typeof path !== "string") return c.json({ error: "path must be a string" }, 400);
  try {
    return c.json(await scanFolder(path));
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

app.post("/projects/import", requireAdmin, async (c) => {
  const { items } = await c.req.json().catch(() => ({}));
  if (!Array.isArray(items) || items.some((i) => typeof i?.name !== "string" || typeof i?.path !== "string")) {
    return c.json({ error: "items must be an array of { name, path }" }, 400);
  }
  try {
    return c.json(await importProjects(items));
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

app.get("/projects/:id/settings", requireAdmin, async (c) => {
  return c.json(await getProjectSettings(c.req.param("id")));
});

app.put("/projects/:id/settings/:key", requireAdmin, async (c) => {
  const { value } = await c.req.json();
  if (typeof value !== "string") return c.json({ error: "value must be a string" }, 400);
  try {
    await setProjectSetting(c.req.param("id"), c.req.param("key"), value);
    if (c.req.param("key") === "vault.path") void rescanProjectVaults();
    return c.json({ ok: true });
  } catch (e) {
    if (e instanceof NotFoundError) throw e;
    return c.json({ error: (e as Error).message }, 400);
  }
});

app.post("/sync/:projectId", requireAdmin, async (c) => {
  try {
    return c.json(await syncProject(c.req.param("projectId")));
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

app.get("/actors", async (c) => c.json(await listActors()));
app.get("/git/identity", (c) => {
  try {
    const workdir = loadRelayConfig(process.env.VIBEOPS_RELAY_CONFIG).workdir;
    const name = execFileSync("git", ["config", "user.name"], { cwd: workdir, encoding: "utf-8", windowsHide: true }).trim();
    return c.json({ name: name || null });
  } catch {
    return c.json({ name: null });
  }
});
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
  const parsed = await jsonBody(c);
  if (parsed === BAD_JSON) return c.json({ error: "invalid JSON body" }, 400);
  const { body, scope, refId, title } = (parsed ?? {}) as { body?: any; scope?: any; refId?: any; title?: any };
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
  const projectId = c.req.query("project") || undefined;
  return c.json(await searchKnowledge(q, { limit, projectId, caller: "route:knowledge" }));
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
  const project = c.req.query("project") || undefined;
  return c.json(await knowledgeGraph(limit, project));
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

// Hooks identify the project by the session's cwd (Claude Code sends it in
// every hook payload). Explicit ?project= wins; otherwise the project whose
// repoPath is the cwd or one of its ancestors. Fail-open: no match = no project.
async function resolveHookProject(c: { req: { query(k: string): string | undefined } }): Promise<string | null> {
  const explicit = c.req.query("project");
  if (explicit) return explicit;
  const cwd = c.req.query("cwd");
  if (!cwd) return null;
  const target = normalizePath(cwd);
  const rows = await db.select({ id: projects.id, repoPath: projects.repoPath }).from(projects);
  let best: { id: string; len: number } | null = null;
  for (const r of rows) {
    if (!r.repoPath) continue;
    const rp = normalizePath(r.repoPath);
    if (target === rp || target.startsWith(rp + "/")) {
      if (!best || rp.length > best.len) best = { id: r.id, len: rp.length };
    }
  }
  return best?.id ?? null;
}

// Session-start primer: a compact plain-text digest for agent hooks to inject
// as context. Member-level (just `auth`, no requireAdmin) — every agent primes.
app.get("/prime", async (c) => {
  const q = c.req.query("q") ?? "";
  const n = Number(c.req.query("limit"));
  const limit = Math.min(Number.isFinite(n) && n > 0 ? n : 5, 10);
  const projectId = (await resolveHookProject(c)) ?? undefined;
  const handoff = projectId ? await latestHandoff(projectId).catch(() => null) : null;
  const lead = handoff
    ? `${fenceUntrusted("handoff", `Handoff (${handoff.createdAt.toISOString().slice(0, 10)}): ${handoff.body.replace(/\r?\n/g, " ").slice(0, 600)}`)}\n`
    : "";
  const hits = await searchKnowledge(q, { limit, projectId, caller: "route:prime" });
  if (!hits.length) {
    let text = lead + `VibeOps primer: no relevant knowledge for "${q}".`;
    text = text.slice(0, 4000);
    if (lead) text += UNTRUSTED_CLAUSE;
    return c.text(text);
  }
  const header = `VibeOps primer for "${q}" (${hits.length} hits):`;
  let hitLines = hits.map((h) => {
    const content = h.content.replace(/\r?\n/g, " ").slice(0, 400);
    return `- [${h.sourceKind} ${h.score.toFixed(2)} ${h.createdAt.slice(0, 10)}] ${content}`;
  });
  // Cap total length by trimming whole hit lines from the end (never slicing
  // the final string), so the closing fence tag and clause always survive.
  const build = () => `${lead}${header}\n${fenceUntrusted("knowledge", hitLines.join("\n"))}${UNTRUSTED_CLAUSE}`;
  let text = build();
  while (text.length > 4000 && hitLines.length > 1) {
    hitLines = hitLines.slice(0, -1);
    text = build();
  }
  return c.text(text);
});

// Prompt-time memory for agent hooks (UserPromptSubmit): the block recall
// builds for this prompt. Member-level like /prime.
app.get("/recall", async (c) => {
  const q = c.req.query("q") ?? "";
  const projectId = (await resolveHookProject(c)) ?? undefined;
  try {
    const block = await recallBlock(q, { projectId, maxChars: 3600 });
    return c.text(block ? `${fenceUntrusted("memory", block)}\n${UNTRUSTED_CLAUSE}` : "");
  } catch (e) {
    console.warn(`recall route failed: ${(e as Error).message}`);
    return c.text("");
  }
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
  const { ingestSessionsSerialized } = await import("../ingest/sessions/ingest.js");
  const { makeClaudeMemSource } = await import("../ingest/sessions/claude-mem.js");
  const { makeClaudeCodeSource } = await import("../ingest/sessions/claude-code.js");
  const { makeCodexSource } = await import("../ingest/sessions/codex.js");
  const { makeAntigravitySource } = await import("../ingest/sessions/antigravity.js");
  const summary = await ingestSessionsSerialized(
    [makeClaudeMemSource(), makeClaudeCodeSource(), makeCodexSource(), makeAntigravitySource()],
    getEmbedder(), days,
  );
  if (!summary) return c.json({ skipped: "sync already running" }, 409);
  return c.json(summary);
});

app.get("/system/metrics", async (c) => c.json(await getSystemMetrics()));
app.get("/system/status", requireAdmin, async (c) => c.json(await getSystemStatus()));
app.get("/system/logs", requireAdmin, async (c) => c.json(await getSystemLogs()));
app.get("/system/topology", async (c) => c.json(await getSystemTopology()));
app.get("/system/ai-usage", async (c) => c.json(await getAiUsage()));
app.get("/system/knowledge-usage", async (c) => c.json(await getKnowledgeUsage()));
app.get("/system/metrics-lite", requireAdmin, (c) => c.json(snapshot()));
// Graceful remote stop for the desktop updater: checkpoints the embedded DB and
// exits so the NSIS installer overwrites node.exe without a force-kill (which
// corrupts the DB) or a file-in-use error. Ack first, exit on the next tick so
// this response flushes before the socket closes. 503 when no server is wired.
app.post("/system/shutdown", requireAdmin, (c) => {
  if (!isShutdownWired()) return c.json({ error: "shutdown unavailable" }, 503);
  setTimeout(() => requestShutdown("http shutdown"), 50);
  return c.json({ ok: true });
});
app.get("/system/agents", requireAdmin, async (c) => {
  const { getAgents } = await import("../system/agents.js");
  const n = Number(c.req.query("sinceDays"));
  return c.json(await getAgents(Number.isFinite(n) && n >= 0 ? n : 7));
});

app.get("/system/first-run", async (c) => {
  const projs = await listProjects();
  const { existsSync } = await import("node:fs");
  const { homedir } = await import("node:os");
  const { join } = await import("node:path");
  const relayPath = process.env.VIBEOPS_RELAY_CONFIG ?? join(homedir(), ".vibeops", "relay.json");
  return c.json({ firstRun: projs.length === 0 && !existsSync(relayPath) });
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
    agy_local: { cmd: [join(homedir(), "AppData", "Local", "agy", "bin", "agy.exe"), "exec", "-C", "{workdir}", "{prompt}"], roles: ["work", "plan"] },
    codex: { cmd: ["codex", "exec", "-C", "{workdir}", "{prompt}"], roles: ["work"] },
    gemini: { cmd: ["gemini", "prompt", "--", "{prompt}"], roles: ["plan", "review"] }
  };

  const { runDoctor } = await import("../relay/doctor.js");
  const mockConfig = { workdir: join(homedir(), ".vibeops", "sandbox"), agents: templates };
  const statuses = await runDoctor(mockConfig as any, { fresh: true });

  const passedAgents: Record<string, any> = {};
  for (const s of statuses) {
    if (s.probe.ok) {
      if (s.name === "agy" || s.name === "agy_local") {
        if (!passedAgents.agy) passedAgents.agy = templates[s.name];
      } else {
        passedAgents[s.name] = templates[s.name];
      }
    }
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
registerBrowserRoutes(app);
registerChatRoutes(app);
