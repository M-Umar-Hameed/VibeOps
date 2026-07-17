import { expect, test } from "vitest";
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Real HTTP integration: /mcp cannot be exercised via app.fetch (it needs the
// node-server raw req/res), so boot the dev entrypoint on an ephemeral port.
test("MCP over HTTP: 401 keyless, tools listed with key, config + install endpoints", { timeout: 120_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "vibeops-mcp-http-"));
  const port = 18983;
  const env = { ...process.env, HOME: home, USERPROFILE: home, PORT: String(port) };
  delete (env as Record<string, unknown>).DATABASE_URL;
  delete (env as Record<string, unknown>).VITEST;
  const child: ChildProcess = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "src/api/server.ts"], { env, stdio: "ignore" });
  try {
    let key = "";
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        key = JSON.parse(readFileSync(join(home, ".vibeops", "credentials.json"), "utf-8")).apiKey;
        const ping = await fetch(`http://127.0.0.1:${port}/projects`, { headers: { Authorization: `Bearer ${key}` } });
        if (ping.status === 200) break;
      } catch { /* not up yet */ }
    }
    expect(key).not.toBe("");

    // 401 without key
    const noAuth = await fetch(`http://127.0.0.1:${port}/mcp/config`);
    expect(noAuth.status).toBe(401);

    // config endpoint echoes caller key material
    const cfgRes = await fetch(`http://127.0.0.1:${port}/mcp/config`, { headers: { Authorization: `Bearer ${key}` } });
    expect(cfgRes.status).toBe(200);
    const cfg = await cfgRes.json();
    expect(cfg.url).toBe(`http://127.0.0.1:${port}/mcp`);
    expect(cfg.claudeCode.command).toContain(key);

    // real MCP handshake via SDK client
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    const client = new Client({ name: "test", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${key}` } },
    });
    await client.connect(transport);
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toEqual(["comment", "create_ticket", "delete_note", "fetch_docs", "get_ticket_history", "list_notes", "save_note", "search_knowledge", "search_tickets", "update_note", "update_ticket"].sort());
    await client.close();

    // install endpoint writes into (temp) HOME
    const inst = await fetch(`http://127.0.0.1:${port}/mcp/install`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ client: "cursor" }),
    });
    expect(inst.status).toBe(200);
    const written = JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf-8"));
    expect(written.mcpServers.vibeops.url).toBe(`http://127.0.0.1:${port}/mcp`);

    const bad = await fetch(`http://127.0.0.1:${port}/mcp/install`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ client: "nope" }),
    });
    expect(bad.status).toBe(400);
  } finally {
    child.kill();
    try { execSync(process.platform === "win32" ? `taskkill /pid ${child.pid} /T /F` : `kill -9 ${child.pid}`); } catch { /* already dead */ }
  }
});
