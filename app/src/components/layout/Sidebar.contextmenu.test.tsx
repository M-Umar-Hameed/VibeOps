import { expect, test, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { del, post } = vi.hoisted(() => ({
  del: vi.fn(async () => ({ ok: true })),
  post: vi.fn(async () => ({ indexed: 1, skipped: 0, removed: 0 })),
}));
vi.mock("../../lib/api.js", () => ({
  api: { get: vi.fn(async () => ({})), post, patch: vi.fn(async () => ({})), put: vi.fn(async () => ({})), del },
}));

vi.mock("../../api/projects.js", () => ({
  projects: { list: vi.fn(async () => []), create: vi.fn() },
}));

const { openRepoFolder, setActiveProject, refreshProjects, projectA, projectB } = vi.hoisted(() => ({
  openRepoFolder: vi.fn(),
  setActiveProject: vi.fn(),
  refreshProjects: vi.fn(async () => {}),
  projectA: { id: "a1", key: "a", name: "Project A", createdAt: "", repoPath: "C:/repos/a" },
  projectB: { id: "b1", key: "b", name: "Project B", createdAt: "", repoPath: null },
}));

vi.mock("../../lib/native-dialog.js", () => ({
  dialogAvailable: vi.fn(async () => false),
  pickFolder: vi.fn(),
  openRepoFolder,
}));

vi.mock("../../context/project.js", () => ({
  useProject: () => ({
    projects: [projectA, projectB],
    activeProjectId: null,
    setActiveProject,
    refreshProjects,
  }),
  ProjectProvider: (p: any) => <div>{p.children}</div>,
}));

vi.mock("@tanstack/react-router", () => ({
  Link: (p: any) => <a data-testid="link">{p.children}</a>,
  useLocation: () => ({ pathname: "/" }),
}));

import { Sidebar } from "./Sidebar.js";

function renderSidebar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <Sidebar />
    </QueryClientProvider>
  );
}

function openMenuFor(name: string) {
  const row = screen.getByText(name).closest("button")!;
  fireEvent.contextMenu(row);
  return screen.getByRole("menu");
}

beforeEach(() => {
  del.mockClear();
  post.mockClear();
  openRepoFolder.mockClear();
  setActiveProject.mockClear();
  refreshProjects.mockClear();
});

test("right-click opens menu with all five items", () => {
  renderSidebar();
  const menu = openMenuFor("Project A");
  expect(within(menu).getByText("Set as active")).toBeInTheDocument();
  expect(within(menu).getByText("Index docs")).toBeInTheDocument();
  expect(within(menu).getByText("Open repo folder")).toBeInTheDocument();
  expect(within(menu).getByText("Clear knowledge")).toBeInTheDocument();
  expect(within(menu).getByText("Delete project")).toBeInTheDocument();
});

test("Open repo folder is disabled for a project with no repoPath", () => {
  renderSidebar();
  const menu = openMenuFor("Project B");
  expect(within(menu).getByText("Open repo folder").closest("button")).toBeDisabled();
});

test("Escape closes the menu", () => {
  renderSidebar();
  openMenuFor("Project A");
  expect(screen.getByRole("menu")).toBeInTheDocument();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
});

test("destructive item requires confirmation; cancelling performs no request", () => {
  renderSidebar();
  const menu = openMenuFor("Project A");
  fireEvent.click(within(menu).getByText("Delete project"));
  expect(screen.getByText(/Delete "Project A"\?/)).toBeInTheDocument();
  fireEvent.click(screen.getByText("Cancel"));
  expect(del).not.toHaveBeenCalled();
});

test("confirming Delete calls the delete endpoint once and closes the menu", async () => {
  renderSidebar();
  const menu = openMenuFor("Project A");
  fireEvent.click(within(menu).getByText("Delete project"));
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  await waitFor(() => expect(del).toHaveBeenCalledTimes(1));
  expect(del).toHaveBeenCalledWith("/projects/a1");
  expect(refreshProjects).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
});

test("the overflow button opens the menu without a right-click (keyboard-reachable)", () => {
  renderSidebar();
  fireEvent.click(screen.getByLabelText("Actions for Project A"));
  expect(screen.getByRole("menu")).toBeInTheDocument();
});

// The sidebar's backdrop-blur makes it the containing block for fixed
// descendants; an in-tree menu's inset-0 backdrop then only covers the sidebar,
// so clicks in the main content never close the menu.
test("project menu renders outside the sidebar so the backdrop covers the viewport", async () => {
  renderSidebar();
  const row = await screen.findByText("Project A");
  fireEvent.contextMenu(row);
  const menu = await screen.findByRole("menu", { name: /Actions for Project A/ });
  const aside = document.querySelector("aside");
  expect(aside?.contains(menu)).toBe(false);
  expect(document.body.contains(menu)).toBe(true);
});

test("Index docs shows a spinner while indexing runs", async () => {
  let resolve!: (v: any) => void;
  post.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
  renderSidebar();
  const menu = openMenuFor("Project A");
  fireEvent.click(within(menu).getByText("Index docs"));
  expect(await within(menu).findByTestId("menu-item-spinner")).toBeInTheDocument();
  resolve({ indexed: 1, skipped: 0, removed: 0 });
  await waitFor(() => expect(within(menu).getByRole("status")).toHaveTextContent("indexed 1"));
});
