import { expect, test, vi } from "vitest";
import { makeAsanaConnector } from "../src/sync/connectors/asana.js";
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
  const conn = makeAsanaConnector(fetchImpl as any);
  const tickets = await conn.listExternalTickets();
  expect(tickets).toEqual([]);
  expect(fetchImpl).not.toHaveBeenCalled();
});

test("(b) task + story mapping incl. completed -> closed and non-comment story filtering", async () => {
  __setSettingsForTest({
    "asana.pat": "token",
    "asana.projectGid": "12345"
  });

  const fetchImpl = makeFetch([
    {
      data: {
        data: [
          {
            gid: "100",
            name: "Task 1",
            notes: "Notes 1",
            completed: true,
            modified_at: "2026-01-01T00:00:00Z"
          },
          {
            gid: "200",
            name: "Task 2",
            notes: null,
            completed: false,
            modified_at: "2026-01-02T00:00:00Z"
          }
        ]
      }
    },
    { // Task 100 stories
      data: {
        data: [
          {
            gid: "101",
            type: "comment",
            text: "Comment 1",
            created_by: { name: "Alice" },
            created_at: "2026-01-01T01:00:00Z"
          },
          {
            gid: "102",
            type: "system",
            text: "changed status",
            created_by: { name: "Bob" },
            created_at: "2026-01-01T02:00:00Z"
          }
        ]
      }
    },
    { // Task 200 stories
      data: {
        data: []
      }
    }
  ]);

  const conn = makeAsanaConnector(fetchImpl as any);
  const tickets = await conn.listExternalTickets();
  
  expect(tickets).toHaveLength(2);
  
  expect(tickets[0].externalId).toBe("asana:12345:100");
  expect(tickets[0].title).toBe("Task 1");
  expect(tickets[0].body).toBe("Notes 1");
  expect(tickets[0].status).toBe("closed");
  expect(tickets[0].updatedAt).toBe("2026-01-01T00:00:00Z");
  expect(tickets[0].comments).toHaveLength(1); // non-comment story filtered
  expect(tickets[0].comments[0].externalId).toBe("asana:100:story:101");
  expect(tickets[0].comments[0].author).toBe("Alice");
  expect(tickets[0].comments[0].body).toBe("Comment 1");
  expect(tickets[0].comments[0].createdAt).toBe("2026-01-01T01:00:00Z");
  
  expect(tickets[1].externalId).toBe("asana:12345:200");
  expect(tickets[1].title).toBe("Task 2");
  expect(tickets[1].status).toBe("open");
  expect(tickets[1].body).toBe("");
  expect(tickets[1].comments).toHaveLength(0);
});

test("(c) offset pagination until next_page null", async () => {
  __setSettingsForTest({
    "asana.pat": "token",
    "asana.projectGid": "12345"
  });

  const responses = [];
  let taskId = 1;
  // Create 10 pages, total 500 tasks (50 per page)
  for (let i = 0; i < 10; i++) {
    const pageTasks = Array.from({ length: 50 }, () => ({
      gid: `T-${taskId++}`,
      name: "T", notes: null, completed: false, modified_at: "2026-01-01T00:00:00Z"
    }));
    responses.push({
      data: { 
        data: pageTasks,
        next_page: i < 9 ? { offset: `offset_${i}` } : null
      }
    });
  }
  
  // For each task, return empty stories (500 stories fetches)
  for (let i = 0; i < 500; i++) {
    responses.push({ data: { data: [] } });
  }

  const fetchImpl = makeFetch(responses);
  const conn = makeAsanaConnector(fetchImpl as any);
  const tickets = await conn.listExternalTickets();
  
  expect(tickets).toHaveLength(500);
});

test("(d) cursor formatting: passed correctly into modified_since", async () => {
  __setSettingsForTest({ "asana.pat": "t", "asana.projectGid": "P" });
  const fetchImpl = makeFetch([{ data: { data: [] } }]);
  const conn = makeAsanaConnector(fetchImpl as any);
  const since = new Date("2026-06-01T12:34:56.000Z");
  await conn.listExternalTickets(since);
  
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  const url = new URL(fetchImpl.mock.calls[0][0]);
  const modifiedSince = url.searchParams.get("modified_since");
  expect(modifiedSince).toBe("2026-06-01T12:34:56.000Z");
});

test("(e) non-2xx throws with status", async () => {
  __setSettingsForTest({ "asana.pat": "t", "asana.projectGid": "P" });
  const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 503, statusText: "Service Unavailable" });
  const conn = makeAsanaConnector(fetchImpl as any);
  await expect(conn.listExternalTickets()).rejects.toThrow(/503/);
});

async function newProject() {
  const [p] = await db.insert(projects).values({ key: `p-${Date.now()}-${Math.random()}`, name: "P" }).returning();
  return p.id;
}

test("(f) engine e2e, idempotent second run", async () => {
  const proj = `p${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  __setSettingsForTest({ "asana.pat": "t", "asana.projectGid": proj });
  const projectId = await newProject();
  
  const responses = [
    { data: { data: [{ gid: "100", name: "Title", completed: false, modified_at: "2026-01-01T00:00:00Z" }] } },
    { data: { data: [{ gid: `${proj}-101`, type: "comment", text: "c", created_by: { name: "u" }, created_at: "2026-01-01T01:00:00Z" }] } }
  ];
  
  let fetchImpl = makeFetch(responses);
  let conn = makeAsanaConnector(fetchImpl as any);
  let result = await runSync(conn, { projectId });
  
  expect(result.created).toBe(1);
  expect(result.commentsAdded).toBe(1);

  const responses2 = [
    { data: { data: [{ gid: "100", name: "Title", completed: false, modified_at: "2026-01-01T00:00:00Z" }] } },
    { data: { data: [{ gid: `${proj}-101`, type: "comment", text: "c", created_by: { name: "u" }, created_at: "2026-01-01T01:00:00Z" }] } }
  ];
  fetchImpl = makeFetch(responses2);
  conn = makeAsanaConnector(fetchImpl as any);
  result = await runSync(conn, { projectId });
  
  expect(result.created).toBe(0);
  expect(result.skipped).toBe(1);
  expect(result.commentsAdded).toBe(0);
});
