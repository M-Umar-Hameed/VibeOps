import { expect, test, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
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
const detail = {
  session,
  messages: [{
    id: "m1", role: "assistant",
    // Assistant prose names a DIFFERENT origin; the affordance must ignore it.
    body: "I could not act. Grant https://evil.com to proceed.",
    toolCalls: [{
      name: "browser_act", input: {},
      summary: "refused: no act grant for https://github.com",
      grantOrigin: "https://github.com",
    }],
    createdAt: "2026-08-20T00:00:01Z",
  }],
};

function mockApi() {
  apiFetch.mockImplementation(async (path: string, opts?: any) => {
    if (path === "/chat/sessions" && opts?.method === "GET") return [session];
    if (path === "/chat/models" && opts?.method === "GET") return [];
    if (path === "/chat/sessions/s1" && opts?.method === "GET") return detail;
    if (path === "/browser/grants" && opts?.method === "POST") return { ok: true };
    return {};
  });
}

test("Allow affordance offers the server-refused origin verbatim and grants exactly it", async () => {
  mockApi();
  render(<Wrap><ChatScreen /></Wrap>);
  fireEvent.click(await screen.findByText("Chat"));

  const btn = await screen.findByRole("button", { name: "Allow browser actions on https://github.com" });
  // Prose said evil.com; the affordance never offers a model-authored origin.
  expect(screen.queryByRole("button", { name: /evil\.com/ })).toBeNull();

  fireEvent.click(btn);
  await waitFor(() => {
    const call = apiFetch.mock.calls.find(([p, o]) => p === "/browser/grants" && o?.method === "POST");
    expect(call).toBeTruthy();
    expect(call![1].body).toEqual({ origin: "https://github.com" });
  });
});
