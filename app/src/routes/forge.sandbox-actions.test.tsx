import { expect, test, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const apiFetch = vi.fn();
vi.mock("../api/client.js", () => ({ apiFetch: (...a: any[]) => apiFetch(...a) }));

const { mockState } = vi.hoisted(() => ({ mockState: { activeProjectId: null as string | null } }));
vi.mock("../context/project.js", () => ({
  ProjectProvider: ({ children }: any) => children,
  useProject: () => ({ activeProjectId: mockState.activeProjectId, projects: [], setActiveProject: () => {}, refreshProjects: async () => {} }),
}));

import { QueryClientProvider, QueryClient } from "@tanstack/react-query";
import { ForgeScreen } from "./forge.js";
import { ProjectProvider } from "../context/project.js";

const wrap = (ui: any) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <ProjectProvider>{ui}</ProjectProvider>
  </QueryClientProvider>
);

beforeEach(() => { mockState.activeProjectId = null; apiFetch.mockReset(); localStorage.clear(); });
afterEach(() => { vi.useRealTimers(); });

function mockReviewTicket(extra: (path: string) => unknown = () => undefined) {
  apiFetch.mockImplementation(async (path: string) => {
    const hit = extra(path);
    if (hit !== undefined) return hit;
    if (path === "/tickets") return [{ id: "t2", title: "Review Ticket", status: "review", version: 1, body: "b" }];
    if (path === "/forge/tickets/t2/sandbox") return { exists: true, branch: "forge/t2", lastVerdict: "pass" };
    if (path.split("?")[0] === "/forge/runs") return [];
    if (path === "/forge/agents" || path === "/forge/skills" || path === "/actors" || path === "/forge/doctor") return [];
    if (path === "/forge/recovery") return { interrupted: [] };
    if (path.includes("/comments")) return [];
    return {};
  });
}

test("Discard needs a second click before it posts", async () => {
  mockReviewTicket();
  render(wrap(<ForgeScreen />));
  fireEvent.click(await screen.findByText("Review Ticket"));
  const discard = await screen.findByRole("button", { name: /^Discard$/i });
  fireEvent.click(discard);
  expect(screen.getByRole("button", { name: /Confirm discard\?/i })).toBeInTheDocument();
  expect(apiFetch).not.toHaveBeenCalledWith("/forge/tickets/t2/discard", expect.anything());
  fireEvent.click(screen.getByRole("button", { name: /Confirm discard\?/i }));
  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/forge/tickets/t2/discard", expect.objectContaining({ method: "POST" })));
});

test("Promote is disabled while the merge runs and reports success", async () => {
  let resolve!: (v: unknown) => void;
  mockReviewTicket((path) => path === "/forge/tickets/t2/promote" ? new Promise((r) => { resolve = r; }) : undefined);
  render(wrap(<ForgeScreen />));
  fireEvent.click(await screen.findByText("Review Ticket"));
  const promote = await screen.findByRole("button", { name: /Promote/i });
  await waitFor(() => expect(promote).not.toBeDisabled());
  fireEvent.click(promote);
  await waitFor(() => expect(promote).toBeDisabled());
  expect(promote).toHaveAttribute("title", "Merging the sandbox into the project repository");
  resolve({ id: "t2", status: "closed" });
  await screen.findByTestId("promote-done");
  const closedCalls = apiFetch.mock.calls.filter((c: any[]) => String(c[0]).startsWith("/tickets?status=closed")).length;
  expect(closedCalls).toBeGreaterThanOrEqual(2);
  expect(apiFetch).toHaveBeenCalledWith("/forge/tickets/t2/promote", expect.objectContaining({ method: "POST" }));
});

test("a promote still in flight does not leak its state into another work order", async () => {
  let resolve!: (v: unknown) => void;
  apiFetch.mockImplementation(async (path: string) => {
    if (path === "/tickets") return [
      { id: "t2", title: "Review Ticket", status: "review", version: 1, body: "b" },
      { id: "t3", title: "Other Review Ticket", status: "review", version: 1, body: "b" },
    ];
    if (path === "/forge/tickets/t2/sandbox" || path === "/forge/tickets/t3/sandbox") return { exists: true, branch: `forge/${path.split("/")[3]}`, lastVerdict: "pass" };
    if (path === "/forge/tickets/t2/promote") return new Promise((r) => { resolve = r; });
    if (path.split("?")[0] === "/forge/runs") return [];
    if (path === "/forge/agents" || path === "/forge/skills" || path === "/actors" || path === "/forge/doctor") return [];
    if (path === "/forge/recovery") return { interrupted: [] };
    if (path.includes("/comments")) return [];
    return {};
  });
  render(wrap(<ForgeScreen />));
  fireEvent.click(await screen.findByText("Review Ticket"));
  const promote = await screen.findByRole("button", { name: /Promote/i });
  await waitFor(() => expect(promote).not.toBeDisabled());
  fireEvent.click(promote);
  await waitFor(() => expect(promote).toBeDisabled());
  fireEvent.click(screen.getByText("Other Review Ticket"));
  await waitFor(() => expect(screen.getByRole("button", { name: /Promote/i })).not.toBeDisabled());
  resolve({ id: "t2", status: "closed" });
  await waitFor(() => expect(screen.getByText(/Branch:/).parentElement).toHaveTextContent("forge/t3"));
  expect(screen.queryByTestId("promote-done")).not.toBeInTheDocument();
});

test("the operator prompt is cleared when another work order is selected", async () => {
  apiFetch.mockImplementation(async (path: string) => {
    if (path === "/tickets") return [
      { id: "t1", title: "First Ticket", status: "open", version: 1, body: null },
      { id: "t2", title: "Second Ticket", status: "open", version: 1, body: null },
    ];
    if (path.includes("/sandbox")) return { exists: false };
    if (path.split("?")[0] === "/forge/runs") return [];
    if (path === "/forge/agents" || path === "/forge/skills" || path === "/actors" || path === "/forge/doctor") return [];
    if (path === "/forge/recovery") return { interrupted: [] };
    if (path.includes("/comments")) return [];
    return {};
  });
  render(wrap(<ForgeScreen />));
  fireEvent.click(await screen.findByText("First Ticket"));
  const box = await screen.findByPlaceholderText(/Extra instructions for this run/);
  fireEvent.change(box, { target: { value: "only for the first ticket" } });
  expect(box).toHaveValue("only for the first ticket");
  fireEvent.click(screen.getByText("Second Ticket"));
  await waitFor(() => expect(screen.getByPlaceholderText(/Extra instructions for this run/)).toHaveValue(""));
});
