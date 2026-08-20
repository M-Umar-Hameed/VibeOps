import { expect, test, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const apiFetch = vi.fn();
vi.mock("../lib/api.js", () => ({
  api: {
    get: (p: string) => apiFetch(p, { method: "GET" }),
    post: (p: string, b?: unknown) => apiFetch(p, { method: "POST", body: b }),
    del: (p: string, b?: unknown) => apiFetch(p, { method: "DELETE", body: b }),
  },
}));

vi.mock("../context/project.js", () => ({
  ProjectProvider: ({ children }: any) => children,
  useProject: () => ({ activeProjectId: null, projects: [], setActiveProject: () => {}, refreshProjects: async () => {} }),
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

test("deleting the selected session calls DELETE and clears the selection", async () => {
  apiFetch.mockImplementation(async (path: string, opts: any) => {
    if (path === "/chat/sessions" && opts.method === "GET")
      return [{ id: "s1", title: "My Chat", model: "sonnet", projectId: null, createdAt: "2026-01-01T00:00:00Z" }];
    if (path === "/chat/models") return [];
    if (path === "/chat/sessions/s1" && opts.method === "GET")
      return { session: { id: "s1", title: "My Chat", model: "sonnet", projectId: null, createdAt: "2026-01-01T00:00:00Z" }, messages: [] };
    if (path === "/chat/sessions/s1" && opts.method === "DELETE") return { ok: true };
    return {};
  });

  render(wrap(<ChatScreen />));
  await waitFor(() => expect(screen.getByText("My Chat")).toBeInTheDocument());

  // Select the session -> detail pane active (placeholder gone).
  fireEvent.click(screen.getByText("My Chat"));
  await waitFor(() => expect(screen.queryByText("Select a chat or create a new one")).not.toBeInTheDocument());

  // Open the row action menu.
  fireEvent.click(screen.getByLabelText("Actions for My Chat"));
  fireEvent.click(screen.getByText("Delete chat"));

  // Confirm step.
  expect(screen.getByText("Delete this chat?")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Delete chat" }));

  await waitFor(() => {
    expect(apiFetch).toHaveBeenCalledWith("/chat/sessions/s1", expect.objectContaining({ method: "DELETE" }));
  });

  // Selection cleared -> detail pane back to placeholder.
  await waitFor(() => expect(screen.getByText("Select a chat or create a new one")).toBeInTheDocument());
});
