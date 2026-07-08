# Phase 3 — Tauri Desktop App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Tauri 2 + React desktop app under `app/` that is a pure client over the Phase 1/2 REST API — ticket list/detail/create, comments, audit timeline, and a knowledge search/save panel — plus three small server read/create endpoints the UI needs. Zero business logic in the app.

**Architecture:** Server additions first (`GET/POST /projects`, `GET /actors`), then a typed API client (via `@tauri-apps/plugin-http`, bearer-injected, error-mapped), then the React screens driven by TanStack Query with refetch-on-focus and 409-recovery. All state/locking/audit stays server-side.

**Tech Stack:** Tauri 2 (`@tauri-apps/cli ^2.10`), React 19, Vite 7, Vitest 4, TypeScript 6, `@tanstack/react-query ^5`, `@tanstack/react-router ^1`, `@tauri-apps/plugin-http ^2`, `@tauri-apps/plugin-store ^2`, lucide-react, `@testing-library/react ^16`, jsdom.

**Spec:** `docs/superpowers/specs/2026-07-08-phase3-tauri-app-design.md`

## Global Constraints

- Repo `D:\Github\tickets`. Server is Node ESM (`.js` import extensions), Postgres+pgvector on host port 5433 (up). App lives in `app/` (its own package.json).
- The app is a PURE client: no local DB, no direct Postgres access, no business logic in Rust. Everything through the REST API.
- Transport is `@tauri-apps/plugin-http` (bypasses CORS — do NOT add CORS middleware to the server).
- Server additions go through the service layer, behind the existing `auth` middleware. `GET /actors` MUST NOT return `apiKeyHash`. `createProject` writes no audit event.
- Ticket edits are never optimistically applied; `tickets.update` always sends `expectedVersion`, and a 409 triggers reload-and-retry preserving user input.
- Credentials (server URL + API key) live in `@tauri-apps/plugin-store`; never hardcode a key.
- No emojis; minimal comments/logs.
- Reuse Phase 1/2 verbatim: `app` Hono instance + `auth` middleware (`c.get("actor")`), `app.onError` error mapping, `resolveActor`, existing service functions.

## File Structure

Server (existing dirs):
- `src/services/errors.ts` — add `ConflictError`.
- `src/services/projects.ts` — new: `listProjects`, `createProject`.
- `src/services/actors.ts` — add `listActors` (no hash).
- `src/api/app.ts` — add `GET/POST /projects`, `GET /actors`, map `ConflictError`→409.

App (`app/`):
- `app/src-tauri/` — Tauri 2 scaffold + `main.rs` registering plugin-http, plugin-store.
- `app/src/api/{client,errors,types,tickets,comments,history,knowledge,notes,projects,actors}.ts`
- `app/src/settings.ts`
- `app/src/lib/queryClient.ts`
- `app/src/routes/{root,list,detail,create,knowledge,settings}.tsx`
- `app/src/components/{StatusBadge,AuditTimeline,CommentList,Banner}.tsx`
- `app/src/main.tsx`, `app/index.html`, `app/vite.config.ts`, `app/vitest.config.ts`, `app/tsconfig.json`

---

### Task 1: Server — all app-facing read/create endpoints

**Files:**
- Modify: `src/services/errors.ts`, `src/services/actors.ts`, `src/services/history.ts`, `src/services/comments.ts`, `src/api/app.ts`
- Create: `src/services/projects.ts`, `tests/projects-actors.test.ts`

**Interfaces:**
- Produces: `ConflictError` (in errors.ts); `listProjects()`, `createProject({key,name})` (projects.ts); `listActors(): Promise<{id;name;kind;role}[]>` (actors.ts); `getTicket(id): Promise<Ticket>` (throws NotFoundError; in history.ts); `listComments(ticketId): Promise<Comment[]>` (in comments.ts). Routes: `GET /projects`, `POST /projects`, `GET /actors`, `GET /tickets/:id`, `GET /tickets/:id/comments`. `ConflictError`→409 in `app.onError`.

This task contains EVERY server change Phase 3 needs — Task 3 (the app client) only consumes these; it adds no server code.

- [ ] **Step 1: Add `ConflictError` to `src/services/errors.ts`**

```ts
export class ConflictError extends Error {}
```
(append; keep existing AuthError/NotFoundError/StaleVersionError)

- [ ] **Step 2: Create `src/services/projects.ts`**

```ts
import { db } from "../db/client.js";
import { projects, type Project } from "../db/schema.js";
import { ConflictError } from "./errors.js";

export async function listProjects(): Promise<Project[]> {
  return db.select().from(projects);
}

export async function createProject(input: { key: string; name: string }): Promise<Project> {
  try {
    const [p] = await db.insert(projects).values({ key: input.key, name: input.name }).returning();
    return p;
  } catch (e) {
    if (String((e as { code?: string }).code) === "23505") {
      throw new ConflictError(`project key already exists: ${input.key}`);
    }
    throw e;
  }
}
```
Note: `Project` type must be exported from `src/db/schema.ts`. If it is not already, add `export type Project = typeof projects.$inferSelect;` to the schema's type-export block.

- [ ] **Step 3: Add `listActors` to `src/services/actors.ts`**

```ts
import { actors } from "../db/schema.js";
// ...existing imports (db already imported)...

export async function listActors(): Promise<{ id: string; name: string; kind: string; role: string }[]> {
  return db.select({ id: actors.id, name: actors.name, kind: actors.kind, role: actors.role }).from(actors);
}
```
Merge imports; `db` and `actors` may already be imported — do not duplicate. The explicit column select guarantees `apiKeyHash` is never returned.

- [ ] **Step 4: Wire routes + error mapping in `src/api/app.ts`**

