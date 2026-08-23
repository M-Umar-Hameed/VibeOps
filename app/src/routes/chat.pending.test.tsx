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
    projects: [{ id: "p1", name: "Project One" }],
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

const sess = { id: "s1", title: "Mine", model: "sonnet", projectId: "p1", createdAt: "2026-01-01T00:00:00Z" };

// The regression this pins: a turn started before a remount (app restart,
// session switch) showed NO indicator because pending state lived only in the
// component. The server's own status must drive the indicator.
test("a turn already running on the server shows the working indicator without any local send", async () => {
  apiFetch.mockImplementation(async (path: string) => {
    if (path === "/chat/sessions") return [sess];
    if (path === "/chat/models") return [];
    if (path === "/chat/sessions/s1") return { session: sess, messages: [{ id: "m1", role: "user", body: "retry", createdAt: "2026-01-01T00:00:01Z" }] };
    if (path.startsWith("/chat/sessions/s1/output")) return { chunk: "", next: 0, status: "running" };
    return {};
  });

  render(wrap(<ChatScreen />));
  await waitFor(() => expect(screen.getByText("Mine")).toBeInTheDocument());
  fireEvent.click(screen.getByText("Mine"));

  await waitFor(() => expect(screen.getByTestId("chat-pending")).toBeInTheDocument(), { timeout: 6000 });
});

test("when the server says idle, no indicator appears", async () => {
  apiFetch.mockImplementation(async (path: string) => {
    if (path === "/chat/sessions") return [sess];
    if (path === "/chat/models") return [];
    if (path === "/chat/sessions/s1") return { session: sess, messages: [] };
    if (path.startsWith("/chat/sessions/s1/output")) return { chunk: "", next: 0, status: "idle" };
    return {};
  });

  render(wrap(<ChatScreen />));
  await waitFor(() => expect(screen.getByText("Mine")).toBeInTheDocument());
  fireEvent.click(screen.getByText("Mine"));
  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith(expect.stringContaining("/output"), expect.anything()));
  expect(screen.queryByTestId("chat-pending")).toBeNull();
});

// An idle session still reports its last reply in the live buffer; it must not
// be painted as a second, pulsing bubble next to the persisted message.
test("an idle session's leftover live buffer is not rendered as a live bubble", async () => {
  apiFetch.mockImplementation(async (path: string) => {
    if (path === "/chat/sessions") return [sess];
    if (path === "/chat/models") return [];
    if (path === "/chat/sessions/s1") return { session: sess, messages: [{ id: "m1", role: "assistant", body: "persisted reply", createdAt: "2026-01-01T00:00:01Z" }] };
    if (path.startsWith("/chat/sessions/s1/output")) return { chunk: "persisted reply", next: 15, status: "idle" };
    return {};
  });

  render(wrap(<ChatScreen />));
  await waitFor(() => expect(screen.getByText("Mine")).toBeInTheDocument());
  fireEvent.click(screen.getByText("Mine"));
  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith(expect.stringContaining("/output"), expect.anything()));
  await waitFor(() => expect(screen.getAllByText("persisted reply").length).toBe(1));
  expect(document.querySelector(".animate-pulse")).toBeNull();
});
