import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import type { Actor } from "../db/schema.js";
import { loadRelayConfig } from "../relay/config.js";
import { runDoctor } from "../relay/doctor.js";
import { parseVerdict } from "../relay/prompts.js";
import { startPipeline, listRunsWithHistory, getRunOutput, stopRun, resolveWorkdir, hasActiveRun, reviewDiffPayload, activeStageForTicket, latestRunPolicy, markPolicyWaived, listInterruptedRuns, cleanupMergedSandboxes } from "../forge/runs.js";
import {
  sandboxExists, branchName, sandboxDiff, promoteSandbox, discardSandbox, assertTicketId, hasCommitsToPromote, sandboxDiffSummary, sandboxHeadHash, sandboxActivity, sandboxWorkingDiff
} from "../forge/sandbox.js";
import { indexRepoDocs } from "../services/knowledge.js";
import { pickAgents } from "../forge/router.js";
import { runAgent } from "../relay/invoke.js";
import { resolveCmd } from "../relay/config.js";
import { updateTicket } from "../services/tickets.js";
import { getTicket } from "../services/history.js";
import { addComment, listComments } from "../services/comments.js";
import { listActors } from "../services/actors.js";
import { ConflictError, NotFoundError } from "../services/errors.js";
import { getSetting } from "../services/settings.js";
import { requireAdmin } from "./auth.js";

const ATTACH_MAX_BYTES = 10 * 1024 * 1024;

// Magic-byte sniff at the trust boundary — never trust client filename/ext.
function sniffImageExt(buf: Buffer): "png" | "jpg" | "gif" | "webp" | null {
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf.length >= 4 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return "gif";
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "webp";
  return null;
}

function attachmentsDir(): string {
  return process.env.VIBEOPS_ATTACHMENTS_DIR ?? join(homedir(), ".vibeops", "attachments");
}

type AppEnv = { Variables: { actor: Actor } };

function forgeConfig() {
  return loadRelayConfig(process.env.VIBEOPS_RELAY_CONFIG);
}

