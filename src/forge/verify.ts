import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { actors } from "../db/schema.js";
import { listComments } from "../services/comments.js";

export const MISMATCH_WARNING = "WARNING: Model routing mismatch. The agent reported using a different model than requested.";

export function verifyModel(agentName: string, requestedModel: string | undefined, output: string): "verified" | "mismatch" | "unknown" {
  if (!requestedModel) return "unknown";

  // test fixture scripts strip to "fake-agent" via interpreter resolution
  if (agentName.startsWith("fake")) {
    const m = output.match(/\[FAKE-MODEL:\s*([^\]]+)\]/);
    if (m) return m[1].trim() === requestedModel ? "verified" : "mismatch";
    return "unknown";
  }

  if (agentName === "claude" || agentName === "codex") {
    try {
      const parsed = JSON.parse(output);
      if (parsed && typeof parsed === "object" && typeof parsed.model === "string") {
        return parsed.model === requestedModel ? "verified" : "mismatch";
      }
    } catch {
      // Fall through
    }
    const m = output.match(/Model:\s*([^\s]+)/i);
    if (m) return m[1].trim() === requestedModel ? "verified" : "mismatch";
  }

  return "unknown";
}

// window: scope to one run's lifetime — comments are the only persistence and
// carry no runId, so the run's [startedAt, finishedAt] bounds are the join.
export async function computeVerificationStatus(
  ticketId: string,
  window?: { from: Date; to?: Date | null },
): Promise<boolean | "unknown"> {
  try {
    const comments = await listComments(ticketId);
    // Markers are only trusted on pipeline-written comments (plan/report/
    // review) authored by an admin — same trust rule as the verdict gate.
    // Anyone can TYPE the marker string into a plain comment; it must not
    // spoof the badge.
    const adminRows = await db.select({ id: actors.id }).from(actors).where(eq(actors.role, "admin"));
    const adminIds = new Set(adminRows.map((a) => a.id));
    const PIPELINE_KINDS = new Set(["plan", "report", "review"]);
    let finalStatus: boolean | "unknown" = "unknown";
    for (const c of comments) {
      if (!PIPELINE_KINDS.has(c.kind) || !adminIds.has(c.authorId)) continue;
      if (window) {
        const at = new Date(c.createdAt as any).getTime();
        if (at < window.from.getTime() - 5000) continue;
        if (window.to && at > new Date(window.to).getTime() + 5000) continue;
      }
      if (c.body.includes("[forge: verification=mismatch]")) {
        return false;
      }
      if (c.body.includes("[forge: verification=verified]")) {
        finalStatus = true;
      }
    }
    return finalStatus;
  } catch {
    return "unknown";
  }
}