Add imports:
```ts
import { listProjects, createProject } from "../services/projects.js";
import { listActors } from "../services/actors.js";
import { ConflictError } from "../services/errors.js";
```
Add to `app.onError` (before the final 500 return):
```ts
  if (err instanceof ConflictError) return c.json({ error: err.message }, 409);
```
Add routes (under the existing `auth` middleware):
```ts
app.get("/projects", async (c) => c.json(await listProjects()));
app.post("/projects", async (c) => {
  const { key, name } = await c.req.json();
  return c.json(await createProject({ key, name }), 201);
});
app.get("/actors", async (c) => c.json(await listActors()));
```

- [ ] **Step 4a: Add `getTicket` to `src/services/history.ts`**

```ts
// add to imports: tickets, type Ticket from schema; eq from drizzle-orm; NotFoundError from ./errors.js
export async function getTicket(id: string): Promise<Ticket> {
  const [t] = await db.select().from(tickets).where(eq(tickets.id, id)).limit(1);
  if (!t) throw new NotFoundError(`ticket ${id}`);
  return t;
}
```
Merge imports; several (`db`, `eq`, `tickets`) are likely already imported — do not duplicate.

- [ ] **Step 4b: Add `listComments` to `src/services/comments.ts`**

```ts
// add to imports: asc from drizzle-orm (eq already imported); type Comment from schema
export async function listComments(ticketId: string): Promise<Comment[]> {
  return db.select().from(comments).where(eq(comments.ticketId, ticketId)).orderBy(asc(comments.createdAt));
}
```

- [ ] **Step 4c: Add the two read routes in `src/api/app.ts`**

```ts
import { getTicket } from "../services/history.js";
import { listComments } from "../services/comments.js";
// routes (under auth):
app.get("/tickets/:id", async (c) => c.json(await getTicket(c.req.param("id"))));
app.get("/tickets/:id/comments", async (c) => c.json(await listComments(c.req.param("id"))));
```
Order note: Hono matches in registration order and `/tickets/:id` is distinct from the existing `/tickets` and `/tickets/:id/history` — register alongside them; no conflict.

- [ ] **Step 5: Write `tests/projects-actors.test.ts`**

```ts
import { expect, test } from "vitest";
import { createActor } from "../src/services/actors.js";
import { app } from "../src/api/app.js";

test("projects + actors endpoints: auth, create, list, no key leak", async () => {
  const { apiKey } = await createActor({ name: "p3", kind: "human" });
  const h = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };

  expect((await app.request("/projects")).status).toBe(401);

  const key = `proj-${Date.now()}`;
  const created = await app.request("/projects", {
    method: "POST", headers: h, body: JSON.stringify({ key, name: "Proj Three" }),
  });
  expect(created.status).toBe(201);

  const dup = await app.request("/projects", {
    method: "POST", headers: h, body: JSON.stringify({ key, name: "again" }),
  });
  expect(dup.status).toBe(409);

  const list = await (await app.request("/projects", { headers: h })).json();
  expect(list.some((p: any) => p.key === key)).toBe(true);

  const actorsList = await (await app.request("/actors", { headers: h })).json();
  expect(actorsList.length).toBeGreaterThan(0);
  expect(actorsList.every((a: any) => !("apiKeyHash" in a))).toBe(true);
});

test("GET /tickets/:id returns a ticket and 404s for a missing id, and lists comments", async () => {
  const { apiKey } = await createActor({ name: "p3b", kind: "human" });
  const h = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
  const proj = await (await app.request("/projects", {
    method: "POST", headers: h, body: JSON.stringify({ key: `pk-${Date.now()}-${Math.random()}`, name: "P" }),
  })).json();
  const ticket = await (await app.request("/tickets", {
    method: "POST", headers: h, body: JSON.stringify({ projectId: proj.id, title: "read me" }),
  })).json();

  const got = await app.request(`/tickets/${ticket.id}`, { headers: h });
  expect(got.status).toBe(200);
  expect((await got.json()).id).toBe(ticket.id);

  const missing = await app.request(`/tickets/00000000-0000-0000-0000-000000000000`, { headers: h });
  expect(missing.status).toBe(404);

  await app.request(`/tickets/${ticket.id}/comments`, { method: "POST", headers: h, body: JSON.stringify({ body: "hi" }) });
  const list = await (await app.request(`/tickets/${ticket.id}/comments`, { headers: h })).json();
  expect(list.some((cm: any) => cm.body === "hi")).toBe(true);
});
```

- [ ] **Step 6: Run tests + typecheck**

Run: `npm test -- projects-actors` then full `npm test` then `npm run typecheck`
Expected: all green; `GET /actors` never leaks `apiKeyHash`.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: add projects and actors read/create endpoints for the app"
```

---

### Task 2: Tauri app scaffold

**Files:**
- Create: `app/` — Tauri 2 + React + Vite + Vitest scaffold, plugins registered.

**Interfaces:**
- Produces a buildable `app/` with `npm run dev` (Vite), `npm run tauri:dev` (Tauri), `npm test` (Vitest). plugin-http + plugin-store registered in Rust and available in JS.

- [ ] **Step 1: Scaffold with create-tauri-app**

From `D:\Github\tickets`, run:
```
npm create tauri-app@latest app -- --template react-ts --manager npm --yes
```
If the flags differ on the installed version, run it and select: frontend = TypeScript/React, bundler = Vite, package manager = npm. Report the exact command that worked. Result: `app/` with `src-tauri/` (Rust) + `src/` (React) + Vite config.

- [ ] **Step 2: Add JS dependencies**

In `app/`:
```
npm install @tanstack/react-query @tanstack/react-router @tauri-apps/plugin-http @tauri-apps/plugin-store lucide-react
npm install -D vitest @testing-library/react @testing-library/jest-dom @testing-library/dom jsdom @vitejs/plugin-react
```

- [ ] **Step 3: Add Rust plugin crates**

In `app/src-tauri/Cargo.toml` dependencies:
```toml
tauri-plugin-http = "2"
tauri-plugin-store = "2"
```

- [ ] **Step 4: Register plugins in `app/src-tauri/src/lib.rs`** (or `main.rs` per the scaffold) — inside the builder chain:

```rust
tauri::Builder::default()
    .plugin(tauri_plugin_http::init())
    .plugin(tauri_plugin_store::Builder::new().build())
    // ...existing invoke_handler etc...
