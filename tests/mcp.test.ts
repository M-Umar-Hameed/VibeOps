import { expect, test } from "vitest";
import { createActor } from "../src/services/actors.js";
import { buildServer } from "../src/mcp/server.js";

test("mcp server builds for a valid actor key", async () => {
  const { apiKey } = await createActor({ name: "mcp-agent", kind: "agent" });
  const server = await buildServer(apiKey);
  expect(server).toBeDefined();
});
