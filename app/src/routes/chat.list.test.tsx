import { expect, test, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

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
  ProjectProvider: ({ children }: any) => children,
  useProject: () => ({
    activeProjectId: "p1",
    projects: [{ id: "p1", name: "Project One" }, { id: "p2", name: "Project Two" }],
    setActiveProject: () => {},
    refreshProjects: async () => {},
  }),
}));

import { QueryClientProvider, QueryClient } from "@tanstack/react-query";
import { ChatScreen } from "./chat.js";

const wrap = (ui: any) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {ui}
  </QueryClientProvider>
);

beforeEach(() => {
  apiFetch.mockReset();
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => { vi.useRealTimers(); });

const sess = (id: string, title: string, projectId: string | null) =>
  ({ id, title, model: "sonnet", projectId, createdAt: "2026-01-01T00:00:00Z" });

test("session list shows active-project and global sessions, hides other projects", async () => {
  apiFetch.mockImplementation(async (path: string) => {
    if (path === "/chat/sessions")
      return [sess("s1", "Mine P1", "p1"), sess("s2", "Other P2", "p2"), sess("s3", "Global One", null)];
    if (path === "/chat/models") return [];
    return {};
  });

  render(wrap(<ChatScreen />));
  await waitFor(() => expect(screen.getByText("Mine P1")).toBeInTheDocument());
  expect(screen.getByText("Global One")).toBeInTheDocument();
  expect(screen.queryByText("Other P2")).not.toBeInTheDocument();
});

test("renaming a session issues PATCH with the new title", async () => {
  apiFetch.mockImplementation(async (path: string, opts: any) => {
    if (path === "/chat/sessions" && opts.method === "GET") return [sess("s1", "Old Name", "p1")];
    if (path === "/chat/models") return [];
    if (path === "/chat/sessions/s1" && opts.method === "PATCH") return sess("s1", "New Name", "p1");
    return {};
  });

  render(wrap(<ChatScreen />));
  await waitFor(() => expect(screen.getByText("Old Name")).toBeInTheDocument());

  fireEvent.click(screen.getByLabelText("Actions for Old Name"));
  fireEvent.click(screen.getByText("Rename"));

  const input = await screen.findByLabelText("Rename Old Name");
  fireEvent.change(input, { target: { value: "New Name" } });
  fireEvent.keyDown(input, { key: "Enter" });

  await waitFor(() => {
    expect(apiFetch).toHaveBeenCalledWith(
      "/chat/sessions/s1",
      expect.objectContaining({ method: "PATCH", body: { title: "New Name" } })
    );
  });
});

test("pending indicator appears while a turn is in flight and clears on settle", async () => {
  apiFetch.mockImplementation(async (path: string, opts: any) => {
    if (path === "/chat/sessions" && opts.method === "GET") return [sess("s1", "Chat", "p1")];
    if (path === "/chat/models") return [];
    if (path === "/chat/sessions/s1" && opts.method === "GET")
      return { session: sess("s1", "Chat", "p1"), messages: [] };
    if (path === "/chat/sessions/s1/messages" && opts.method === "POST") return { ok: true };
    if (path.startsWith("/chat/sessions/s1/output")) return { chunk: "", next: 0, status: "idle" };
    return {};
  });

  render(wrap(<ChatScreen />));
  await waitFor(() => expect(screen.getByText("Chat")).toBeInTheDocument());
  fireEvent.click(screen.getByText("Chat"));
  await waitFor(() => expect(screen.queryByText("Select a chat or create a new one")).not.toBeInTheDocument());

  const box = screen.getByPlaceholderText("Type a message...");
  fireEvent.change(box, { target: { value: "hi" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));

  // Indicator present the instant the turn is sent, before any chunk arrives.
  await waitFor(() => expect(screen.getByTestId("chat-pending")).toBeInTheDocument());

  // Poll returns status "idle" -> turn settles -> indicator gone.
  await waitFor(() => expect(screen.queryByTestId("chat-pending")).not.toBeInTheDocument());
});

test("an http lane with one tool-capable and one plain model renders ' · tools' on exactly the first", async () => {
  apiFetch.mockImplementation(async (path: string, opts: any) => {
    if (path === "/chat/sessions" && opts.method === "GET") return [sess("s1", "Chat", "p1")];
    if (path === "/chat/models") return [{
      agent: "openrouter", toolCapable: false,
      models: [
        { name: "anthropic/claude-3.5-sonnet", toolCapable: true },
        { name: "meta/llama-3", toolCapable: false },
      ],
    }];
    if (path === "/chat/sessions/s1" && opts.method === "GET")
      return { session: sess("s1", "Chat", "p1"), messages: [] };
    if (path.startsWith("/chat/sessions/s1/output")) return { chunk: "", next: 0, status: "idle" };
    return {};
  });

  render(wrap(<ChatScreen />));
  await waitFor(() => expect(screen.getByText("Chat")).toBeInTheDocument());
  fireEvent.click(screen.getByText("Chat"));

  await waitFor(() => expect(screen.getByText("anthropic/claude-3.5-sonnet · tools")).toBeInTheDocument());
  expect(screen.getByText("meta/llama-3")).toBeInTheDocument();
  expect(screen.queryByText("meta/llama-3 · tools")).not.toBeInTheDocument();
});