```

- [ ] **Step 5: Add `app/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: { environment: "jsdom", setupFiles: ["./src/test-setup.ts"], globals: true },
});
```
And `app/src/test-setup.ts`:
```ts
import "@testing-library/jest-dom";
```
Add `"test": "vitest run"` to `app/package.json` scripts if not present.

- [ ] **Step 6: Verify builds**

Run in `app/`: `npm run build` (Vite+tsc) and `npx tsc --noEmit`.
Expected: no errors. (Do NOT run `tauri:dev` in CI — it opens a window; a manual smoke is in Acceptance.)

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "chore: scaffold tauri react app with http and store plugins"
```

---

### Task 3: API client layer + settings

**Files:**
- Create: `app/src/api/{errors,client,types,tickets,comments,history,knowledge,notes,projects,actors}.ts`, `app/src/settings.ts`, `app/src/api/client.test.ts`

**Interfaces:**
- `errors.ts`: `AuthError`, `NotFoundError`, `StaleVersionError`, `ConflictError`, `ApiError` (with `status`, `message`, and `unreachable: boolean`).
- `settings.ts`: `getSettings(): Promise<{ baseUrl: string; apiKey: string }>`, `saveSettings(s): Promise<void>` (via plugin-store).
- `client.ts`: `apiFetch(path: string, init?: { method?; body?; query?: Record<string,string|undefined> }): Promise<any>` — injects bearer + baseUrl, maps errors. `setFetchImpl(fn)` + `setSettingsImpl(fn)` seams for tests.
- Resource modules export typed functions (signatures in Step 4).

- [ ] **Step 1: Write `app/src/api/errors.ts`**

```ts
export class AuthError extends Error {}
export class NotFoundError extends Error {}
export class StaleVersionError extends Error {}
export class ConflictError extends Error {}
export class ApiError extends Error {
  constructor(message: string, public status: number, public unreachable = false) { super(message); }
}
```

- [ ] **Step 2: Write `app/src/api/types.ts`** (mirror server rows)

```ts
export type Ticket = {
  id: string; projectId: string; title: string; body: string;
  status: "open" | "in_progress" | "closed"; priority: "low" | "normal" | "high";
  assigneeId: string | null; version: number; createdAt: string; updatedAt: string;
};
export type Comment = { id: string; ticketId: string; authorId: string; body: string; createdAt: string };
export type Event = {
  id: string; actorId: string; ticketId: string | null; noteId: string | null;
  action: string; changes: Record<string, { from: unknown; to: unknown }> | null; at: string;
};
export type Project = { id: string; key: string; name: string; createdAt: string };
export type Actor = { id: string; name: string; kind: string; role: string };
export type Note = { id: string; actorId: string; body: string; scope: string; refId: string | null; indexed: boolean; createdAt: string };
export type Hit = { content: string; sourceKind: string; sourceRef: string; score: number; citation: string };
```

- [ ] **Step 3: Write `app/src/settings.ts`**

```ts
import { load } from "@tauri-apps/plugin-store";

export type Settings = { baseUrl: string; apiKey: string };
const FILE = "settings.json";

export async function getSettings(): Promise<Settings> {
  const store = await load(FILE, { autoSave: false });
  const baseUrl = (await store.get<string>("baseUrl")) ?? "http://localhost:8787";
  const apiKey = (await store.get<string>("apiKey")) ?? "";
  return { baseUrl, apiKey };
}

export async function saveSettings(s: Settings): Promise<void> {
  const store = await load(FILE, { autoSave: false });
  await store.set("baseUrl", s.baseUrl);
  await store.set("apiKey", s.apiKey);
  await store.save();
}
```

- [ ] **Step 4: Write `app/src/api/client.ts`**

```ts
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { getSettings, type Settings } from "../settings.js";
import { ApiError, AuthError, ConflictError, NotFoundError, StaleVersionError } from "./errors.js";

type FetchImpl = typeof tauriFetch;
let fetchImpl: FetchImpl = tauriFetch;
let settingsImpl: () => Promise<Settings> = getSettings;
export function setFetchImpl(f: FetchImpl) { fetchImpl = f; }
export function setSettingsImpl(f: () => Promise<Settings>) { settingsImpl = f; }

export async function apiFetch(
  path: string,
  init: { method?: string; body?: unknown; query?: Record<string, string | undefined> } = {},
): Promise<any> {
  const { baseUrl, apiKey } = await settingsImpl();
  const qs = init.query
    ? "?" + Object.entries(init.query).filter(([, v]) => v != null)
        .map(([k, v]) => `${k}=${encodeURIComponent(v as string)}`).join("&")
    : "";
  let res: Response;
  try {
    res = await fetchImpl(`${baseUrl}${path}${qs}`, {
      method: init.method ?? "GET",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: init.body != null ? JSON.stringify(init.body) : undefined,
    });
  } catch (e) {
    throw new ApiError(`cannot reach server: ${(e as Error).message}`, 0, true);
  }
  if (res.ok) return res.status === 204 ? null : res.json();
  const msg = await res.json().then((b) => b.error).catch(() => res.statusText);
  if (res.status === 401) throw new AuthError(msg);
  if (res.status === 404) throw new NotFoundError(msg);
  if (res.status === 409) throw new StaleVersionError(msg);
  throw new ApiError(msg, res.status);
}
```
Note: server maps both StaleVersion and ConflictError to 409. The client maps 409 → `StaleVersionError` generically; the create-project flow treats any 409 on `POST /projects` as a duplicate-key conflict (there is no version conflict on that route), so it shows the "key exists" message. That is sufficient — no need to distinguish server-side. `ConflictError` is exported for that call site to optionally rethrow.

