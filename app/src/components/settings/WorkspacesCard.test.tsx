import { expect, test, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";
import { WorkspacesCard } from "./WorkspacesCard.js";

const apiFetch = vi.fn();
vi.mock("../../api/client.js", () => ({ apiFetch: (...a: any[]) => apiFetch(...a) }));

const wrap = (ui: any) => <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>;

const wrapWithClient = (ui: any, client: QueryClient) =>
  <QueryClientProvider client={client}>{ui}</QueryClientProvider>;

const mockProjects = [
  { id: "1", key: "GIT", name: "Git Project", createdAt: "2023", repoPath: "/tmp/git", isGit: true },
  { id: "2", key: "NOT", name: "Not Git Project", createdAt: "2023", repoPath: "/tmp/not", isGit: false },
  { id: "3", key: "DEF", name: "Default Project", createdAt: "2023", repoPath: null, isGit: false },
];

beforeEach(() => {
  apiFetch.mockReset().mockImplementation(async (path: string, options?: any) => {
    if (path === "/projects" && (!options || options.method === "GET" || !options.method)) {
      return mockProjects;
    }
    return {};
  });
});

test("renders rows and status chips", async () => {
  render(wrap(<WorkspacesCard />));
  
  await waitFor(() => expect(screen.getByText("Git Project")).toBeInTheDocument());
  
  expect(screen.getByText("git")).toBeInTheDocument();
  expect(screen.getByText("not git")).toBeInTheDocument();
  expect(screen.getByText("default workdir")).toBeInTheDocument();
  
  const initButtons = screen.getAllByText("Initialize git");
  expect(initButtons).toHaveLength(1);
});

test("Save PATCHes edited row and refreshes", async () => {
  render(wrap(<WorkspacesCard />));
  await waitFor(() => expect(screen.getByText("Default Project")).toBeInTheDocument());
  
  apiFetch.mockClear();
  
  const inputs = screen.getAllByPlaceholderText("Choose a folder...");
  fireEvent.change(inputs[2], { target: { value: "/new/path" } });
  
  const saveButtons = screen.getAllByText("Save");
  fireEvent.click(saveButtons[2]);
  
  await waitFor(() => {
    expect(apiFetch).toHaveBeenCalledWith("/projects/3", expect.objectContaining({
      method: "PATCH",
      body: { repoPath: "/new/path" }
    }));
  });
});

test("Initialize git POSTs correct project and refreshes", async () => {
  render(wrap(<WorkspacesCard />));
  await waitFor(() => expect(screen.getByText("Not Git Project")).toBeInTheDocument());
  
  apiFetch.mockClear();
  
  const initButton = screen.getByText("Initialize git");
  fireEvent.click(initButton);
  
  await waitFor(() => {
    expect(apiFetch).toHaveBeenCalledWith("/projects/2/git-init", expect.objectContaining({
      method: "POST"
    }));
  });
});

test("Failed PATCH shows inline error", async () => {
  render(wrap(<WorkspacesCard />));
  await waitFor(() => expect(screen.getByText("Default Project")).toBeInTheDocument());
  
  apiFetch.mockImplementation(async (path: string, options?: any) => {
    if (path === "/projects/3" && options?.method === "PATCH") {
      throw new Error("Permission denied");
    }
    if (path === "/projects" && (!options || options.method === "GET" || !options.method)) {
      return mockProjects;
    }
    return {};
  });
  
  const inputs = screen.getAllByPlaceholderText("Choose a folder...");
  fireEvent.change(inputs[2], { target: { value: "/forbidden" } });
  
  const saveButtons = screen.getAllByText("Save");
  fireEvent.click(saveButtons[2]);
  
  await waitFor(() => {
    expect(screen.getByText("Permission denied")).toBeInTheDocument();
  });
});

test("Failed initGit invalidates projects query on error", async () => {
  const client = new QueryClient();
  const spy = vi.spyOn(client, "invalidateQueries");

  apiFetch.mockImplementation(async (path: string, options?: any) => {
    if (path === "/projects/2/git-init" && options?.method === "POST") {
      throw new Error("repoPath is already a git repository");
    }
    if (path === "/projects" && (!options || options.method === "GET" || !options.method)) {
      return mockProjects;
    }
    return {};
  });

  render(wrapWithClient(<WorkspacesCard />, client));
  await waitFor(() => expect(screen.getByText("Not Git Project")).toBeInTheDocument());

  spy.mockClear();
  fireEvent.click(screen.getByText("Initialize git"));

  await waitFor(() => {
    expect(spy).toHaveBeenCalledWith({ queryKey: ["projects"] });
  });
  expect(screen.getByText("repoPath is already a git repository")).toBeInTheDocument();
});

test("Failed savePath invalidates projects query on error", async () => {
  const client = new QueryClient();
  const spy = vi.spyOn(client, "invalidateQueries");

  apiFetch.mockImplementation(async (path: string, options?: any) => {
    if (path === "/projects/3" && options?.method === "PATCH") {
      throw new Error("Permission denied");
    }
    if (path === "/projects" && (!options || options.method === "GET" || !options.method)) {
      return mockProjects;
    }
    return {};
  });

  render(wrapWithClient(<WorkspacesCard />, client));
  await waitFor(() => expect(screen.getByText("Default Project")).toBeInTheDocument());

  spy.mockClear();
  const inputs = screen.getAllByPlaceholderText("Choose a folder...");
  fireEvent.change(inputs[2], { target: { value: "/forbidden" } });
  fireEvent.click(screen.getAllByText("Save")[2]);

  await waitFor(() => {
    expect(spy).toHaveBeenCalledWith({ queryKey: ["projects"] });
  });
  expect(screen.getByText("Permission denied")).toBeInTheDocument();
});
