# One-Click MCP Config Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agents (Claude Code, Cursor, Gemini CLI) connect to VibeOps over MCP with one action: MCP served over streamable HTTP by the existing sidecar at `/mcp`, plus endpoints that emit/write client configs carrying the caller's API key.

**Architecture:** Reuse `buildServer(apiKey)` (src/mcp/server.ts) unchanged; mount it per-request on Hono via the MCP SDK's `StreamableHTTPServerTransport` in stateless mode, delegating to the raw node req/res that @hono/node-server exposes. Pure config-snippet builders + non-destructive merge-writers live in a new `src/mcp/clients.ts`. All new REST routes live in a new `src/api/mcp-routes.ts` registered from app.ts with a 2-line hook (app.ts carries unrelated uncommitted user WIP — the controller stages that hook surgically; implementers NEVER commit app.ts).

**Tech Stack:** `@modelcontextprotocol/sdk` (already a dependency — `server/streamableHttp.js`, `client/streamableHttp.js` for tests), `@hono/node-server` `RESPONSE_ALREADY_SENT`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-12-mcp-oneclick-design.md`.
- PGlite is single-process: NO new spawned processes; MCP must run inside the existing server process.
- `src/api/app.ts` and `src/api/server.ts` contain the USER's uncommitted WIP. You may ADD the 2-line registration hook to app.ts in the working tree, but NEVER `git add` app.ts or server.ts (or any `app/src` file the task doesn't create, or `src/services/settings.ts`, `src/ingest/watch.ts`, drizzle 0002 files). Stage ONLY files your task creates/owns. The controller commits the app.ts hook.
- Auth: `/mcp*` routes sit behind the existing bearer middleware like every route; `GET /mcp/config` echoes only the CALLER's key (from the Authorization header), never another actor's.
- Existing `vibeops` entries in client config files are overwritten on re-install; other entries and unrelated settings are preserved byte-for-byte semantically (parse → merge → write). A file that fails JSON.parse is NEVER touched or backed up — the install errors instead.
- Never push. Commit per task on `master`. Suite needs Docker PG on :5433.

---

### Task 1: Client config builders + merge-writer (`src/mcp/clients.ts`)

**Files:**
- Create: `src/mcp/clients.ts`
- Test: `tests/mcp-clients.test.ts` (create)

**Interfaces:**
- Consumes: nothing from other tasks (pure module: node:fs, node:path, node:os).
- Produces (Task 2 imports these exact names):
  - `buildMcpConfig(url: string, apiKey: string): { url: string; claudeCode: { command: string }; cursor: { path: string; snippet: object }; gemini: { path: string; snippet: object } }`
  - `installClientConfig(client: "cursor" | "gemini", url: string, apiKey: string, homeDir?: string): { path: string; backedUp: boolean }` (throws `Error` with message containing "unparseable" for corrupt existing JSON; `homeDir` defaults to `os.homedir()`)

- [ ] **Step 1: Write the failing tests**

Create `tests/mcp-clients.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMcpConfig, installClientConfig } from "../src/mcp/clients.js";

const URL = "http://127.0.0.1:8787/mcp";
const KEY = "test-key-123";

describe("buildMcpConfig", () => {
  it("builds the three client materials", () => {
    const c = buildMcpConfig(URL, KEY);
    expect(c.url).toBe(URL);
    expect(c.claudeCode.command).toBe(
      `claude mcp add --transport http vibeops ${URL} --header "Authorization: Bearer ${KEY}"`);
    expect(c.cursor.snippet).toEqual(
      { mcpServers: { vibeops: { url: URL, headers: { Authorization: `Bearer ${KEY}` } } } });
    expect(c.gemini.snippet).toEqual(
      { mcpServers: { vibeops: { httpUrl: URL, headers: { Authorization: `Bearer ${KEY}` } } } });
    expect(c.cursor.path.replace(/\\/g, "/")).toContain(".cursor/mcp.json");
    expect(c.gemini.path.replace(/\\/g, "/")).toContain(".gemini/settings.json");
  });
});