function listSkillDir(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

// The promote gate is a security control: only ADMIN-authored review comments
// count, or any member key could post "VERDICT: PASS" and unlock Promote for
// unreviewed sandbox code. (Forge itself writes reviews as the admin who
// started the run; member relay reviewers still close tickets their own way.)
async function lastVerdict(ticketId: string): Promise<"pass" | "fail" | null> {
  const admins = new Set((await listActors()).filter((a) => a.role === "admin").map((a) => a.id));
  const review = [...(await listComments(ticketId))].reverse()
    .find((c) => c.kind === "review" && admins.has(c.authorId));
  if (!review) return null;
  // A verdict belongs to the run that produced it. If the latest run started
  // after this review was written, the review is a PREVIOUS run's verdict --
  // show none until the current run produces its own review.
  const policy = await latestRunPolicy(ticketId);
  if (policy && new Date(review.createdAt).getTime() < policy.startedAt.getTime()) return null;
  return parseVerdict(review.body).pass ? "pass" : "fail";
}

export function registerForgeRoutes(app: Hono<AppEnv>): void {
  app.post("/forge/attachments", async (c) => {
    const { dataBase64, name } = await c.req.json().catch(() => ({}));
    if (typeof dataBase64 !== "string" || !dataBase64) return c.json({ error: "dataBase64 required" }, 400);
    const buf = Buffer.from(dataBase64, "base64");
    if (buf.length === 0) return c.json({ error: "empty or invalid image data" }, 400);
    if (buf.length > ATTACH_MAX_BYTES) return c.json({ error: "file exceeds 10MB limit" }, 400);
    const ext = sniffImageExt(buf);
    if (!ext) return c.json({ error: "unsupported type; allowed: png, jpg, gif, webp" }, 400);
    const dir = attachmentsDir();
    mkdirSync(dir, { recursive: true });
    const abs = join(dir, `${randomUUID()}.${ext}`);
    writeFileSync(abs, buf);
    // Forward-slash the path so the markdown link stays intact on Windows.
    const alt = ((typeof name === "string" ? name : "").replace(/[[\]()\r\n]/g, "").trim() || "attachment").slice(0, 80);
    return c.json({ path: abs, markdown: `![${alt}](${abs.replace(/\\/g, "/")})` }, 201);
  });

  app.get("/forge/agents", requireAdmin, async (c) => {
    const config = forgeConfig();
    return c.json(Object.entries(config.agents).map(([name, a]) => ({ name, roles: a.roles, models: a.models ?? [] })));
  });

  app.get("/forge/skills", requireAdmin, async (c) => {
    const config = forgeConfig();
    const names = new Set([
      ...listSkillDir(join(homedir(), ".claude", "skills")),
      ...listSkillDir(join(config.workdir, ".claude", "skills")),
    ]);
    return c.json([...names].map((name) => ({ name })));
  });

  app.get("/forge/doctor", requireAdmin, async (c) => {
    const fresh = c.req.query("fresh") === "true";
    const statuses = await runDoctor(forgeConfig(), { fresh });
    return c.json(statuses);
  });

  app.post("/forge/pipeline", requireAdmin, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { ticketId, planAgent, workAgent, reviewAgent, extraPrompt, planModel, workModel, reviewModel, force, operatorNotes, effort } = body;
    if (typeof ticketId !== "string" || !ticketId) return c.json({ error: "ticketId required" }, 400);
    if (typeof planAgent !== "string" || !planAgent) return c.json({ error: "planAgent required" }, 400);
    if (typeof workAgent !== "string" || !workAgent) return c.json({ error: "workAgent required" }, 400);
    if (typeof reviewAgent !== "string" || !reviewAgent) return c.json({ error: "reviewAgent required" }, 400);
    if (extraPrompt !== undefined && typeof extraPrompt !== "string") {
      return c.json({ error: "extraPrompt must be a string" }, 400);
    }
    if (operatorNotes !== undefined && typeof operatorNotes !== "string") {
      return c.json({ error: "operatorNotes must be a string" }, 400);
    }
    for (const [key, val] of Object.entries({ planModel, workModel, reviewModel })) {
      if (val !== undefined && typeof val !== "string") return c.json({ error: `${key} must be a string` }, 400);
    }

    if (effort !== undefined && !["quick", "standard", "max"].includes(effort)) {
      return c.json({ error: 'effort must be "quick", "standard", or "max"' }, 400);
    }

    try {
      const { runId, doctorWarnings } = await startPipeline(c.get("actor").id, forgeConfig(), {
        ticketId, planAgent, workAgent, reviewAgent, extraPrompt, planModel, workModel, reviewModel, force, operatorNotes, effort,
      });
      return c.json({ runId, doctorWarnings }, 201);
    } catch (e) {
      if (e instanceof ConflictError || e instanceof NotFoundError) throw e;
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  app.get("/forge/runs", requireAdmin, async (c) => c.json(await listRunsWithHistory()));

  app.get("/forge/recovery", requireAdmin, async (c) => {
    return c.json({ interrupted: await listInterruptedRuns(forgeConfig()) });
  });

  app.get("/forge/runs/:id/output", requireAdmin, async (c) => {
    const after = Number(c.req.query("after")) || 0;
    const out = getRunOutput(c.req.param("id"), after);
    if (!out) return c.json({ error: "run not found" }, 404);
    return c.json(out);
  });

  app.post("/forge/runs/:id/stop", requireAdmin, async (c) =>
    c.json({ stopped: await stopRun(c.req.param("id")) }));

  // Non-UUID ids are rejected by assertTicketId deep in sandbox.ts; surface
  // that as 400 instead of a generic 500.
  app.use("/forge/tickets/:id/*", async (c, next) => {
    try {
      assertTicketId(c.req.param("id"));
    } catch {
      return c.json({ error: "invalid ticket id" }, 400);
    }
    await next();
  });

  app.get("/forge/tickets/:id/sandbox", requireAdmin, async (c) => {
    const ticketId = c.req.param("id");
    const policy = await latestRunPolicy(ticketId);
    const protectedViolation = policy && policy.paths.length && !policy.waived ? policy.paths : undefined;
    return c.json({
      exists: sandboxExists(ticketId),
      branch: branchName(ticketId),
      lastVerdict: await lastVerdict(ticketId),
      ...(protectedViolation ? { protectedViolation } : {}),
    });
  });

  app.get("/forge/tickets/:id/sandbox/activity", requireAdmin, async (c) => {
    const ticketId = c.req.param("id");
    if (!sandboxExists(ticketId)) return c.json({ error: "no sandbox for ticket" }, 404);
    const ticket = await getTicket(ticketId);
    const workdir = await resolveWorkdir(ticket.projectId, forgeConfig());
    const activity = await sandboxActivity(workdir, ticketId);
    return c.json({ stage: activeStageForTicket(ticketId) ?? "review", ...activity });
  });

  app.post("/forge/tickets/:id/resume", requireAdmin, async (c) => {
    const ticketId = c.req.param("id");
    const config = forgeConfig();
    const item = (await listInterruptedRuns(config)).find((r) => r.ticketId === ticketId);
    const ticket = await getTicket(ticketId);
    // No interrupted run recorded: fall back to a normal open/planned start.
    if (item && !item.resumable) return c.json({ error: item.reason }, 409);
    const resumeStage = item?.resumeMode === "review" ? "review"
      : item?.resumeMode === "work" ? "work" : undefined;
    if (!resumeStage && ticket.status !== "open" && ticket.status !== "planned") {
      return c.json({ error: "ticket must be open or planned to resume" }, 409);
    }
    const body = await c.req.json().catch(() => ({}));
    const operatorNotes = typeof body.operatorNotes === "string" ? body.operatorNotes : undefined;
    const { runId, doctorWarnings } = await startPipeline(c.get("actor").id, config, {
      ticketId, planAgent: "auto", workAgent: "auto", reviewAgent: "auto", operatorNotes, resumeStage,
    });
    return c.json({ runId, doctorWarnings }, 201);
  });

  app.get("/forge/tickets/:id/diff", requireAdmin, async (c) => {
    const ticketId = c.req.param("id");
    if (!sandboxExists(ticketId)) return c.json({ error: "no sandbox for ticket" }, 404);
    const ticket = await getTicket(ticketId);
    const workdir = await resolveWorkdir(ticket.projectId, forgeConfig());
    const diff = c.req.query("worktree") === "true"
      ? await sandboxWorkingDiff(workdir, ticketId)
      : await sandboxDiff(workdir, ticketId);
    return c.json({ diff });
  });

  app.post("/forge/tickets/:id/explain-diff", requireAdmin, async (c) => {
    const ticketId = c.req.param("id");
    const fresh = c.req.query("fresh") === "true";
    if (!sandboxExists(ticketId)) return c.json({ error: "no sandbox for ticket" }, 404);

    const ticket = await getTicket(ticketId);
    const config = forgeConfig();
    const workdir = await resolveWorkdir(ticket.projectId, config);
    const hash = await sandboxHeadHash(workdir, ticketId);
    const tag = `[hash:${hash}]`;

    if (!fresh) {
      const comments = await listComments(ticketId);
      const cached = comments.find(com => com.kind === "diff-summary" && com.body.includes(tag));
      if (cached) {
        return c.json({ summary: cached.body.replace(tag, "").trim() });
      }
    }

    const diff = await sandboxDiff(workdir, ticketId);
    const stat = await sandboxDiffSummary(workdir, ticketId);
    const payload = reviewDiffPayload(diff, stat);
    
    const pick = pickAgents(config, "cheapest-first").review;
    const agentDef = config.agents[pick.agent];
    if (!agentDef) return c.json({ error: "no review agent configured" }, 500);

    const agent = { ...agentDef, cmd: resolveCmd(agentDef, pick.model) };
    const prompt = `Summarize this diff for a non-programmer: what changed, where, and why it matters. No jargon, max 10 bullet-free sentences.\n\n${payload}`;
    
    const res = await runAgent(agent, prompt, workdir);
    if (!res.ok) return c.json({ error: "agent failed to explain diff" }, 500);

    const summary = res.output;
    await addComment(c.get("actor").id, ticketId, `${tag}\n${summary}`, "diff-summary");

    return c.json({ summary });
  });

  // Human override for a wrong or missing model verdict: the calling ADMIN
  // records their own passing review, which is exactly what the promote gate
  // trusts. Deliberate that this is a human action in the UI, not automation.
  app.post("/forge/tickets/:id/approve", requireAdmin, async (c) => {
    const ticketId = c.req.param("id");
    if (await hasActiveRun(ticketId)) return c.json({ error: "run in progress for this ticket" }, 409);
    if (!sandboxExists(ticketId)) return c.json({ error: "no sandbox for ticket" }, 404);
    const actor = c.get("actor");
    await addComment(actor.id, ticketId,
      `Override approval by ${actor.name} after manual inspection of the sandbox diff.\n\nVERDICT: PASS`,
      "review");
    const policy = await latestRunPolicy(ticketId);
    const protectedViolation = policy && policy.paths.length && !policy.waived ? policy.paths : undefined;
    return c.json({
      lastVerdict: await lastVerdict(ticketId),
      ...(protectedViolation ? { protectedViolation } : {}),
    });
  });

  app.post("/forge/tickets/:id/promote", requireAdmin, async (c) => {
    const ticketId = c.req.param("id");
    if (await hasActiveRun(ticketId)) return c.json({ error: "run in progress for this ticket" }, 409);
    const policy = await latestRunPolicy(ticketId);
    if (policy && policy.paths.length && !policy.waived) {
      return c.json({
        error: `protected-path policy violation must be waived before promoting: ${policy.paths.join(", ")}`,
        paths: policy.paths,
      }, 409);
    }
    const verdict = await lastVerdict(ticketId);
    if (!sandboxExists(ticketId) || verdict !== "pass") {
      return c.json({ error: "sandbox must exist and have a passing review before promoting" }, 409);
    }
    const ticket = await getTicket(ticketId);
    const workdir = await resolveWorkdir(ticket.projectId, forgeConfig());
    if (!(await hasCommitsToPromote(workdir, ticketId))) {
      return c.json({ error: "sandbox has no commits to promote" }, 409);
    }
    // Default: discard the sandbox once the merge lands (reclaims the worktree +
    // any frontendDeps node_modules copy). Set forge.discardOnPromote=false to keep
    // the tree for debugging a promote.
    const discardAfter = (await getSetting("forge.discardOnPromote")) !== "false";
    await promoteSandbox(workdir, ticketId, ticket.title, discardAfter);
    // Repo files just changed on disk (sandbox merged into the project repo); refresh the
    // doc index so stale README/CLAUDE/AGENTS text stops feeding plan/work prompts. Only this
    // project. Non-blocking, swallow failures — matches the first-time index at runs.ts:316.
    indexRepoDocs(ticket.projectId)
      .catch((e) => console.warn(`repo re-index after promote failed: ${(e as Error).message}`));
    await addComment(c.get("actor").id, ticketId, "forge: promoted", "comment");
    const fresh = await getTicket(ticketId);
    const updated = await updateTicket(c.get("actor").id, ticketId, fresh.version, { status: "closed" });
    return c.json(updated);
  });

  // A protected-path violation is a durable fact on the run row; a normal Approve
  // cannot clear it. Waiving requires the caller to name the EXACT offending paths
  // (proof they saw them) and is recorded as an audited, actor-attributed comment.
  app.post("/forge/tickets/:id/waive-policy", requireAdmin, async (c) => {
    const ticketId = c.req.param("id");
    if (await hasActiveRun(ticketId)) return c.json({ error: "run in progress for this ticket" }, 409);
    const { paths } = await c.req.json().catch(() => ({}));
    if (!Array.isArray(paths) || !paths.every((p) => typeof p === "string")) {
      return c.json({ error: "paths must be a string array" }, 400);
    }
    const policy = await latestRunPolicy(ticketId);
    if (!policy || !policy.paths.length || policy.waived) {
      return c.json({ error: "no active policy violation to waive" }, 400);
    }
    const want = new Set(policy.paths);
    const got = new Set(paths.map((p) => p.trim()).filter(Boolean));
    const exact = want.size === got.size && [...want].every((p) => got.has(p));
    if (!exact) {
      return c.json({ error: `paths must match the recorded violation exactly: ${policy.paths.join(", ")}`, paths: policy.paths }, 400);
    }
    await markPolicyWaived(policy.runId);
    const actor = c.get("actor");
    await addComment(actor.id, ticketId,
      `Policy waiver by ${actor.name} for protected paths:\n${policy.paths.map((p) => `  - ${p}`).join("\n")}\n\nThese files control how the project is built or tested.`,
      "comment");
    return c.json({ waived: policy.paths });
  });

  app.post("/forge/tickets/:id/discard", requireAdmin, async (c) => {
    const ticketId = c.req.param("id");
    if (await hasActiveRun(ticketId)) return c.json({ error: "run in progress for this ticket" }, 409);
    if (!sandboxExists(ticketId)) return c.json({ error: "no sandbox for ticket" }, 404);
    const ticket = await getTicket(ticketId);
    const workdir = await resolveWorkdir(ticket.projectId, forgeConfig());
    await discardSandbox(workdir, ticketId);
    await addComment(c.get("actor").id, ticketId, "forge: sandbox discarded", "comment");
    let updated = ticket;
    if (updated.status === "review") {
      updated = await updateTicket(c.get("actor").id, ticketId, updated.version, { status: "planned" });
    }
    return c.json(updated);
  });

  app.post("/forge/sandboxes/cleanup", requireAdmin, async (c) => {
    const result = await cleanupMergedSandboxes(forgeConfig());
    return c.json(result);
  });

  app.patch("/relay/agents/:name", requireAdmin, async (c) => {
    const name = c.req.param("name");
    const body = await c.req.json().catch(() => ({}));
    const { roles, models, ...extra } = body;
    
    if (Object.keys(extra).length > 0) return c.json({ error: "extra fields not allowed" }, 400);

    if (roles !== undefined) {
      if (!Array.isArray(roles) || roles.length === 0) return c.json({ error: "roles must be a non-empty array" }, 400);
      const validRoles = ["plan", "work", "review"];
      if (!roles.every(r => validRoles.includes(r))) return c.json({ error: "invalid role" }, 400);
    }

    if (models !== undefined) {
      if (!Array.isArray(models)) return c.json({ error: "models must be an array" }, 400);
      for (const m of models) {
        if (!m || typeof m !== "object") return c.json({ error: "invalid model" }, 400);
        if (typeof m.name !== "string" || !m.name) return c.json({ error: "model name required" }, 400);
        if (!["free", "cheap", "expensive"].includes(m.tier)) return c.json({ error: "invalid model tier" }, 400);
        if (!Number.isInteger(m.quality) || m.quality < 1 || m.quality > 5) return c.json({ error: "invalid model quality" }, 400);
      }
    }

    const configPath = process.env.VIBEOPS_RELAY_CONFIG ?? join(homedir(), ".vibeops", "relay.json");
    let raw: string;
    try {
      raw = readFileSync(configPath, "utf-8");
    } catch {
      return c.json({ error: "relay.json not found" }, 404);
    }

    let cfg: Record<string, any>;
    try {
      cfg = JSON.parse(raw);
    } catch {
      return c.json({ error: "invalid relay.json" }, 500);
    }

    // Own-property check: agents["__proto__"] resolves to Object.prototype
    // (truthy), and assigning through it would pollute every object.
    if (!cfg.agents || !Object.prototype.hasOwnProperty.call(cfg.agents, name)) {
      return c.json({ error: "agent not found" }, 404);
    }

    if (roles !== undefined) cfg.agents[name].roles = roles;
    if (models !== undefined) cfg.agents[name].models = models;

    writeFileSync(configPath, JSON.stringify(cfg, null, 2), "utf-8");

    return c.json({ name, roles: cfg.agents[name].roles, models: cfg.agents[name].models ?? [] });
  });
}
