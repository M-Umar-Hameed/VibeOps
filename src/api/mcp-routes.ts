import type { Hono } from "hono";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import type { Actor } from "../db/schema.js";
import { buildServer } from "../mcp/server.js";
import { buildMcpConfig, installClientConfig, type InstallableClient } from "../mcp/clients.js";
import { requireAdmin } from "./auth.js";

type AppEnv = { Variables: { actor: Actor } };

function bearer(authHeader: string | undefined): string {
  return (authHeader ?? "").replace(/^Bearer\s+/i, "");
}

export function registerMcpRoutes(app: Hono<AppEnv>): void {
  // Order matters: /mcp/config and /mcp/install BEFORE the catch-all /mcp.
  app.get("/mcp/config", (c) => {
    const url = `http://127.0.0.1:${process.env.PORT ?? 8787}/mcp`;
    return c.json(buildMcpConfig(url, bearer(c.req.header("authorization"))));
  });

  app.post("/mcp/install", requireAdmin, async (c) => {
    const { client } = await c.req.json().catch(() => ({}));
    if (client !== "cursor" && client !== "gemini") {
      return c.json({ error: `unknown client: ${String(client)}` }, 400);
    }
    const url = `http://127.0.0.1:${process.env.PORT ?? 8787}/mcp`;
    try {
      return c.json(installClientConfig(client as InstallableClient, url, bearer(c.req.header("authorization"))));
    } catch (e) {
      return c.json({ error: (e as Error).message }, 409);
    }
  });

  app.all("/mcp", async (c) => {
    const { StreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
    const server = await buildServer(bearer(c.req.header("authorization")));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    // Raw node req/res from @hono/node-server; hono must not write the response itself.
    const { incoming, outgoing } = c.env as unknown as { incoming: import("node:http").IncomingMessage; outgoing: import("node:http").ServerResponse };
    const body = c.req.method === "POST" ? await c.req.json().catch(() => undefined) : undefined;
    outgoing.on("close", () => { void transport.close(); void server.close(); });
    await transport.handleRequest(incoming, outgoing, body);
    return RESPONSE_ALREADY_SENT;
  });
}
