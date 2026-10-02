import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { tickets, events, comments, actors, projects, type Ticket } from "../db/schema.js";
import { NotFoundError, StaleVersionError, ConflictError, ForbiddenError } from "./errors.js";
import { parseVerification } from "../relay/prompts.js";
import { gateDirectiveLines } from "../forge/policy.js";
import { emitEvent } from "../api/events.js";

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// Gate directives in a body (GATE-OVERRIDE, ALLOW-PROTECTED, ALLOW-FILES) switch
// review gates off. Members and inbound sync write bodies too, so a directive
// the current body does not already carry needs an admin actor. REST, MCP and
// sync all come through here, so this is the one place to check.
async function assertDirectivesAllowed(tx: Executor, actorId: string, before: string, after: string): Promise<void> {
  const had = new Set(gateDirectiveLines(before));
  const added = gateDirectiveLines(after).filter((l) => !had.has(l));
  if (!added.length) return;
  const [actor] = await tx.select({ role: actors.role }).from(actors).where(eq(actors.id, actorId)).limit(1);
  if (actor?.role === "admin") return;
  const names = [...new Set(added.map((l) => l.slice(0, l.indexOf(":")).toUpperCase()))].join(", ");
  throw new ForbiddenError(`gate directives (${names}) in a ticket body require an admin actor`);
}

export async function createTicket(
  actorId: string,
  input: {
    projectId: string; title: string; body?: string;
    priority?: "low" | "normal" | "high"; assigneeId?: string;
    status?: "open" | "in_progress" | "closed" | "planned" | "review";
    requiresVerification?: boolean;
  },
  executor: Executor = db,
): Promise<Ticket> {
  return executor.transaction(async (tx) => {
    const [proj] = await tx.select({ id: projects.id }).from(projects)
      .where(eq(projects.id, input.projectId)).limit(1);
    if (!proj) throw new NotFoundError(`project not found: ${input.projectId}`);
    if (input.body) await assertDirectivesAllowed(tx, actorId, "", input.body);
    const [ticket] = await tx.insert(tickets).values({
      projectId: input.projectId, title: input.title, body: input.body ?? "",
      priority: input.priority ?? "normal", assigneeId: input.assigneeId, status: input.status,
      requiresVerification: input.requiresVerification ?? false,
    }).returning();
    await tx.insert(events).values({
      actorId, ticketId: ticket.id, action: "ticket.created",
      changes: { title: { from: null, to: ticket.title } },
    });
    return ticket;
  });
}

export async function updateTicket(
  actorId: string,
  id: string,
  expectedVersion: number,
  patch: Partial<{
    title: string; body: string;
    status: "open" | "in_progress" | "closed" | "planned" | "review";
    priority: "low" | "normal" | "high";
    assigneeId: string | null;
    requiresVerification: boolean;
  }>,
): Promise<Ticket> {
  const result = await db.transaction(async (tx) => {
    const [current] = await tx.select().from(tickets).where(eq(tickets.id, id)).limit(1);
    if (!current) throw new NotFoundError(`ticket ${id}`);
    if (current.version !== expectedVersion) {
      throw new StaleVersionError(expectedVersion, current.version);
    }
    if (patch.body !== undefined) await assertDirectivesAllowed(tx, actorId, current.body ?? "", patch.body);

    if (patch.status === "closed" && current.requiresVerification) {
      const authzRows = await tx.select({ body: comments.body }).from(comments)
        .innerJoin(actors, eq(actors.id, comments.authorId))
        .where(and(eq(comments.ticketId, id), eq(comments.kind, "verification"), eq(actors.role, "admin")));
      
      const verified = authzRows.some(row => parseVerification(row.body).pass);
      if (!verified) throw new ConflictError("verification required before close");
    }

    // Whitelist editable fields so a caller can't mass-assign columns like createdAt/projectId.
    const ALLOWED = ["title", "body", "status", "priority", "assigneeId", "requiresVerification"] as const;
    const clean = Object.fromEntries(
      Object.entries(patch).filter(([k]) => (ALLOWED as readonly string[]).includes(k)),
    );

    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const [k, v] of Object.entries(clean)) {
      if (v !== undefined && (current as Record<string, unknown>)[k] !== v) {
        changes[k] = { from: (current as Record<string, unknown>)[k], to: v };
      }
    }

    // Guarded UPDATE: version in WHERE closes the check-then-write race.
    const [updated] = await tx.update(tickets)
      .set({ ...clean, version: current.version + 1, updatedAt: new Date() })
      .where(and(eq(tickets.id, id), eq(tickets.version, expectedVersion)))
      .returning();
    if (!updated) throw new StaleVersionError(expectedVersion, current.version);

    await tx.insert(events).values({
      actorId, ticketId: id, action: "ticket.updated", changes,
    });
    return updated;
  });
  emitEvent("ticket.changed", { id: result.id, status: result.status });
  return result;
}
