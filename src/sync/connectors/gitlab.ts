import { getSetting } from "../../services/settings.js";
import type { SourceConnector, ExternalTicket, ExternalComment } from "../connector.js";

export function makeGitLabConnector(fetchImpl: typeof fetch = fetch): SourceConnector {
  async function paginatedGet(urlStr: string, headers: Record<string, string>): Promise<any[]> {
    const results: any[] = [];
    let currentUrl: string | null = urlStr;
    let pages = 0;
    while (currentUrl && pages < 10) {
      const res = await fetchImpl(currentUrl, { headers });
      if (!res.ok) {
        throw new Error(`GitLab API error: ${res.status} ${res.statusText}`);
      }
      const data = await res.json();
      results.push(...data);
      pages++;
      const nextPage = res.headers.get("X-Next-Page");
      if (nextPage) {
        const url = new URL(currentUrl);
        url.searchParams.set("page", nextPage);
        currentUrl = url.toString();
      } else {
        currentUrl = null;
      }
    }
    return results;
  }

  return {
    source: "gitlab",
    async listExternalTickets(since?: Date): Promise<ExternalTicket[]> {
      const token = await getSetting("gitlab.token");
      const project = await getSetting("gitlab.project");
      const baseUrl = (await getSetting("gitlab.baseUrl")) || "https://gitlab.com";

      if (!token || !project) {
        console.warn("GitLab connector skipped: missing gitlab.token or gitlab.project setting");
        return [];
      }

      const headers = { "PRIVATE-TOKEN": token };
      const issuesUrl = new URL(`${baseUrl}/api/v4/projects/${project}/issues`);
      issuesUrl.searchParams.set("order_by", "updated_at");
      issuesUrl.searchParams.set("sort", "asc");
      issuesUrl.searchParams.set("per_page", "50");
      if (since) {
        issuesUrl.searchParams.set("updated_after", since.toISOString());
      }

      const issues = await paginatedGet(issuesUrl.toString(), headers);
      const out: ExternalTicket[] = [];

      for (const issue of issues) {
        const notesUrl = new URL(`${baseUrl}/api/v4/projects/${project}/issues/${issue.iid}/notes`);
        notesUrl.searchParams.set("sort", "asc");
        const notes = await paginatedGet(notesUrl.toString(), headers);

        const comments: ExternalComment[] = notes
          .filter((n: any) => n.system === false)
          .map((n: any) => ({
            externalId: `gitlab:${project}:${issue.iid}#note-${n.id}`,
            author: n.author?.username ?? "unknown",
            body: n.body ?? "",
            createdAt: n.created_at,
          }));

        out.push({
          externalId: `gitlab:${project}:${issue.iid}`,
          title: issue.title,
          body: issue.description ?? "",
          status: issue.state === "closed" ? "closed" : "open",
          updatedAt: issue.updated_at,
          comments,
        });
      }

      return out;
    },
  };
}
