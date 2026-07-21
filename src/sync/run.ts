import { makeGithubConnector } from "./connectors/github.js";
import { makeGitLabConnector } from "./connectors/gitlab.js";
import { makeJiraConnector } from "./connectors/jira.js";
import { makeAsanaConnector } from "./connectors/asana.js";
import { runSync, type SyncResult } from "./import.js";
import { getProjectSettings } from "../services/projects.js";
import type { SourceConnector } from "./connector.js";

// binding-key -> factory. `binding` optional so the CLI's legacy env-var path
// (no per-project binding) can still call factory() and fall back to global settings.
export const CONNECTOR_FACTORIES: Record<string, (binding?: string) => SourceConnector> = {
  "github.repo": (b) => makeGithubConnector(undefined, b),
  "gitlab.project": (b) => makeGitLabConnector(undefined, b),
  "jira.project": (b) => makeJiraConnector(undefined, b),
  "asana.projectGid": (b) => makeAsanaConnector(undefined, b),
};

export type SyncProjectResult = SyncResult & { bindings: number };

// Runs every bound connector for one project in-process, aggregating results.
// Re-throws a connector-level failure (e.g. GitHub 404 on a bad repo) so the
// caller can surface it. Missing global credential -> connector returns [] (no
// throw); reflected as bindings>0 with zero created (UI hints via hasGlobalCredential).
export async function syncProject(projectId: string): Promise<SyncProjectResult> {
  const settings = await getProjectSettings(projectId);
  const total: SyncProjectResult = { created: 0, updated: 0, skipped: 0, commentsAdded: 0, failed: 0, bindings: 0 };
  for (const [key, factory] of Object.entries(CONNECTOR_FACTORIES)) {
    const binding = settings[key];
    if (!binding) continue;
    const r = await runSync(factory(binding), { projectId });
    total.created += r.created;
    total.updated += r.updated;
    total.skipped += r.skipped;
    total.commentsAdded += r.commentsAdded;
    total.failed += r.failed;
    total.bindings += 1;
  }
  return total;
}
