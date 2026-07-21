import { getSetting } from "../../services/settings.js";
import type { SourceConnector, ExternalTicket, ExternalComment } from "../connector.js";
import { normalizeBinding } from "../binding.js";

export function makeGithubConnector(fetchImpl: typeof fetch = fetch, bindingOverride?: string): SourceConnector {
  async function paginatedGet(urlStr: string, headers: Record<string, string>): Promise<any[]> {
    const results: any[] = [];
    let currentUrl: string | null = urlStr;
    let pages = 0;
    while (currentUrl && pages < 10) {
      const res: Response = await fetchImpl(currentUrl, { headers });
      if (!res.ok) {
        throw new Error(`GitHub API error: ${res.status} ${res.statusText}`);
      }
      const data = (await res.json()) as unknown[];
      results.push(...data);
      pages++;
      const link: string | null = res.headers.get("Link");
      const next: string | undefined = link?.split(",").find((p: string) => p.includes('rel="next"'));
      const match: RegExpMatchArray | null | undefined = next?.match(/<([^>]+)>/);
      currentUrl = match ? match[1] : null;
    }
    return results;
  }

  return {
    source: "github",
    async listExternalTickets(since?: Date): Promise<ExternalTicket[]> {
      const token = await getSetting("github.token");
      const rawRepo = bindingOverride ?? (await getSetting("github.repo"));

      if (!token || !rawRepo) {
        console.warn("GitHub connector skipped: missing github.token or github.repo setting");
        return [];
      }

      const repo = normalizeBinding(rawRepo); // heals pre-existing full-URL rows
      const [owner, name] = repo.split("/");
      const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" };

      const issuesUrl = new URL(`https://api.github.com/repos/${owner}/${name}/issues`);
      issuesUrl.searchParams.set("state", "all");
      issuesUrl.searchParams.set("sort", "updated");
      issuesUrl.searchParams.set("direction", "asc");
      issuesUrl.searchParams.set("per_page", "100");
      if (since) issuesUrl.searchParams.set("since", since.toISOString());

      const issues = (await paginatedGet(issuesUrl.toString(), headers)) as any[];
      const out: ExternalTicket[] = [];

      for (const issue of issues) {
        if (issue.pull_request) continue; // issues endpoint returns PRs too

        const commentsUrl = new URL(`https://api.github.com/repos/${owner}/${name}/issues/${issue.number}/comments`);
        commentsUrl.searchParams.set("per_page", "100");
        const rawComments = await paginatedGet(commentsUrl.toString(), headers);

        const comments: ExternalComment[] = rawComments.map((c: any) => ({
          externalId: `${repo}#comment-${c.id}`,
          author: c.user?.login ?? "unknown",
          body: c.body ?? "",
          createdAt: c.created_at,
        }));

        out.push({
          externalId: `${repo}#${issue.number}`,
          title: issue.title,
          body: issue.body ?? "",
          status: issue.state === "closed" ? "closed" : "open",
          updatedAt: issue.updated_at,
          comments,
        });
      }

      return out;
    },
  };
}