- [ ] **Step 5: Write the resource modules**

`app/src/api/tickets.ts`:
```ts
import { apiFetch } from "./client.js";
import type { Ticket } from "./types.js";
export const tickets = {
  list: (f: { projectId?: string; status?: string } = {}) =>
    apiFetch("/tickets", { query: f }) as Promise<Ticket[]>,
  search: (q: string) => apiFetch("/search", { query: { q } }) as Promise<Ticket[]>,
  get: (id: string) => apiFetch(`/tickets/${id}`, {}) as Promise<Ticket>,
  create: (input: { projectId: string; title: string; body?: string; priority?: string; assigneeId?: string }) =>
    apiFetch("/tickets", { method: "POST", body: input }) as Promise<Ticket>,
  update: (id: string, expectedVersion: number, patch: Record<string, unknown>) =>
    apiFetch(`/tickets/${id}`, { method: "PATCH", body: { expectedVersion, ...patch } }) as Promise<Ticket>,
};
```
(`GET /tickets/:id` and `GET /tickets/:id/comments` were added on the server in Task 1 — the client just consumes them here.)

`app/src/api/comments.ts`:
```ts
import { apiFetch } from "./client.js";
import type { Comment } from "./types.js";
export const comments = {
  list: (ticketId: string) => apiFetch(`/tickets/${ticketId}/comments`, {}) as Promise<Comment[]>,
  add: (ticketId: string, body: string) =>
    apiFetch(`/tickets/${ticketId}/comments`, { method: "POST", body: { body } }) as Promise<Comment>,
};
```

`app/src/api/history.ts`:
```ts
import { apiFetch } from "./client.js";
import type { Event } from "./types.js";
export const history = { get: (ticketId: string) => apiFetch(`/tickets/${ticketId}/history`, {}) as Promise<Event[]> };
```
`app/src/api/knowledge.ts`:
```ts
import { apiFetch } from "./client.js";
import type { Hit } from "./types.js";
export const knowledge = {
  search: (q: string, limit?: number) =>
    apiFetch("/knowledge", { query: { q, limit: limit?.toString() } }) as Promise<Hit[]>,
};
```
`app/src/api/notes.ts`:
```ts
import { apiFetch } from "./client.js";
import type { Note } from "./types.js";
export const notes = {
  save: (input: { body: string; scope: string; refId?: string }) =>
    apiFetch("/notes", { method: "POST", body: input }) as Promise<Note>,
};
```
`app/src/api/projects.ts`:
```ts
import { apiFetch } from "./client.js";
import type { Project } from "./types.js";
export const projects = {
  list: () => apiFetch("/projects", {}) as Promise<Project[]>,
  create: (input: { key: string; name: string }) =>
    apiFetch("/projects", { method: "POST", body: input }) as Promise<Project>,
};
```
`app/src/api/actors.ts`:
```ts
import { apiFetch } from "./client.js";
import type { Actor } from "./types.js";
export const actors = { list: () => apiFetch("/actors", {}) as Promise<Actor[]> };
```

- [ ] **Step 6: Write `app/src/api/client.test.ts`** (mock fetch + settings via the seams)

```ts
import { beforeEach, expect, test, vi } from "vitest";
import { apiFetch, setFetchImpl, setSettingsImpl } from "./client.js";
import { AuthError, StaleVersionError, NotFoundError, ApiError } from "./errors.js";

beforeEach(() => {
  setSettingsImpl(async () => ({ baseUrl: "http://x", apiKey: "KEY" }));
});

function mockRes(status: number, body: any) {
  return { ok: status >= 200 && status < 300, status, statusText: "s", json: async () => body } as Response;
}

test("injects bearer + base url", async () => {
  const spy = vi.fn(async () => mockRes(200, { ok: 1 }));
  setFetchImpl(spy as any);
  await apiFetch("/tickets", {});
  expect(spy).toHaveBeenCalledWith("http://x/tickets", expect.objectContaining({
    headers: expect.objectContaining({ Authorization: "Bearer KEY" }),
  }));
});

test("maps status codes to typed errors", async () => {
  setFetchImpl((async () => mockRes(401, { error: "no" })) as any);
  await expect(apiFetch("/x", {})).rejects.toBeInstanceOf(AuthError);
  setFetchImpl((async () => mockRes(404, { error: "no" })) as any);
  await expect(apiFetch("/x", {})).rejects.toBeInstanceOf(NotFoundError);
  setFetchImpl((async () => mockRes(409, { error: "no" })) as any);
  await expect(apiFetch("/x", {})).rejects.toBeInstanceOf(StaleVersionError);
  setFetchImpl((async () => mockRes(500, { error: "no" })) as any);
  await expect(apiFetch("/x", {})).rejects.toBeInstanceOf(ApiError);
});

test("connection failure -> ApiError unreachable", async () => {
  setFetchImpl((async () => { throw new Error("refused"); }) as any);
  await expect(apiFetch("/x", {})).rejects.toMatchObject({ unreachable: true });
});
```

- [ ] **Step 7: Run app tests + typechecks**