describe("installClientConfig", () => {
  it("creates a fresh cursor config", () => {
    const home = mkdtempSync(join(tmpdir(), "vibeops-mcp-"));
    const r = installClientConfig("cursor", URL, KEY, home);
    expect(r.backedUp).toBe(false);
    const written = JSON.parse(readFileSync(r.path, "utf-8"));
    expect(written.mcpServers.vibeops.url).toBe(URL);
  });

  it("merges into an existing gemini settings file, preserving unrelated keys, and backs up", () => {
    const home = mkdtempSync(join(tmpdir(), "vibeops-mcp-"));
    mkdirSync(join(home, ".gemini"), { recursive: true });
    const p = join(home, ".gemini", "settings.json");
    writeFileSync(p, JSON.stringify({ theme: "dark", mcpServers: { other: { command: "x" } } }));
    const r = installClientConfig("gemini", URL, KEY, home);
    expect(r.backedUp).toBe(true);
    expect(existsSync(p + ".vibeops-backup")).toBe(true);
    const written = JSON.parse(readFileSync(p, "utf-8"));
    expect(written.theme).toBe("dark");
    expect(written.mcpServers.other.command).toBe("x");
    expect(written.mcpServers.vibeops.httpUrl).toBe(URL);
  });

  it("overwrites a prior vibeops entry on re-install", () => {
    const home = mkdtempSync(join(tmpdir(), "vibeops-mcp-"));
    installClientConfig("cursor", URL, "old-key", home);
    const r = installClientConfig("cursor", URL, KEY, home);
    const written = JSON.parse(readFileSync(r.path, "utf-8"));
    expect(written.mcpServers.vibeops.headers.Authorization).toBe(`Bearer ${KEY}`);
  });

  it("refuses to touch an unparseable file", () => {
    const home = mkdtempSync(join(tmpdir(), "vibeops-mcp-"));
    mkdirSync(join(home, ".cursor"), { recursive: true });
    const p = join(home, ".cursor", "mcp.json");
    writeFileSync(p, "{not json");
    expect(() => installClientConfig("cursor", URL, KEY, home)).toThrow(/unparseable/);
    expect(readFileSync(p, "utf-8")).toBe("{not json");
    expect(existsSync(p + ".vibeops-backup")).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/mcp-clients.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/mcp/clients.ts`**

```ts
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const CLIENTS = {
  cursor: {
    rel: [".cursor", "mcp.json"],
    entry: (url: string, key: string) => ({ url, headers: { Authorization: `Bearer ${key}` } }),
  },
  gemini: {
    rel: [".gemini", "settings.json"],
    entry: (url: string, key: string) => ({ httpUrl: url, headers: { Authorization: `Bearer ${key}` } }),
  },
} as const;
export type InstallableClient = keyof typeof CLIENTS;

export function buildMcpConfig(url: string, apiKey: string) {
  const path = (c: InstallableClient) => join(homedir(), ...CLIENTS[c].rel);
  return {
    url,
    claudeCode: {
      command: `claude mcp add --transport http vibeops ${url} --header "Authorization: Bearer ${apiKey}"`,
    },
    cursor: { path: path("cursor"), snippet: { mcpServers: { vibeops: CLIENTS.cursor.entry(url, apiKey) } } },
    gemini: { path: path("gemini"), snippet: { mcpServers: { vibeops: CLIENTS.gemini.entry(url, apiKey) } } },
  };
}

export function installClientConfig(
  client: InstallableClient, url: string, apiKey: string, homeDir: string = homedir(),
): { path: string; backedUp: boolean } {
  const spec = CLIENTS[client];
  if (!spec) throw new Error(`unknown client: ${client}`);
  const path = join(homeDir, ...spec.rel);
  let existing: Record<string, unknown> = {};
  let backedUp = false;
  if (existsSync(path)) {
    const raw = readFileSync(path, "utf-8");
    try {
      existing = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new Error(`unparseable JSON at ${path}; not touching it`);
    }
    copyFileSync(path, path + ".vibeops-backup");
    backedUp = true;
  }
  const servers = (existing.mcpServers ?? {}) as Record<string, unknown>;
  servers.vibeops = spec.entry(url, apiKey);
  existing.mcpServers = servers;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(existing, null, 2) + "\n");
  return { path, backedUp };
}
```

- [ ] **Step 4: Run tests** — `npx vitest run tests/mcp-clients.test.ts` — Expected: PASS (5).

- [ ] **Step 5: Typecheck + commit**

```bash
npx tsc --noEmit
git add src/mcp/clients.ts tests/mcp-clients.test.ts
git commit -m "feat: mcp client config builders and merge-writer"
```

---

### Task 2: HTTP MCP mount + config/install routes (`src/api/mcp-routes.ts`)

**Files:**
- Create: `src/api/mcp-routes.ts`
- Modify (WORKING TREE ONLY — never `git add` it): `src/api/app.ts` (2-line hook)
- Test: `tests/mcp-http.test.ts` (create)

**Interfaces:**
- Consumes: `buildServer(apiKey)` from `src/mcp/server.ts` (Task 0 — exists); `buildMcpConfig`, `installClientConfig`, `InstallableClient` from Task 1.
- Produces: `export function registerMcpRoutes(app: Hono<AppEnv>): void` where `AppEnv` matches app.ts's `{ Variables: { actor: Actor } }`. Routes: `ALL /mcp`, `GET /mcp/config`, `POST /mcp/install`.

- [ ] **Step 1: Write the failing integration test**

Create `tests/mcp-http.test.ts` — boots the REAL server (embedded PGlite, temp home) exactly like tests/sidecar-payload.test.ts does, then drives a real MCP handshake with the SDK client:

```ts
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
    expect(names).toEqual(["comment", "create_ticket", "get_ticket_history", "save_note", "search_knowledge", "search_tickets", "update_ticket"].sort());
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
```

CAVEAT for the implementer: the install test writes to the TEMP home because the spawned server inherits `HOME`/`USERPROFILE` — `installClientConfig` defaults to `os.homedir()` in the SERVER process, which honors those env vars. Never point it at the real home in tests.

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/mcp-http.test.ts` — Expected: FAIL (404s: routes missing).

- [ ] **Step 3: Implement `src/api/mcp-routes.ts`**

```ts
import type { Hono } from "hono";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import type { Actor } from "../db/schema.js";
import { buildServer } from "../mcp/server.js";
import { buildMcpConfig, installClientConfig, type InstallableClient } from "../mcp/clients.js";

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

  app.post("/mcp/install", async (c) => {
    const { client } = await c.req.json();
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
```

If the SDK's transport import path or option names differ in the installed @modelcontextprotocol/sdk version, adapt to the real API (check node_modules/@modelcontextprotocol/sdk/dist — the contract that must hold: stateless per-request transport, raw req/res delegation, RESPONSE_ALREADY_SENT). Note deviations in your report.

- [ ] **Step 4: Hook into app.ts (WORKING TREE ONLY)**

In `src/api/app.ts` add after the other imports:

```ts
import { registerMcpRoutes } from "./mcp-routes.js";
```

and at the END of the route registrations (after the last `app.get`):

```ts
registerMcpRoutes(app);
```

DO NOT `git add src/api/app.ts` — the controller stages this hook separately (the file carries unrelated uncommitted user work).

- [ ] **Step 5: Run the integration test** — `npx vitest run tests/mcp-http.test.ts` — Expected: PASS.

- [ ] **Step 6: Full suite + typecheck** — `npm test && npx tsc --noEmit` — Expected: green (55+ tests).

- [ ] **Step 7: Commit (new files only)**

```bash
git add src/api/mcp-routes.ts tests/mcp-http.test.ts
git commit -m "feat: MCP over streamable HTTP with one-click client config endpoints"
git status --short   # verify app.ts remains modified-uncommitted
```

---

### Task 3: UI card (unwired) + README

**Files:**
- Create: `app/src/components/settings/McpConnectCard.tsx`
- Modify: `README.md`

**Interfaces:**
- Consumes: REST endpoints from Task 2 (`GET /mcp/config`, `POST /mcp/install`) via the app's existing api helper `app/src/lib/api.ts` (read it first — use its request pattern and error types).
- Produces: a self-contained exported React component `McpConnectCard` (no props or all-optional). NOT imported anywhere — the user wires it into their settings tabs themselves.

- [ ] **Step 1: Read the app's existing patterns**

Read `app/src/lib/api.ts` and one existing settings card (e.g. `git show HEAD:app/src/components/settings/IntegrationsTab.tsx` — use the COMMITTED version as style reference; the working-tree file is user WIP). Match fetch style, styling classes, and error display conventions.

- [ ] **Step 2: Implement `McpConnectCard.tsx`**

Component behavior (adapt markup to the app's existing card style):
- On mount, GET `/mcp/config`; show the MCP URL.
- Three rows: Claude Code — the `claudeCode.command` in a readonly input + Copy button (navigator.clipboard.writeText); Cursor and Gemini — an "Install" button each that POSTs `/mcp/install` with `{ client }`, then shows the written path (or the error message on failure, e.g. unparseable existing config).
- Handle 401/network errors with the app's standard error display.

- [ ] **Step 3: Compile check**

Run: `cd app && npx tsc --noEmit` — the USER's WIP files currently have known errors (Sidebar.tsx unused var, ObsidianIntegrationCard/ProviderCard missing module). REQUIRED: zero errors mentioning `McpConnectCard.tsx`; user-WIP errors are accepted and listed in the report.

- [ ] **Step 4: README**

Add a "Connect an agent (MCP)" section: the sidecar serves MCP at `http://127.0.0.1:8787/mcp` (streamable HTTP, same API key as REST); one-click from the app's MCP card (Cursor/Gemini config written automatically with a `.vibeops-backup` of any existing file; Claude Code gets a copy-paste `claude mcp add` command); `GET /mcp/config` / `POST /mcp/install` for scripting; the legacy stdio `npm run mcp` remains for external-Postgres setups. Note keys land in client config files in plaintext — same trust level as `~/.vibeops/credentials.json`.

- [ ] **Step 5: Commit**

```bash
git add app/src/components/settings/McpConnectCard.tsx README.md
git commit -m "feat: MCP connect card and agent connection docs"
```

---

## Final review (controller)

Controller stages the app.ts 2-line hook via index-only patch and commits it. Then: review package from pre-slice commit to HEAD, opus whole-branch final review (esp. auth on /mcp, config-file safety, transport lifecycle leaks), fix wave, gates, ledger + memory.
