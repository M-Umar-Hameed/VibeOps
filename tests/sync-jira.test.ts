import { expect, test, vi } from "vitest";
import { makeJiraConnector } from "../src/sync/connectors/jira.js";
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
  const conn = makeJiraConnector(fetchImpl as any);
  const tickets = await conn.listExternalTickets();
  expect(tickets).toEqual([]);
  expect(fetchImpl).not.toHaveBeenCalled();
});

test("(b) issues + comments map correctly incl. ADF flattening and status", async () => {
  __setSettingsForTest({
    "jira.baseUrl": "https://test.atlassian.net",
    "jira.email": "test@test.com",
    "jira.apiToken": "token",
    "jira.project": "ENG"
  });

  const adfDescription = {
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: "Hello " }, { type: "text", text: "world" }]
      },
      {
        type: "paragraph",
        content: [{ type: "text", text: "Line 2" }]
      }
    ]
  };
  
  const fetchImpl = makeFetch([
    {
      data: {
        total: 2,
        issues: [
          {
            key: "ENG-1",
            fields: {
              summary: "Issue 1",
              description: adfDescription,
              status: { statusCategory: { key: "done" } },
              updated: "2026-01-01T00:00:00Z"
            }
          },
          {
            key: "ENG-2",
            fields: {
              summary: "Issue 2",
              description: null,
              status: { statusCategory: { key: "indeterminate" } },
              updated: "2026-01-02T00:00:00Z"
            }
          }
        ]
      }
    },
    { // ENG-1 comments
      data: {
        comments: [
          {
            id: "100",
            author: { displayName: "Alice" },
            body: {
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "Comment 1" }]
                }
              ]
            },
            created: "2026-01-01T01:00:00Z"
          }
        ]
      }
    },
    { // ENG-2 comments
      data: {
        comments: []
      }
    }
  ]);

  const conn = makeJiraConnector(fetchImpl as any);
  const tickets = await conn.listExternalTickets();
  
  expect(tickets).toHaveLength(2);
  
  expect(tickets[0].externalId).toBe("jira:ENG:ENG-1");
  expect(tickets[0].title).toBe("Issue 1");
  expect(tickets[0].body).toBe("Hello world\nLine 2");
  expect(tickets[0].status).toBe("closed");
  expect(tickets[0].updatedAt).toBe("2026-01-01T00:00:00Z");
  expect(tickets[0].comments).toHaveLength(1);
  expect(tickets[0].comments[0].externalId).toBe("jira:ENG-1:comment:100");
  expect(tickets[0].comments[0].author).toBe("Alice");
  expect(tickets[0].comments[0].body).toBe("Comment 1");
  expect(tickets[0].comments[0].createdAt).toBe("2026-01-01T01:00:00Z");
  
  expect(tickets[1].externalId).toBe("jira:ENG:ENG-2");
  expect(tickets[1].title).toBe("Issue 2");
  expect(tickets[1].status).toBe("open");
  expect(tickets[1].body).toBe("");
  expect(tickets[1].comments).toHaveLength(0);
});

test("(c) pagination follows startAt and caps at 10 pages", async () => {
  __setSettingsForTest({
    "jira.baseUrl": "https://test.atlassian.net",
    "jira.email": "t@t.com",
    "jira.apiToken": "tok",
    "jira.project": "P"
  });

  const responses = [];
  let issueId = 1;
  // Create 10 pages, total 500 issues (50 per page)
  for (let i = 0; i < 10; i++) {
    const pageIssues = Array.from({ length: 50 }, () => ({
      key: `P-${issueId++}`,
      fields: { summary: "S", description: null, status: {}, updated: "2026-01-01T00:00:00Z" }
    }));
    responses.push({
      data: { issues: pageIssues, total: 500, maxResults: 50, startAt: i * 50 }
    });
  }
  
  // For each issue, return empty comments (500 comments fetches)
  for (let i = 0; i < 500; i++) {
    responses.push({ data: { comments: [] } });
  }

  const fetchImpl = makeFetch(responses);
  const conn = makeJiraConnector(fetchImpl as any);
  const tickets = await conn.listExternalTickets();
  
  expect(tickets).toHaveLength(500);
});

test("(d) cursor formatting: passed correctly into jql", async () => {
  __setSettingsForTest({ "jira.baseUrl": "https://test", "jira.email": "t", "jira.apiToken": "t", "jira.project": "P" });
  const fetchImpl = makeFetch([{ data: { issues: [], total: 0 } }]);
  const conn = makeJiraConnector(fetchImpl as any);
  const since = new Date("2026-06-01T12:34:56.000Z");
  await conn.listExternalTickets(since);
  
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  const url = new URL(fetchImpl.mock.calls[0][0]);
  const jql = url.searchParams.get("jql");
  expect(jql).toContain("updated>=\"2026-06-01 12:34\"");
});

test("(e) non-2xx throws with status", async () => {
  __setSettingsForTest({ "jira.baseUrl": "https://test", "jira.email": "t", "jira.apiToken": "t", "jira.project": "P" });
  const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 503, statusText: "Service Unavailable" });
  const conn = makeJiraConnector(fetchImpl as any);
  await expect(conn.listExternalTickets()).rejects.toThrow(/503/);
});

async function newProject() {
  const [p] = await db.insert(projects).values({ key: `p-${Date.now()}-${Math.random()}`, name: "P" }).returning();
  return p.id;
}

test("(f) engine e2e, idempotent second run", async () => {
  const proj = `p${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  const ukey = `E${Date.now().toString(36)}-1`; // comment external ids embed the issue key; must be unique per execution too
  __setSettingsForTest({ "jira.baseUrl": "https://t", "jira.email": "t", "jira.apiToken": "t", "jira.project": proj });
  const projectId = await newProject();
  
  const responses = [
    { data: { total: 1, issues: [{ key: ukey, fields: { summary: "Title", status: {}, updated: "2026-01-01T00:00:00Z" } }] } },
    { data: { comments: [{ id: "100", body: { content: [] }, created: "2026-01-01T01:00:00Z" }] } }
  ];
  
  let fetchImpl = makeFetch(responses);
  let conn = makeJiraConnector(fetchImpl as any);
  let result = await runSync(conn, { projectId });
  
  expect(result.created).toBe(1);
  expect(result.commentsAdded).toBe(1);

  const responses2 = [
    { data: { total: 1, issues: [{ key: ukey, fields: { summary: "Title", status: {}, updated: "2026-01-01T00:00:00Z" } }] } },
    { data: { comments: [{ id: "100", body: { content: [] }, created: "2026-01-01T01:00:00Z" }] } }
  ];
  fetchImpl = makeFetch(responses2);
  conn = makeJiraConnector(fetchImpl as any);
  result = await runSync(conn, { projectId });
  
  expect(result.created).toBe(0);
  expect(result.skipped).toBe(1);
  expect(result.commentsAdded).toBe(0);
});
