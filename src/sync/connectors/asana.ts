import { getSetting } from "../../services/settings.js";
import type { SourceConnector, ExternalTicket, ExternalComment } from "../connector.js";

export function makeAsanaConnector(fetchImpl: typeof fetch = fetch): SourceConnector {
  async function paginatedGet(urlStr: string, headers: Record<string, string>): Promise<any[]> {
    const results: any[] = [];
    let currentUrl: string | null = urlStr;
    let pages = 0;
    while (currentUrl && pages < 10) {
      const res = await fetchImpl(currentUrl, { headers });
      if (!res.ok) {
        throw new Error(`Asana API error: ${res.status} ${res.statusText}`);
      }
      const data = await res.json();
      results.push(...data.data);
      pages++;
      if (data.next_page?.offset) {
        const url: URL = new URL(currentUrl);
        url.searchParams.set("offset", data.next_page.offset);
        currentUrl = url.toString();
      } else {
        currentUrl = null;
      }
    }
    return results;
  }

  return {
    source: "asana",
    async listExternalTickets(since?: Date): Promise<ExternalTicket[]> {
      const pat = await getSetting("asana.pat");
      const projectGid = await getSetting("asana.projectGid");

      if (!pat || !projectGid) {
        console.warn("Asana connector skipped: missing asana.pat or asana.projectGid setting");
        return [];
      }

      const headers = { "Authorization": `Bearer ${pat}` };
      const tasksUrl = new URL("https://app.asana.com/api/1.0/tasks");
      tasksUrl.searchParams.set("project", projectGid);
      tasksUrl.searchParams.set("opt_fields", "name,notes,completed,modified_at");
      tasksUrl.searchParams.set("limit", "50");
      if (since) {
        tasksUrl.searchParams.set("modified_since", since.toISOString());
      }

      const tasks = await paginatedGet(tasksUrl.toString(), headers);
      const out: ExternalTicket[] = [];

      for (const task of tasks) {
        const storiesUrl = new URL(`https://app.asana.com/api/1.0/tasks/${task.gid}/stories`);
        storiesUrl.searchParams.set("opt_fields", "type,text,created_by.name,created_at");

        const storiesRes = await fetchImpl(storiesUrl.toString(), { headers });
        if (!storiesRes.ok) {
          throw new Error(`Asana API error: ${storiesRes.status} ${storiesRes.statusText}`);
        }
        const storiesData = await storiesRes.json();

        const comments: ExternalComment[] = (storiesData.data || [])
          .filter((s: any) => s.type === "comment")
          .map((s: any) => ({
            externalId: `asana:${task.gid}:story:${s.gid}`,
            author: s.created_by?.name ?? "unknown",
            body: s.text ?? "",
            createdAt: s.created_at,
          }));

        out.push({
          externalId: `asana:${projectGid}:${task.gid}`,
          title: task.name,
          body: task.notes ?? "",
          status: task.completed ? "closed" : "open",
          updatedAt: task.modified_at,
          comments,
        });
      }

      return out;
    },
  };
}
