import { expect, test, vi } from "vitest";
import { makeGithubConnector } from "../src/sync/connectors/github.js";
import { runSync } from "../src/sync/import.js";
import { db } from "../src/db/client.js";
import { projects, tickets as ticketsTable } from "../src/db/schema.js";
import { eq } from "drizzle-orm";
import { boundProjects, setProjectSetting } from "../src/services/projects.js";

vi.mock("../src/services/settings.js", () => {
  let settings: Record<string, string> = {};
  return {
    getSetting: async (key: string) => settings[key] ?? null,
    setSetting: async (key: string, val: string) => { settings[key] = val; },
    __setSettingsForTest: (newSettings: Record<string, string>) => { settings = newSettings; }
  };
});

import * as settingsModule from "../src/services/settings.js";
const { __setSettingsForTest } = settingsModule as any;

function makeFetch(responses: any[]) {
  let index = 0;
  return vi.fn(async (url, opts) => {
    const res = responses[index++];
    if (!res) throw new Error("Unexpected fetch call");
    return {
      ok: res.ok ?? true,
      status: res.status ?? 200,
      statusText: res.statusText ?? "OK",
      headers: new Headers(res.headers ?? {}),
      json: async () => res.data,
    };
  });
}

test("(a) no credentials -> empty list + no fetch calls", async () => {
  __setSettingsForTest({});
  const fetchImpl = vi.fn();
  const conn = makeGithubConnector(fetchImpl as any);
  const tickets = await conn.listExternalTickets();
  expect(tickets).toEqual([]);
  expect(fetchImpl).not.toHaveBeenCalled();
});

test("(b) issues + comments map correctly, PR excluded, state mapped", async () => {
  __setSettingsForTest({ "github.token": "ghp_abc", "github.repo": "acme/widgets" });

  const fetchImpl = makeFetch([
    {
      data: [
        { number: 1, title: "Bug", body: "desc", state: "open", updated_at: "2026-01-01T00:00:00Z" },
        { number: 2, title: "A PR", body: "", state: "open", updated_at: "2026-01-02T00:00:00Z", pull_request: { url: "x" } },
      ],
    },
    { data: [{ id: 55, user: { login: "alice" }, body: "looks off", created_at: "2026-01-01T01:00:00Z" }] },
  ]);

  const conn = makeGithubConnector(fetchImpl as any);
  const out = await conn.listExternalTickets();

  expect(conn.source).toBe("github");
  expect(out).toHaveLength(1); // PR filtered
  expect(out[0].externalId).toBe("acme/widgets#1");
  expect(out[0].status).toBe("open");
  expect(out[0].comments).toHaveLength(1);
  expect(out[0].comments[0].externalId).toBe("acme/widgets#comment-55");
  expect(out[0].comments[0].author).toBe("alice");
});

test("(b2) full-URL binding heals to owner/repo (defensive)", async () => {
  __setSettingsForTest({ "github.token": "t" });
  const fetchImpl = makeFetch([
    { data: [{ number: 7, title: "T", state: "open", updated_at: "2026-01-01T00:00:00Z" }] },
    { data: [] },
  ]);
  const conn = makeGithubConnector(fetchImpl as any, "https://github.com/acme/widgets.git");
  const out = await conn.listExternalTickets();
  expect(new URL(fetchImpl.mock.calls[0][0]).pathname).toBe("/repos/acme/widgets/issues");
  expect(out[0].externalId).toBe("acme/widgets#7");
});

test("(c) pagination follows Link rel=next and caps at 10", async () => {
  __setSettingsForTest({ "github.token": "t", "github.repo": "o/r" });

  const responses = [];
  for (let i = 0; i < 11; i++) {
    responses.push({
      headers: { Link: `<https://api.github.com/repos/o/r/issues?page=${i + 2}>; rel="next"` },
      data: [{ number: i, title: `Issue ${i}`, state: "open", updated_at: "2026-01-01T00:00:00Z" }],
    });
  }
  for (let i = 0; i < 10; i++) responses.push({ data: [] }); // per-issue comment fetches

  const fetchImpl = makeFetch(responses);
  const conn = makeGithubConnector(fetchImpl as any);
  const tickets = await conn.listExternalTickets();

  expect(tickets).toHaveLength(10);
});

