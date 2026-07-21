import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { syncLinks } from "../db/schema.js";
import { listTickets } from "../services/history.js";
import { getSetting } from "../services/settings.js";
import { normalizeBinding } from "./binding.js";

export type PushResult = { pushed: number; closed: number; pushFailed: number };

const GH_API = "https://api.github.com";

// Push local tickets to GitHub: create issues for link-less tickets, close the
// GitHub issue for locally-closed linked tickets. The inbound SourceConnector
// is untouched; this standalone github capability runs after the pull phase.
export async function pushGithub(
  fetchImpl: typeof fetch = fetch,
  opts: { projectId: string; binding?: string },
): Promise<PushResult> {
  const result: PushResult = { pushed: 0, closed: 0, pushFailed: 0 };

  // Credentials mirror the connector: global token, binding (or global repo fallback for CLI legacy path).
  const token = await getSetting("github.token");
  const rawRepo = opts.binding ?? (await getSetting("github.repo"));
  if (!token || !rawRepo) {
    console.warn("GitHub push skipped: missing github.token or github.repo");
    return result;
  }
  const repo = normalizeBinding(rawRepo);
  const [owner, name] = repo.split("/");
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
  };

  const locals = await listTickets({ projectId: opts.projectId });
  for (const t of locals) {
    // ponytail: one link SELECT per ticket, no (source,ticketId) index. Fine at
    // current scale; add an index if a project ever holds thousands of tickets.
    const links = await db.select().from(syncLinks).where(eq(syncLinks.ticketId, t.id));
    const ghLink = links.find((l) => l.source === "github");

    try {
      if (links.length === 0) {
        // Truly-local ticket (no link for any source) -> create GitHub issue.
        const res = await fetchImpl(`${GH_API}/repos/${owner}/${name}/issues`, {
          method: "POST",
          headers,
          body: JSON.stringify({ title: t.title, body: t.body }),
        });
        if (res.status === 403 || res.status === 429) {
          console.warn(`GitHub push stopped: rate limited (${res.status})`);
          return result; // stop the push phase, do not throw
        }
        if (!res.ok) { result.pushFailed++; continue; }
        const issue = (await res.json()) as { number: number; updated_at?: string };
        await db.insert(syncLinks).values({
          source: "github",
          externalId: `${repo}#${issue.number}`, // MUST match pull's format
          ticketId: t.id,
          externalUpdatedAt: new Date(issue.updated_at ?? Date.now()),
        });
        result.pushed++;
      } else if (ghLink && t.status === "closed") {
        // Close the github issue only if it is currently open (idempotent: a
        // second run reads state=closed and issues no PATCH).
        const number = ghLink.externalId.split("#")[1];
        const getRes = await fetchImpl(`${GH_API}/repos/${owner}/${name}/issues/${number}`, { headers });
        if (getRes.status === 403 || getRes.status === 429) {
          console.warn(`GitHub push stopped: rate limited (${getRes.status})`);
          return result;
        }
        if (!getRes.ok) { result.pushFailed++; continue; }
        const issue = (await getRes.json()) as { state: string };
        if (issue.state === "open") {
          const patchRes = await fetchImpl(`${GH_API}/repos/${owner}/${name}/issues/${number}`, {
            method: "PATCH",
            headers,
            body: JSON.stringify({ state: "closed" }),
          });
          if (patchRes.status === 403 || patchRes.status === 429) {
            console.warn(`GitHub push stopped: rate limited (${patchRes.status})`);
            return result;
          }
          if (!patchRes.ok) { result.pushFailed++; continue; }
          result.closed++;
        }
      }
    } catch (e) {
      console.error(`push failed for ticket ${t.id}:`, (e as Error).message);
      result.pushFailed++;
    }
  }
  return result;
}
