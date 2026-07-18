import { getTicket } from "../services/history.js";
import { listComments } from "../services/comments.js";

export const MISMATCH_WARNING = "WARNING: Model routing mismatch. The agent reported using a different model than requested.";

export function verifyModel(agentName: string, requestedModel: string | undefined, output: string): "verified" | "mismatch" | "unknown" {
  if (!requestedModel) return "unknown";

  if (agentName === "fake") {
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

export async function computeVerificationStatus(ticketId: string): Promise<boolean | "unknown"> {
  try {
    const comments = await listComments(ticketId);
    let finalStatus: boolean | "unknown" = "unknown";
    for (const c of comments) {
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