test("(d) incremental cursor: since passed through", async () => {
  __setSettingsForTest({ "github.token": "t", "github.repo": "o/r" });
  const fetchImpl = makeFetch([{ data: [] }]);
  const conn = makeGithubConnector(fetchImpl as any);
  const since = new Date("2026-06-01T00:00:00.000Z");
  await conn.listExternalTickets(since);

  expect(fetchImpl).toHaveBeenCalledTimes(1);
  const url = new URL(fetchImpl.mock.calls[0][0]);
  expect(url.searchParams.get("since")).toBe("2026-06-01T00:00:00.000Z");
});

test("(e) non-2xx throws with status", async () => {
  __setSettingsForTest({ "github.token": "t", "github.repo": "o/r" });
  const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 503, statusText: "Service Unavailable", headers: new Headers() });
  const conn = makeGithubConnector(fetchImpl as any);
  await expect(conn.listExternalTickets()).rejects.toThrow(/503/);
});

async function newProject() {
  const [p] = await db.insert(projects).values({ key: `p-${Date.now()}-${Math.random()}`, name: "P" }).returning();
  return p.id;
}

test("(f) engine e2e, idempotent second run", async () => {
  const repo = `acme/e2e-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  __setSettingsForTest({ "github.token": "t", "github.repo": repo });
  const projectId = await newProject();

  let fetchImpl = makeFetch([
    { data: [{ number: 1, title: "E2E Issue", state: "open", updated_at: "2026-01-01T00:00:00Z" }] },
    { data: [{ id: 100, user: { login: "u" }, body: "E2E Comment", created_at: "2026-01-01T01:00:00Z" }] },
  ]);
  let conn = makeGithubConnector(fetchImpl as any);
  let result = await runSync(conn, { projectId });

  expect(result.created).toBe(1);
  expect(result.commentsAdded).toBe(1);

  fetchImpl = makeFetch([
    { data: [{ number: 1, title: "E2E Issue", state: "open", updated_at: "2026-01-01T00:00:00Z" }] },
    { data: [{ id: 100, user: { login: "u" }, body: "E2E Comment", created_at: "2026-01-01T01:00:00Z" }] },
  ]);
  conn = makeGithubConnector(fetchImpl as any);
  result = await runSync(conn, { projectId });

  expect(result.created).toBe(0);
  expect(result.skipped).toBe(1);
  expect(result.commentsAdded).toBe(0);
});

test("(g) account-level PAT shared, per-project repo binding fan-out", async () => {
  const p1 = await newProject();
  const p2 = await newProject();
  const r1 = `org/repo1-${Date.now()}`;
  const r2 = `org/repo2-${Date.now()}`;
  __setSettingsForTest({ "github.token": "shared-pat" }); // one account-level PAT
  await setProjectSetting(p1, "github.repo", r1);
  await setProjectSetting(p2, "github.repo", r2);

  const fetchImpl = vi.fn(async (url: string) => {
    if (url.includes(r1)) return { ok: true, json: async () => url.includes("/comments") ? [] : [{ number: 10, title: "T1", state: "open", updated_at: "2026-01-01T00:00:00Z" }], headers: new Headers() };
    if (url.includes(r2)) return { ok: true, json: async () => url.includes("/comments") ? [] : [{ number: 20, title: "T2", state: "open", updated_at: "2026-01-01T00:00:00Z" }], headers: new Headers() };
    return { ok: true, json: async () => [], headers: new Headers() };
  });

  const bindings = await boundProjects("github.repo");
  for (const { projectId, binding } of bindings) {
    if (projectId === p1 || projectId === p2) {
      await runSync(makeGithubConnector(fetchImpl as any, binding), { projectId });
    }
  }

  const t1 = await db.select().from(ticketsTable).where(eq(ticketsTable.projectId, p1));
  const t2 = await db.select().from(ticketsTable).where(eq(ticketsTable.projectId, p2));
  expect(t1).toHaveLength(1);
  expect(t1[0].title).toBe("T1");
  expect(t2).toHaveLength(1);
  expect(t2[0].title).toBe("T2");
});