In `app/`: `npm test` + `npx tsc --noEmit`. (Server is unchanged by this task; its suite stays green from Task 1.)
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat: typed api client and settings store for the app"
```

---

### Task 4: App shell — router, QueryClient, first-run settings gate

**Files:**
- Create: `app/src/lib/queryClient.ts`, `app/src/routes/{root,settings}.tsx`, `app/src/components/Banner.tsx`, `app/src/main.tsx`
- Modify: `app/index.html` (mount point if needed)
- Create: `app/src/routes/settings.test.tsx`

**Interfaces:**
- `queryClient.ts` exports a configured `QueryClient` (`refetchOnWindowFocus: true`).
- Root layout: left nav (Tickets, Knowledge, Settings) + `<Outlet/>`. If `getSettings()` returns an empty `apiKey`, redirect to `/settings`.
- Settings screen: fields baseUrl + apiKey, "Test connection" (`projects.list()` → ok/err), Save (`saveSettings`).

- [ ] **Step 1: Write `app/src/lib/queryClient.ts`**

```ts
import { QueryClient } from "@tanstack/react-query";
export const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: true, retry: 1 } },
});
```

- [ ] **Step 2: Write `app/src/components/Banner.tsx`**

```tsx
export function Banner({ kind, message }: { kind: "error" | "warn" | "info"; message: string }) {
  const bg = kind === "error" ? "#fdd" : kind === "warn" ? "#ffd" : "#def";
  return <div role="alert" style={{ background: bg, padding: "8px 12px", borderRadius: 6 }}>{message}</div>;
}
```

- [ ] **Step 3: Write `app/src/routes/settings.tsx`**

```tsx
import { useState } from "react";
import { getSettings, saveSettings } from "../settings.js";
import { projects } from "../api/projects.js";
import { Banner } from "../components/Banner.js";

export function SettingsScreen({ onSaved }: { onSaved?: () => void }) {
  const [baseUrl, setBaseUrl] = useState("http://localhost:8787");
  const [apiKey, setApiKey] = useState("");
  const [status, setStatus] = useState<string | null>(null);

  async function test() {
    await saveSettings({ baseUrl, apiKey });
    try { await projects.list(); setStatus("ok"); }
    catch { setStatus("bad"); }
  }
  async function save() { await saveSettings({ baseUrl, apiKey }); onSaved?.(); }

  return (
    <div>
      <h2>Settings</h2>
      <label>Server URL <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} /></label>
      <label>API Key <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} /></label>
      <button onClick={test}>Test connection</button>
      <button onClick={save}>Save</button>
      {status === "ok" && <Banner kind="info" message="Connected" />}
      {status === "bad" && <Banner kind="error" message="Key rejected or server unreachable" />}
    </div>
  );
}
```
On mount, prefill from `getSettings()` (use a `useEffect` to set baseUrl/apiKey). Keep it minimal.

- [ ] **Step 4: Write `app/src/routes/root.tsx`** (left nav + outlet; the router wiring lives in main.tsx)

```tsx
import { Link, Outlet } from "@tanstack/react-router";
export function Root() {
  return (
    <div style={{ display: "flex" }}>
      <nav style={{ width: 160, padding: 12 }}>
        <Link to="/">Tickets</Link><br />
        <Link to="/knowledge">Knowledge</Link><br />
        <Link to="/settings">Settings</Link>
      </nav>
      <main style={{ flex: 1, padding: 16 }}><Outlet /></main>
    </div>
  );
}
```

- [ ] **Step 5: Write `app/src/main.tsx`** — QueryClientProvider + router with routes (list `/`, detail `/tickets/$id`, create `/create`, knowledge `/knowledge`, settings `/settings`), and a first-run gate that redirects to `/settings` when `apiKey` is empty.

Use TanStack Router's `createRouter`/`createRootRoute`/`createRoute` with the components from Tasks 4-8. For the gate, in the root route's loader or a top-level effect: `const { apiKey } = await getSettings(); if (!apiKey) navigate("/settings")`. Keep the wiring standard per TanStack Router v1 docs. Wrap the app in `<QueryClientProvider client={queryClient}>`.

- [ ] **Step 6: Write `app/src/routes/settings.test.tsx`**

```tsx
import { expect, test, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SettingsScreen } from "./settings.js";

vi.mock("../api/projects.js", () => ({ projects: { list: vi.fn(async () => []) } }));
vi.mock("../settings.js", () => ({ getSettings: vi.fn(async () => ({ baseUrl: "", apiKey: "" })), saveSettings: vi.fn(async () => {}) }));

test("Test connection shows Connected on success", async () => {
  render(<SettingsScreen />);
  fireEvent.click(screen.getByText("Test connection"));
  await waitFor(() => expect(screen.getByText("Connected")).toBeInTheDocument());
});
```

- [ ] **Step 7: Run + commit**

Run in `app/`: `npm test` + `npx tsc --noEmit`.
```bash
git add -A && git commit -m "feat: app shell with router, query client, and settings gate"
```

---

### Task 5: Ticket list screen

**Files:**
- Create: `app/src/components/StatusBadge.tsx`, `app/src/routes/list.tsx`, `app/src/routes/list.test.tsx`

**Interfaces:**
- List screen: project filter (from `projects.list`), status filter, keyword box (→ `tickets.search`), rows link to `/tickets/$id`, assignee resolved via `actors.list` map.

- [ ] **Step 1: Write `app/src/components/StatusBadge.tsx`**

```tsx
export function StatusBadge({ status }: { status: string }) {
  const c = status === "open" ? "#39c" : status === "in_progress" ? "#e90" : "#6a6";
  return <span style={{ background: c, color: "#fff", padding: "2px 6px", borderRadius: 4 }}>{status}</span>;
}
```

- [ ] **Step 2: Write `app/src/routes/list.tsx`**

```tsx
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { tickets } from "../api/tickets.js";
import { projects } from "../api/projects.js";
import { actors } from "../api/actors.js";
import { StatusBadge } from "../components/StatusBadge.js";

