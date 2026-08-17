import { expect, test, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";

const apiFetch = vi.fn();
vi.mock("../api/client.js", () => ({ apiFetch: (...a: any[]) => apiFetch(...a) }));

vi.mock("../api/tickets.js", () => ({ tickets: {
  list: vi.fn(async () => [{ id: "t1", title: "First", status: "open", priority: "normal", assigneeId: null }]),
  search: vi.fn(async () => []),
} }));

vi.mock("../api/projects.js", () => ({ projects: { 
  list: vi.fn(async () => [{ id: "p1", name: "Existing Project", key: "existing", repoPath: "/tmp/repo" }]),
  create: vi.fn(async (input) => ({ id: "p2", name: input.name, key: input.key, isGit: true }))
} }));

vi.mock("../api/actors.js", () => ({ actors: { list: vi.fn(async () => []) } }));

vi.mock("@tanstack/react-router", () => ({ 
  Link: (p: any) => <a>{p.children}</a>,
  useLocation: () => ({ pathname: "/" })
}));

vi.mock("../lib/events.js", () => ({
  useStreamConnected: () => true,
  startEventStream: vi.fn(),
  stopEventStream: vi.fn(),
}));

import { ListScreen } from "./list.js";
import { Sidebar } from "../components/layout/Sidebar.js";
import { ProjectProvider } from "../context/project.js";
import { tickets } from "../api/tickets.js";

beforeEach(() => {
  apiFetch.mockReset();
  vi.clearAllMocks();
  apiFetch.mockImplementation((path: string) => {
    if (path === "/system/status") return Promise.resolve({
      db: "ok", embedder: "fake-embedder", watcher: { status: "running", indexed: 42 }, activeRuns: 0, uptimeMs: 123456
    });
    return Promise.resolve(undefined);
  });
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => { vi.useRealTimers(); });

function TestHarness() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <ProjectProvider>
      <QueryClientProvider client={queryClient}>
        <Sidebar />
        <ListScreen />
      </QueryClientProvider>
    </ProjectProvider>
  );
}

test("connected: no interval-driven refetch of tickets", async () => {
  render(<TestHarness />);
  await waitFor(() => expect(screen.getByText("First")).toBeInTheDocument());
  const initialCalls = (tickets.list as any).mock.calls.length;
  await act(async () => { vi.advanceTimersByTime(6000); });
  expect((tickets.list as any).mock.calls.length).toBe(initialCalls);
});
