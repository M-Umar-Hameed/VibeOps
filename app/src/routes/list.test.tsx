import { expect, test, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
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

import { ListScreen } from "./list.js";
import { Sidebar } from "../components/layout/Sidebar.js";
import { ProjectProvider } from "../context/project.js";
import { tickets } from "../api/tickets.js";
import { projects } from "../api/projects.js";

beforeEach(() => {
  apiFetch.mockReset();
  vi.clearAllMocks();
  apiFetch.mockImplementation((path: string) => {
    if (path === "/system/status") return Promise.resolve({
      db: "ok", embedder: "fake-embedder", watcher: { status: "running", indexed: 42 }, activeRuns: 0, uptimeMs: 123456
    });
    return Promise.resolve(undefined);
  });
});

function TestHarness() {
  const queryClient = new QueryClient();
  return (
    <ProjectProvider>
      <QueryClientProvider client={queryClient}>
        <Sidebar />
        <ListScreen />
      </QueryClientProvider>
    </ProjectProvider>
  );
}

test("renders tickets and handles project switching & creation", async () => {
  render(<TestHarness />);
  
  await waitFor(() => expect(screen.getByText("First")).toBeInTheDocument());
  
  // Name renders in both the sidebar entry and the TopBar chip; click the first.
  fireEvent.click(screen.getAllByText("Existing Project")[0]);
  await waitFor(() => {
    expect(tickets.list).toHaveBeenCalledWith({ projectId: "p1", status: undefined });
  });
  
  fireEvent.click(screen.getByText("Add project"));
  
  const nameInput = screen.getByPlaceholderText("Project name");
  const pathInput = screen.getByPlaceholderText("Choose a folder... (optional)");
  
  fireEvent.change(nameInput, { target: { value: "New Proj" } });
  fireEvent.change(pathInput, { target: { value: "/tmp/new" } });
  
  apiFetch.mockResolvedValue({ isGit: true });
  
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  
  await waitFor(() => {
    expect(projects.create).toHaveBeenCalledWith({ key: "new-proj", name: "New Proj" });
  });
  
  await waitFor(() => {
    expect(apiFetch).toHaveBeenCalledWith("/projects/p2", {
      method: "PATCH",
      body: { repoPath: "/tmp/new" }
    });
  });
  
  await waitFor(() => {
    expect(tickets.list).toHaveBeenCalledWith({ projectId: "p2", status: undefined });
  });
});

test("renders system status components", async () => {
  render(<TestHarness />);
  await waitFor(() => expect(screen.getByText("database")).toBeInTheDocument());
  expect(screen.getByText("fake-embedder")).toBeInTheDocument();
});


test("tickets query polls: advancing 5s triggers a refetch", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    render(<TestHarness />);
    await waitFor(() => expect(screen.getByText("First")).toBeInTheDocument());
    const base = (tickets.list as any).mock.calls.length;
    await act(async () => { vi.advanceTimersByTime(5000); });
    await waitFor(() => expect((tickets.list as any).mock.calls.length).toBeGreaterThan(base));
  } finally {
    vi.useRealTimers();
  }
});

test("active-run badge: renders stage for a live run, absent otherwise; one list request for N rows", async () => {
  (tickets.list as any).mockResolvedValue([
    { id: "t1", title: "Live", status: "in_progress", priority: "normal", assigneeId: null, activeRun: { stage: "work" } },
    { id: "t2", title: "Idle", status: "open", priority: "normal", assigneeId: null },
  ]);
  render(<TestHarness />);
  await waitFor(() => expect(screen.getByText("Live")).toBeInTheDocument());

  // Badge present exactly once (the live row only).
  expect(screen.getAllByTestId("active-run-badge")).toHaveLength(1);
  expect(screen.getByTestId("active-run-badge").textContent).toBe("work");

  // ONE request for N tickets — no per-ticket fetch (guards the QW4 N+1).
  expect((tickets.list as any).mock.calls.length).toBe(1);
  expect((apiFetch as any).mock.calls.every((c: any[]) => !String(c[0]).match(/^\/tickets\/[^/]+/))).toBe(true);
});