export function ListScreen() {
  const [projectId, setProjectId] = useState<string>("");
  const [status, setStatus] = useState<string>("");
  const [q, setQ] = useState("");
  const projQ = useQuery({ queryKey: ["projects"], queryFn: projects.list });
  const actQ = useQuery({ queryKey: ["actors"], queryFn: actors.list });
  const listQ = useQuery({
    queryKey: ["tickets", { projectId, status, q }],
    queryFn: () => q ? tickets.search(q) : tickets.list({ projectId: projectId || undefined, status: status || undefined }),
  });
  const actorName = (id: string | null) => actQ.data?.find((a) => a.id === id)?.name ?? "-";

  return (
    <div>
      <h2>Tickets</h2>
      <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
        <option value="">All projects</option>
        {projQ.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <select value={status} onChange={(e) => setStatus(e.target.value)}>
        <option value="">Any status</option><option>open</option><option>in_progress</option><option>closed</option>
      </select>
      <input placeholder="search" value={q} onChange={(e) => setQ(e.target.value)} />
      <Link to="/create">New ticket</Link>
      {listQ.isError && <div role="alert">Failed to load</div>}
      <ul>
        {listQ.data?.map((t) => (
          <li key={t.id}>
            <Link to="/tickets/$id" params={{ id: t.id }}>{t.title}</Link>{" "}
            <StatusBadge status={t.status} /> {t.priority} · {actorName(t.assigneeId)}
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 3: Write `app/src/routes/list.test.tsx`**

```tsx
import { expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";

vi.mock("../api/tickets.js", () => ({ tickets: {
  list: vi.fn(async () => [{ id: "t1", title: "First", status: "open", priority: "normal", assigneeId: null }]),
  search: vi.fn(async () => []),
} }));
vi.mock("../api/projects.js", () => ({ projects: { list: vi.fn(async () => []) } }));
vi.mock("../api/actors.js", () => ({ actors: { list: vi.fn(async () => []) } }));
vi.mock("@tanstack/react-router", () => ({ Link: (p: any) => <a>{p.children}</a> }));

import { ListScreen } from "./list.js";

test("renders tickets from the api", async () => {
  render(<QueryClientProvider client={new QueryClient()}><ListScreen /></QueryClientProvider>);
  await waitFor(() => expect(screen.getByText("First")).toBeInTheDocument());
});
```

- [ ] **Step 4: Run + commit**

Run in `app/`: `npm test` + `npx tsc --noEmit`.
```bash
git add -A && git commit -m "feat: ticket list screen with filters and search"
```

---

### Task 6: Ticket detail — view, edit with 409 recovery, comments, audit timeline

**Files:**
- Create: `app/src/components/{AuditTimeline,CommentList}.tsx`, `app/src/routes/detail.tsx`, `app/src/routes/detail.test.tsx`

**Interfaces:**
- Detail screen loads `tickets.get(id)`, `history.get(id)`, `comments.list(id)`, `actors.list`. Edit status/priority/assignee → `tickets.update(id, version, patch)`; on `StaleVersionError` show banner, refetch, keep form input. Add comment (append-optimistic). Timeline from history.

- [ ] **Step 1: Write `app/src/components/AuditTimeline.tsx`**

```tsx
import type { Event } from "../api/types.js";
export function AuditTimeline({ events, actorName }: { events: Event[]; actorName: (id: string) => string }) {
  return (
    <ul>
      {events.map((e) => (
        <li key={e.id}>
          <b>{actorName(e.actorId)}</b> {e.action} <i>{new Date(e.at).toLocaleString()}</i>
          {e.changes && <span> — {Object.entries(e.changes).map(([k, v]) => `${k}: ${String(v.from)}→${String(v.to)}`).join(", ")}</span>}
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 2: Write `app/src/components/CommentList.tsx`**

```tsx
import type { Comment } from "../api/types.js";
export function CommentList({ items, actorName }: { items: Comment[]; actorName: (id: string) => string }) {
  return <ul>{items.map((c) => <li key={c.id}><b>{actorName(c.authorId)}</b>: {c.body}</li>)}</ul>;
}
```

- [ ] **Step 3: Write `app/src/routes/detail.tsx`**

```tsx
import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { tickets } from "../api/tickets.js";
import { comments } from "../api/comments.js";
import { history } from "../api/history.js";
import { actors } from "../api/actors.js";
import { StaleVersionError } from "../api/errors.js";
import { AuditTimeline } from "../components/AuditTimeline.js";
import { CommentList } from "../components/CommentList.js";
import { Banner } from "../components/Banner.js";

export function DetailScreen({ id }: { id: string }) {
  const qc = useQueryClient();
  const tq = useQuery({ queryKey: ["ticket", id], queryFn: () => tickets.get(id) });
  const hq = useQuery({ queryKey: ["history", id], queryFn: () => history.get(id) });
  const cq = useQuery({ queryKey: ["comments", id], queryFn: () => comments.list(id) });
  const aq = useQuery({ queryKey: ["actors"], queryFn: actors.list });
  const actorName = (aid: string) => aq.data?.find((a) => a.id === aid)?.name ?? aid;

  const [status, setStatus] = useState<string | undefined>();
  const [conflict, setConflict] = useState(false);
  useEffect(() => { if (tq.data && status === undefined) setStatus(tq.data.status); }, [tq.data]);

  const save = useMutation({
    mutationFn: () => tickets.update(id, tq.data!.version, { status }),
    onSuccess: () => { setConflict(false); qc.invalidateQueries({ queryKey: ["ticket", id] }); qc.invalidateQueries({ queryKey: ["history", id] }); },
    onError: (e) => { if (e instanceof StaleVersionError) { setConflict(true); qc.invalidateQueries({ queryKey: ["ticket", id] }); } },
  });

  const [comment, setComment] = useState("");
  const addComment = useMutation({
    mutationFn: () => comments.add(id, comment),
    onSuccess: () => { setComment(""); qc.invalidateQueries({ queryKey: ["comments", id] }); qc.invalidateQueries({ queryKey: ["history", id] }); },
  });

  if (tq.isLoading) return <div>Loading…</div>;
  if (tq.isError) return <div role="alert">Failed to load ticket</div>;
  const t = tq.data!;
  return (
    <div>
      <h2>{t.title}</h2>
      <p>{t.body}</p>
      {conflict && <Banner kind="warn" message="This ticket changed elsewhere — reloaded; please redo your edit and save again." />}
      <label>Status
        <select value={status ?? t.status} onChange={(e) => setStatus(e.target.value)}>
          <option>open</option><option>in_progress</option><option>closed</option>
        </select>
      </label>
      <button onClick={() => save.mutate()}>Save</button>

      <h3>Comments</h3>
      <CommentList items={cq.data ?? []} actorName={actorName} />
      <input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="add comment" />
      <button onClick={() => addComment.mutate()}>Add</button>

      <h3>History</h3>
      <AuditTimeline events={hq.data ?? []} actorName={actorName} />
    </div>
  );
}
```
Note the 409 flow: on `StaleVersionError` the ticket query is invalidated (pulls fresh version) but `status` state is NOT reset — the user's chosen value stays in the form so they re-save against the new version. The banner tells them to redo/confirm.

- [ ] **Step 4: Write `app/src/routes/detail.test.tsx`** — the load-bearing 409 test

```tsx
import { expect, test, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";
import { StaleVersionError } from "../api/errors.js";

const update = vi.fn();
vi.mock("../api/tickets.js", () => ({ tickets: {
  get: vi.fn(async () => ({ id: "t1", title: "T", body: "b", status: "open", priority: "normal", assigneeId: null, version: 1 })),
  update: (...a: any[]) => update(...a),
} }));
vi.mock("../api/comments.js", () => ({ comments: { list: vi.fn(async () => []), add: vi.fn() } }));
vi.mock("../api/history.js", () => ({ history: { get: vi.fn(async () => []) } }));
vi.mock("../api/actors.js", () => ({ actors: { list: vi.fn(async () => []) } }));

import { DetailScreen } from "./detail.js";
const wrap = (ui: any) => <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>;

test("Save sends expectedVersion; a 409 shows the banner and keeps the edit", async () => {
  update.mockRejectedValueOnce(new StaleVersionError("stale"));
  render(wrap(<DetailScreen id="t1" />));
  await waitFor(() => screen.getByText("T"));
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "closed" } });
  fireEvent.click(screen.getByText("Save"));
  expect(update).toHaveBeenCalledWith("t1", 1, { status: "closed" });
  await waitFor(() => expect(screen.getByText(/changed elsewhere/)).toBeInTheDocument());
  // edit preserved:
  expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("closed");
});
```

- [ ] **Step 5: Run + commit**

Run in `app/`: `npm test` + `npx tsc --noEmit`.
```bash
git add -A && git commit -m "feat: ticket detail with 409 recovery, comments, and audit timeline"
```

---

### Task 7: Create-ticket screen with project picker + inline new-project

**Files:**
- Create: `app/src/routes/create.tsx`, `app/src/routes/create.test.tsx`

**Interfaces:**
- Create screen: project select (`projects.list`) + inline "New project" (`projects.create`, 409 → "key exists"), title, body, priority, optional assignee → `tickets.create` → navigate to `/tickets/$id`.

- [ ] **Step 1: Write `app/src/routes/create.tsx`**

```tsx
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { projects } from "../api/projects.js";
import { actors } from "../api/actors.js";
import { tickets } from "../api/tickets.js";
import { StaleVersionError } from "../api/errors.js";
import { Banner } from "../components/Banner.js";

export function CreateScreen() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const pq = useQuery({ queryKey: ["projects"], queryFn: projects.list });
  const aq = useQuery({ queryKey: ["actors"], queryFn: actors.list });
  const [projectId, setProjectId] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [priority, setPriority] = useState("normal");
  const [assigneeId, setAssigneeId] = useState("");
  const [newKey, setNewKey] = useState("");
  const [newName, setNewName] = useState("");
  const [projErr, setProjErr] = useState<string | null>(null);

  const createProj = useMutation({
    mutationFn: () => projects.create({ key: newKey, name: newName }),
    onSuccess: (p) => { setProjErr(null); setProjectId(p.id); setNewKey(""); setNewName(""); qc.invalidateQueries({ queryKey: ["projects"] }); },
    onError: (e) => setProjErr(e instanceof StaleVersionError ? "project key already exists" : "failed to create project"),
  });
  const createTicket = useMutation({
    mutationFn: () => tickets.create({ projectId, title, body, priority, assigneeId: assigneeId || undefined }),
    onSuccess: (t) => { qc.invalidateQueries({ queryKey: ["tickets"] }); nav({ to: "/tickets/$id", params: { id: t.id } }); },
  });

  return (
    <div>
      <h2>New ticket</h2>
      <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
        <option value="">Select project</option>
        {pq.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <fieldset>
        <legend>New project</legend>
        <input placeholder="key" value={newKey} onChange={(e) => setNewKey(e.target.value)} />
        <input placeholder="name" value={newName} onChange={(e) => setNewName(e.target.value)} />
        <button onClick={() => createProj.mutate()}>Create project</button>
        {projErr && <Banner kind="error" message={projErr} />}
      </fieldset>
      <input placeholder="title" value={title} onChange={(e) => setTitle(e.target.value)} />
      <textarea placeholder="body" value={body} onChange={(e) => setBody(e.target.value)} />
      <select value={priority} onChange={(e) => setPriority(e.target.value)}>
        <option>low</option><option>normal</option><option>high</option>
      </select>
      <select value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
        <option value="">Unassigned</option>
        {aq.data?.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
      </select>
      <button disabled={!projectId || !title} onClick={() => createTicket.mutate()}>Create</button>
    </div>
  );
}
```

- [ ] **Step 2: Write `app/src/routes/create.test.tsx`**

```tsx
import { expect, test, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";

const createTicket = vi.fn(async () => ({ id: "new1" }));
const nav = vi.fn();
vi.mock("../api/projects.js", () => ({ projects: { list: vi.fn(async () => [{ id: "p1", key: "k", name: "Proj" }]), create: vi.fn() } }));
vi.mock("../api/actors.js", () => ({ actors: { list: vi.fn(async () => []) } }));
vi.mock("../api/tickets.js", () => ({ tickets: { create: (...a: any[]) => createTicket(...a) } }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => nav }));

import { CreateScreen } from "./create.js";
const wrap = (ui: any) => <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>;

test("creating a ticket posts and navigates to detail", async () => {
  render(wrap(<CreateScreen />));
  await waitFor(() => screen.getByText("Proj"));
  fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: "p1" } });
  fireEvent.change(screen.getByPlaceholderText("title"), { target: { value: "Hello" } });
  fireEvent.click(screen.getByText("Create"));
  await waitFor(() => expect(createTicket).toHaveBeenCalled());
  await waitFor(() => expect(nav).toHaveBeenCalledWith({ to: "/tickets/$id", params: { id: "new1" } }));
});
```

- [ ] **Step 3: Run + commit**

Run in `app/`: `npm test` + `npx tsc --noEmit`.
```bash
git add -A && git commit -m "feat: create-ticket screen with project picker and inline new project"
```

---

### Task 8: Knowledge panel (search + save-note)

**Files:**
- Create: `app/src/routes/knowledge.tsx`, `app/src/routes/knowledge.test.tsx`

**Interfaces:**
- Knowledge screen: search box → `knowledge.search(q)` → result cards (content + citation). Save-note form: body + scope; project/ticket scope reveals a ref text field → `notes.save`.

- [ ] **Step 1: Write `app/src/routes/knowledge.tsx`**

```tsx
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { knowledge } from "../api/knowledge.js";
import { notes } from "../api/notes.js";
import { Banner } from "../components/Banner.js";

export function KnowledgeScreen() {
  const [q, setQ] = useState("");
  const [submitted, setSubmitted] = useState("");
  const sq = useQuery({ queryKey: ["knowledge", submitted], queryFn: () => knowledge.search(submitted), enabled: !!submitted });

  const [body, setBody] = useState("");
  const [scope, setScope] = useState("global");
  const [refId, setRefId] = useState("");
  const [saved, setSaved] = useState(false);
  const save = useMutation({
    mutationFn: () => notes.save({ body, scope, refId: scope === "global" ? undefined : refId }),
    onSuccess: () => { setSaved(true); setBody(""); },
  });

  return (
    <div>
      <h2>Knowledge</h2>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="search" />
      <button onClick={() => setSubmitted(q)}>Search</button>
      <ul>
        {sq.data?.map((h, i) => <li key={i}>{h.content} <i>({h.citation})</i></li>)}
      </ul>
      <h3>Save note</h3>
      <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="note body" />
      <select value={scope} onChange={(e) => setScope(e.target.value)}>
        <option>global</option><option>project</option><option>ticket</option>
      </select>
      {scope !== "global" && <input value={refId} onChange={(e) => setRefId(e.target.value)} placeholder={`${scope} id`} />}
      <button disabled={!body} onClick={() => save.mutate()}>Save note</button>
      {saved && <Banner kind="info" message="Saved" />}
    </div>
  );
}
```

- [ ] **Step 2: Write `app/src/routes/knowledge.test.tsx`**

```tsx
import { expect, test, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";

vi.mock("../api/knowledge.js", () => ({ knowledge: { search: vi.fn(async () => [{ content: "backup nightly", sourceKind: "vault", sourceRef: "sop.md", score: 1, citation: "sop.md" }]) } }));
vi.mock("../api/notes.js", () => ({ notes: { save: vi.fn(async () => ({ id: "n1" })) } }));

import { KnowledgeScreen } from "./knowledge.js";
const wrap = (ui: any) => <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>;

test("search shows results with citation", async () => {
  render(wrap(<KnowledgeScreen />));
  fireEvent.change(screen.getByPlaceholderText("search"), { target: { value: "backup" } });
  fireEvent.click(screen.getByText("Search"));
  await waitFor(() => expect(screen.getByText(/backup nightly/)).toBeInTheDocument());
  expect(screen.getByText(/sop.md/)).toBeInTheDocument();
});
```

- [ ] **Step 3: Run full app suite + typecheck + commit**

Run in `app/`: `npm test` + `npx tsc --noEmit`. In repo root: `npm test` (server unaffected, still green).
```bash
git add -A && git commit -m "feat: knowledge panel with search and save-note"
```

---

## Phase 3 acceptance

- Server: full server suite + typecheck green; `GET /actors` returns no `apiKeyHash`; `GET/POST /projects` and `GET /tickets/:id` + `GET /tickets/:id/comments` work under auth.
- App: client-layer + component tests green; `npx tsc --noEmit` clean in `app/`.
- Manual smoke (`npm run tauri:dev` in `app/`, server running): Settings → connect → create project → create ticket → change status → add comment → see it all in the audit timeline with actor names; knowledge search returns results with citations; a saved note becomes searchable; a concurrent edit (second client / curl PATCH) triggers the 409 banner and preserves the edit.

## Self-review notes (done)

- Spec coverage: pure-client (Tasks 2-8, no DB/logic in app), plugin-http transport (Task 3 client), settings via plugin-store (Task 3), refetch-on-focus + 409 recovery (Tasks 4,6), server additions GET/POST /projects + GET /actors + the required single-ticket and comments-list reads (Tasks 1,3), five screens (Tasks 4-8), error handling (Banner + typed errors throughout), testing at client + component + server layers. Covered.
- Type consistency: `tickets.update(id, expectedVersion, patch)`, `apiFetch(path, {method,body,query})`, `getSettings()/saveSettings()`, typed errors (AuthError/NotFoundError/StaleVersionError/ConflictError/ApiError) used identically across client, screens, and tests.
- Flagged for the implementer: Phase 1 lacked `GET /tickets/:id` and `GET /tickets/:id/comments` — Task 1 (Steps 4a-4c + test) adds both on the server, so all server changes live in Task 1 and Task 3 is pure-client. The TanStack Router v1 wiring in Task 4 Step 5 is described, not fully transcribed (its API is version-sensitive); the implementer follows current Router v1 docs and the app's own route set.
- Known latitude: Task 2 scaffolding via `create-tauri-app` may prompt; the implementer adapts flags and reports the exact command.
```