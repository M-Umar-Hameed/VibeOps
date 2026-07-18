import { expect, test, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
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
    if (path === "/system/status") return Promise.resolve({ components: [
      { name: "database", status: "up", detail: "" },
      { name: "connector github", status: "off", detail: "not configured" },
    ] });
    return Promise.resolve(undefined);
  });
});

function TestHarness() {
  const queryClient = new QueryClient();
  return (
    <ProjectProvider>
      <QueryClientProvider client={queryClient}>
        <Sidebar isOpen={true} setIsOpen={() => {}} />
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
  const pathInput = screen.getByPlaceholderText("Absolute folder path (optional)");
  
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
  expect(screen.getByText("connector github")).toBeInTheDocument();
});

