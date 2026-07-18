import { pathToFileURL } from "node:url";
import { Octokit } from "@octokit/rest";
import { makeGithubConnector } from "./connectors/github.js";
import { makeGitLabConnector } from "./connectors/gitlab.js";
import { makeJiraConnector } from "./connectors/jira.js";
import { makeAsanaConnector } from "./connectors/asana.js";
import { runSync } from "./import.js";

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repo = process.env.SYNC_GITHUB_REPO;
  const projectId = process.env.SYNC_GITHUB_PROJECT;
  if (!repo || !projectId) throw new Error("SYNC_GITHUB_REPO and SYNC_GITHUB_PROJECT are required");
  const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
  try {
    const result = await runSync(makeGithubConnector(octokit, repo), { projectId });
    console.log(JSON.stringify(result));
  } catch (e) {
    console.error("sync run failed:", (e as Error).message);
    process.exit(1);
  }

  const gitlabProjectId = process.env.SYNC_GITLAB_TARGET_PROJECT;
  if (gitlabProjectId) {
    try {
      const result = await runSync(makeGitLabConnector(), { projectId: gitlabProjectId });
      console.log(JSON.stringify(result));
    } catch (e) {
      console.error("gitlab sync run failed:", (e as Error).message);
      process.exit(1);
    }
  }

  const jiraProjectId = process.env.SYNC_JIRA_TARGET_PROJECT;
  if (jiraProjectId) {
    try {
      const result = await runSync(makeJiraConnector(), { projectId: jiraProjectId });
      console.log(JSON.stringify(result));
    } catch (e) {
      console.error("jira sync run failed:", (e as Error).message);
      process.exit(1);
    }
  }

  const asanaProjectId = process.env.SYNC_ASANA_TARGET_PROJECT;
  if (asanaProjectId) {
    try {
      const result = await runSync(makeAsanaConnector(), { projectId: asanaProjectId });
      console.log(JSON.stringify(result));
    } catch (e) {
      console.error("asana sync run failed:", (e as Error).message);
      process.exit(1);
    }
  }
}
