import { expect, test, vi } from "vitest";
import { makeGitLabConnector } from "../src/sync/connectors/gitlab.js";
import { runSync } from "../src/sync/import.js";
import { db } from "../src/db/client.js";
import { projects } from "../src/db/schema.js";

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
  const conn = makeGitLabConnector(fetchImpl as any);
  const tickets = await conn.listExternalTickets();
  expect(tickets).toEqual([]);
  expect(fetchImpl).not.toHaveBeenCalled();
});

test("(b) issues + notes map correctly incl. state mapping and system-note filtering", async () => {
  __setSettingsForTest({
    "gitlab.token": "abc",
    "gitlab.project": "my/project"
  });
  
  const fetchImpl = makeFetch([
    {
      data: [
        { iid: 1, title: "Issue 1", description: "Body 1", state: "opened", updated_at: "2026-01-01T00:00:00Z" },
        { iid: 2, title: "Issue 2", description: null, state: "closed", updated_at: "2026-01-02T00:00:00Z" }
      ]
    },
    {
      data: [
        { id: 10, system: false, body: "Comment 1", author: { username: "userA" }, created_at: "2026-01-01T01:00:00Z" },
        { id: 11, system: true, body: "System comment", created_at: "2026-01-01T02:00:00Z" }
      ]
    },
    {
      data: []
    }
  ]);

  const conn = makeGitLabConnector(fetchImpl as any);
  const tickets = await conn.listExternalTickets();
  
  expect(tickets).toHaveLength(2);
  
  expect(tickets[0].externalId).toBe("gitlab:my/project:1");
  expect(tickets[0].title).toBe("Issue 1");
  expect(tickets[0].body).toBe("Body 1");
  expect(tickets[0].status).toBe("open");
  expect(tickets[0].updatedAt).toBe("2026-01-01T00:00:00Z");
  expect(tickets[0].comments).toHaveLength(1);
  expect(tickets[0].comments[0].externalId).toBe("gitlab:my/project:1#note-10");
  expect(tickets[0].comments[0].author).toBe("userA");
  expect(tickets[0].comments[0].body).toBe("Comment 1");
  
  expect(tickets[1].externalId).toBe("gitlab:my/project:2");
  expect(tickets[1].status).toBe("closed");
  expect(tickets[1].body).toBe("");
  expect(tickets[1].comments).toHaveLength(0);
});

test("(c) pagination follows X-Next-Page and caps at 10", async () => {
  __setSettingsForTest({
    "gitlab.token": "abc",
    "gitlab.project": "123"
  });

  const responses = [];
  for (let i = 0; i < 11; i++) {
    responses.push({
      headers: { "X-Next-Page": String(i + 2) },
      data: [{ iid: i, title: `Issue ${i}`, state: "opened" }]
    });
  }
  
  for (let i = 0; i < 10; i++) {
    responses.push({ data: [] });
  }

  const fetchImpl = makeFetch(responses);
  const conn = makeGitLabConnector(fetchImpl as any);
  const tickets = await conn.listExternalTickets();
  
  expect(tickets).toHaveLength(10);
});

test("(d) incremental cursor: updated_after passed through", async () => {
  __setSettingsForTest({ "gitlab.token": "t", "gitlab.project": "p" });
  const fetchImpl = makeFetch([{ data: [] }]);
  const conn = makeGitLabConnector(fetchImpl as any);
  const since = new Date("2026-06-01T00:00:00.000Z");
  await conn.listExternalTickets(since);
  
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  const url = new URL(fetchImpl.mock.calls[0][0]);
  expect(url.searchParams.get("updated_after")).toBe("2026-06-01T00:00:00.000Z");
});

test("(e) non-2xx throws with status", async () => {
  __setSettingsForTest({ "gitlab.token": "t", "gitlab.project": "p" });
  const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 503, statusText: "Service Unavailable" });
  const conn = makeGitLabConnector(fetchImpl as any);
  await expect(conn.listExternalTickets()).rejects.toThrow(/503/);
});

async function newProject() {
  const [p] = await db.insert(projects).values({ key: `p-${Date.now()}-${Math.random()}`, name: "P" }).returning();
  return p.id;
}

test("(f) engine e2e, idempotent second run", async () => {
  __setSettingsForTest({ "gitlab.token": "t", "gitlab.project": "p" });
  const projectId = await newProject();
  
  const responses = [
    { data: [{ iid: 1, title: "E2E Issue", state: "opened", updated_at: "2026-01-01T00:00:00Z" }] },
    { data: [{ id: 100, system: false, body: "E2E Note", author: { username: "u" }, created_at: "2026-01-01T01:00:00Z" }] }
  ];
  
  let fetchImpl = makeFetch(responses);
  let conn = makeGitLabConnector(fetchImpl as any);
  let result = await runSync(conn, { projectId });
  
  expect(result.created).toBe(1);
  expect(result.commentsAdded).toBe(1);

  const responses2 = [
    { data: [{ iid: 1, title: "E2E Issue", state: "opened", updated_at: "2026-01-01T00:00:00Z" }] },
    { data: [{ id: 100, system: false, body: "E2E Note", author: { username: "u" }, created_at: "2026-01-01T01:00:00Z" }] }
  ];
  fetchImpl = makeFetch(responses2);
  conn = makeGitLabConnector(fetchImpl as any);
  result = await runSync(conn, { projectId });
  
  expect(result.created).toBe(0);
  expect(result.skipped).toBe(1);
  expect(result.commentsAdded).toBe(0);
});
