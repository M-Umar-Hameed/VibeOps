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
    if (path === "/browser/grants/once" && opts?.method === "POST") return { ok: true };
    if (path === "/chat/sessions/s1/messages" && opts?.method === "POST") return { ok: true };
    return {};
  });
}

async function openChat() {
  render(<Wrap><ChatScreen /></Wrap>);
  fireEvent.click(await screen.findByText("Chat"));
}

test("the refused origin offers Allow once, Always allow, Deny; never the model-authored origin", async () => {
  mockApi();
  await openChat();

  expect(await screen.findByRole("button", { name: "Allow once" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Always allow" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Deny" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /evil\.com/ })).toBeNull();
});

test("Always allow grants persistently, then sends the always-continue message, then hides the buttons", async () => {
  mockApi();
  await openChat();

  fireEvent.click(await screen.findByRole("button", { name: "Always allow" }));

  await waitFor(() => {
    const grant = apiFetch.mock.calls.find(([p, o]) => p === "/browser/grants" && o?.method === "POST");
    expect(grant).toBeTruthy();
    expect(grant![1].body).toEqual({ origin: "https://github.com" });
  });
  await waitFor(() => {
    const msg = apiFetch.mock.calls.find(([p, o]) => p === "/chat/sessions/s1/messages" && o?.method === "POST");
    expect(msg).toBeTruthy();
    expect((msg![1].body as any).body).toBe("Allowed browser actions on https://github.com always. Continue.");
  });
  await waitFor(() => {
    expect(screen.queryByRole("button", { name: "Allow once" })).toBeNull();
    expect(screen.getByText("Always allowed on https://github.com")).toBeInTheDocument();
  });
});

test("Allow once posts the session-scoped once-grant, then sends the once-continue message", async () => {
  mockApi();
  await openChat();

  fireEvent.click(await screen.findByRole("button", { name: "Allow once" }));

  await waitFor(() => {
    const grant = apiFetch.mock.calls.find(([p, o]) => p === "/browser/grants/once" && o?.method === "POST");
    expect(grant).toBeTruthy();
    expect(grant![1].body).toEqual({ origin: "https://github.com", sessionId: "s1" });
  });
  await waitFor(() => {
    const msg = apiFetch.mock.calls.find(([p, o]) => p === "/chat/sessions/s1/messages" && o?.method === "POST");
    expect(msg).toBeTruthy();
    expect((msg![1].body as any).body).toBe("Allowed browser actions on https://github.com once. Continue.");
  });
  await waitFor(() => {
    expect(screen.getByText("Allowed once on https://github.com")).toBeInTheDocument();
  });
});

test("Deny sends no grant request but sends the deny message, then hides the buttons", async () => {
  mockApi();
  await openChat();

  fireEvent.click(await screen.findByRole("button", { name: "Deny" }));

  await waitFor(() => {
    const msg = apiFetch.mock.calls.find(([p, o]) => p === "/chat/sessions/s1/messages" && o?.method === "POST");
    expect(msg).toBeTruthy();
    expect((msg![1].body as any).body).toBe("Denied browser actions on https://github.com. Do not retry it.");
  });
  expect(apiFetch.mock.calls.some(([p]) => p === "/browser/grants")).toBe(false);
  expect(apiFetch.mock.calls.some(([p]) => p === "/browser/grants/once")).toBe(false);
  await waitFor(() => {
    expect(screen.queryByRole("button", { name: "Deny" })).toBeNull();
    expect(screen.getByText("Denied on https://github.com")).toBeInTheDocument();
  });
});
