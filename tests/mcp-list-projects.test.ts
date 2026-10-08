import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createActor } from "../src/services/actors.js";
import { buildServer } from "../src/mcp/server.js";
import { createProject, updateProjectRepo } from "../src/services/projects.js";

function uniq(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function connectedClient() {
  const { apiKey } = await createActor({ name: uniq("mcp-lp"), kind: "agent" });
  const server = await buildServer(apiKey);
  const [c, s] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0.0.0" });
  await Promise.all([server.connect(s), client.connect(c)]);
  return client;
}

function rows(res: unknown): Array<{ id: string; key: string; repoPath: string | null }> {
  const content = (res as { content: Array<{ type: string; text: string }> }).content;
  return JSON.parse(content[0].text);
}

describe("MCP list_projects", () => {
  it("is advertised in the tool list", async () => {
    const client = await connectedClient();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("list_projects");
  });

  it("takes no arguments and returns projects with id, key and repoPath", async () => {
    const key = uniq("lp").toLowerCase();
    const project = await createProject({ key, name: "List Projects Fixture" });

    const client = await connectedClient();
    const res = await client.callTool({ name: "list_projects", arguments: {} });
    const found = rows(res).find((p) => p.id === project.id);

    expect(found).toBeDefined();
    expect(found!.key).toBe(key);
    expect(found).toHaveProperty("repoPath");
  });

  it("reports repoPath so an agent can map a repo to a projectId", async () => {
    const key = uniq("lp-repo").toLowerCase();
    const project = await createProject({ key, name: "Repo Mapped" });
    const repoPath = process.cwd();
    await updateProjectRepo(project.id, repoPath);

    const client = await connectedClient();
    const found = rows(await client.callTool({ name: "list_projects", arguments: {} }))
      .find((p) => p.id === project.id);

    expect(found!.repoPath).toBe(repoPath);
  });
});
