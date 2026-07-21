import { pathToFileURL } from "node:url";
import { CONNECTOR_FACTORIES } from "./run.js";
import { runSync } from "./import.js";
import { boundProjects } from "../services/projects.js";

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  async function runConnector(key: string, legacyProject?: string) {
    const factory = CONNECTOR_FACTORIES[key];
    const bindings = await boundProjects(key);
    if (bindings.length > 0) {
      for (const { projectId, binding } of bindings) {
        try {
          const result = await runSync(factory(binding), { projectId });
          console.log(JSON.stringify(result));
        } catch (e) {
          console.error(`${key} sync run failed for binding ${binding}:`, (e as Error).message);
          process.exitCode = 1;
        }
      }
    } else if (legacyProject) {
      try {
        const result = await runSync(factory(), { projectId: legacyProject });
        console.log(JSON.stringify(result));
      } catch (e) {
        console.error(`${key.split('.')[0]} sync run failed:`, (e as Error).message);
        process.exit(1);
      }
    }
  }

  await runConnector("github.repo", process.env.SYNC_GITHUB_PROJECT);
  await runConnector("gitlab.project", process.env.SYNC_GITLAB_TARGET_PROJECT);
  await runConnector("jira.project", process.env.SYNC_JIRA_TARGET_PROJECT);
  await runConnector("asana.projectGid", process.env.SYNC_ASANA_TARGET_PROJECT);
}
