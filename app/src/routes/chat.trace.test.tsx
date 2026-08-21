import { expect, test, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

const apiFetch = vi.fn();
vi.mock("../lib/api.js", () => ({
  api: {
    get: (p: string) => apiFetch(p, { method: "GET" }),
    post: (p: string, b?: unknown) => apiFetch(p, { method: "POST", body: b }),
    patch: (p: string, b?: unknown) => apiFetch(p, { method: "PATCH", body: b }),
    del: (p: string, b?: unknown) => apiFetch(p, { method: "DELETE", body: b }),
  },
}));
vi.mock("../context/project.js", () => ({
  useProject: () => ({ activeProjectId: null, projects: [], setActiveProject: () => {}, refreshProjects: async () => {} }),
}));

import { ChatScreen } from "./chat.js";

beforeEach(() => apiFetch.mockReset());

function Wrap({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const session = { id: "s1", title: "Chat", model: "sonnet", projectId: null, createdAt: "2026-08-20T00:00:00Z" };

function mockWith(messages: unknown[]) {
  apiFetch.mockImplementation(async (path: string, opts?: any) => {
    if (path === "/chat/sessions" && opts?.method === "GET") return [session];
    if (path === "/chat/models" && opts?.method === "GET") return [];
    if (path === "/chat/sessions/s1" && opts?.method === "GET") return { session, messages };
    if (path === "/browser/grants" && opts?.method === "POST") return { ok: true };
    return {};
  });
}

test("a turn with tool calls renders one trace entry per call with its name", async () => {
  mockWith([{
    id: "m1", role: "assistant", body: "done", createdAt: "2026-08-20T00:00:01Z",
    toolCalls: [
      { name: "knowledge_search", input: { query: "x" }, summary: "3 hit(s)" },
      { name: "board_tickets", input: { status: "open" }, summary: "2 ticket(s)" },
    ],
  }]);
  render(<Wrap><ChatScreen /></Wrap>);
  fireEvent.click(await screen.findByText("Chat"));

  const entries = await screen.findAllByTestId("tool-trace-entry");
  expect(entries).toHaveLength(2);
  expect(screen.getByText("knowledge_search")).toBeInTheDocument();
  expect(screen.getByText("board_tickets")).toBeInTheDocument();
});

test("a turn with no tool calls renders no trace section", async () => {
  mockWith([{ id: "m1", role: "assistant", body: "just prose", createdAt: "2026-08-20T00:00:01Z" }]);
  render(<Wrap><ChatScreen /></Wrap>);
  fireEvent.click(await screen.findByText("Chat"));

  await screen.findByText("just prose");
  expect(screen.queryByTestId("tool-trace")).toBeNull();
});

test("a refused browser call renders its Allow affordance alongside the trace entry", async () => {
  mockWith([{
    id: "m1", role: "assistant", body: "refused", createdAt: "2026-08-20T00:00:01Z",
    toolCalls: [{
      name: "browser_act", input: {},
      summary: "refused: no act grant for https://github.com",
      grantOrigin: "https://github.com",
    }],
  }]);
  render(<Wrap><ChatScreen /></Wrap>);
  fireEvent.click(await screen.findByText("Chat"));

  expect(await screen.findByText("browser_act")).toBeInTheDocument();
  expect(await screen.findByRole("button", { name: "Allow browser actions on https://github.com" })).toBeInTheDocument();
});

test("raw tool input is not rendered verbatim into the transcript", async () => {
  const SENTINEL = "PAGE_DERIVED_SECRET_9137";
  mockWith([{
    id: "m1", role: "assistant", body: "done", createdAt: "2026-08-20T00:00:01Z",
    toolCalls: [{ name: "knowledge_search", input: { query: SENTINEL }, summary: "1 hit(s)" }],
  }]);
  render(<Wrap><ChatScreen /></Wrap>);
  fireEvent.click(await screen.findByText("Chat"));

  // summary path renders; the raw input blob does not.
  expect(await screen.findByText(/1 hit\(s\)/)).toBeInTheDocument();
  expect(screen.queryByText(new RegExp(SENTINEL))).toBeNull();
});
