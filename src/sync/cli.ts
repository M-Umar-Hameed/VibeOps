import { pathToFileURL } from "node:url";
import { Octokit } from "@octokit/rest";
import { makeGithubConnector } from "./connectors/github.js";
import { runSync } from "./import.js";

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repo = process.env.SYNC_GITHUB_REPO;
  const projectId = process.env.SYNC_GITHUB_PROJECT;
  if (!repo || !projectId) throw new Error("SYNC_GITHUB_REPO and SYNC_GITHUB_PROJECT are required");
  const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
  const result = await runSync(makeGithubConnector(octokit, repo), { projectId });
  console.log(JSON.stringify(result));
}
