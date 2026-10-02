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

function wrapWith(qc: QueryClient, ui: any) {
  return <QueryClientProvider client={qc}><ProjectProvider>{ui}</ProjectProvider></QueryClientProvider>;
}
const baseMock = (path: string) => {
  if (path === "/forge/agents" || path === "/forge/skills" || path === "/actors" || path === "/forge/doctor") return [];
  if (path === "/forge/recovery") return { interrupted: [] };
  if (path.includes("/comments")) return [];
  return undefined;
};

beforeEach(() => { mockState.activeProjectId = null; apiFetch.mockReset(); localStorage.clear(); });
afterEach(() => { vi.useRealTimers(); });

test("the selected work order follows the list when its version changes", async () => {
  let row = { id: "t1", title: "My Ticket", status: "open", version: 1, body: null as string | null };
  apiFetch.mockImplementation(async (path: string) => {
    if (path === "/tickets") return [row];
    if (path.includes("/sandbox")) return { exists: false };
    if (path.split("?")[0] === "/forge/runs") return [];
    return baseMock(path) ?? {};
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(wrapWith(qc, <ForgeScreen />));
  fireEvent.click(await screen.findByText("My Ticket"));
  await screen.findByLabelText("Ticket status"); // open renders the status select
  row = { ...row, status: "review", version: 2, body: "spec written by the planner" };
  await qc.invalidateQueries({ queryKey: ["forge", "tickets"] });
  await waitFor(() => expect(screen.queryByLabelText("Ticket status")).not.toBeInTheDocument()); // review renders a pill
  await screen.findByText(/spec written by the planner/);
});

test("the diff is refetched once the latest run changes", async () => {
  let runs: any[] = [{ id: "runA", ticketId: "t2", status: "passed", stage: "review", startedAt: "2026-07-18T00:00:00Z", finishedAt: "2026-07-18T00:10:00Z" }];
  let diffText = "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old\n+new\n";
  apiFetch.mockImplementation(async (path: string) => {
    if (path === "/tickets") return [{ id: "t2", title: "Review Ticket", status: "review", version: 1, body: "b" }];
    if (path === "/forge/tickets/t2/sandbox") return { exists: true, branch: "forge/t2", lastVerdict: "pass" };
    if (path === "/forge/tickets/t2/diff") return { diff: diffText };
    if (path.split("?")[0] === "/forge/runs") return runs;
    if (path.includes("/output")) return { chunk: "", next: 0, stage: "review", status: runs[0].status };
    return baseMock(path) ?? {};
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(wrapWith(qc, <ForgeScreen />));
  fireEvent.click(await screen.findByText("Review Ticket"));
  fireEvent.click(await screen.findByRole("button", { name: /View diff/i }));
  const diffCalls = () => apiFetch.mock.calls.filter((c: any[]) => c[0] === "/forge/tickets/t2/diff").length;
  await waitFor(() => expect(diffCalls()).toBe(1));
  runs = [{ id: "runB", ticketId: "t2", status: "passed", stage: "review", startedAt: "2026-07-18T01:00:00Z", finishedAt: "2026-07-18T01:10:00Z" }, ...runs];
  diffText = "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old\n+new-from-run-b\n";
  await qc.invalidateQueries({ queryKey: ["forge", "runs"] });
  await waitFor(() => expect(diffCalls()).toBe(2));
  await screen.findByText(/new-from-run-b/);
});

test("a failed run shows its reason and offers Resume", async () => {
  apiFetch.mockImplementation(async (path: string) => {
    if (path === "/tickets") return [{ id: "t1", title: "My Ticket", status: "planned", version: 1, body: "b" }];
    if (path.includes("/sandbox")) return { exists: false };
    if (path.split("?")[0] === "/forge/runs") return [
      { id: "run1", ticketId: "t1", status: "failed", stage: "work", startedAt: "2026-07-18T00:00:00Z", finishedAt: "2026-07-18T00:05:00Z", failureReason: "worker failed" },
    ];
    if (path === "/forge/runs/run1/output?after=0") return { chunk: "boom", next: 4, stage: "work", status: "failed" };
    if (path === "/forge/recovery") return { interrupted: [{ ticketId: "t1", resumable: true, reason: "died during work; sandbox has uncommitted partial edits" }] };
    if (path === "/forge/tickets/t1/resume") return { runId: "run2" };
    if (path === "/forge/runs/run2/output?after=0") return { chunk: "", next: 0, stage: "work", status: "running" };
    return baseMock(path) ?? {};
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(wrapWith(qc, <ForgeScreen />));
  fireEvent.click(await screen.findByText("My Ticket"));
  await waitFor(() => expect(screen.getByTestId("run-reason")).toHaveTextContent("Failed: worker failed"));
  const resume = await screen.findByRole("button", { name: /^Resume$/i });
  expect(resume).toHaveAttribute("title", "died during work; sandbox has uncommitted partial edits");
  fireEvent.click(resume);
  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/forge/tickets/t1/resume", expect.objectContaining({ method: "POST" })));
});

test("the list marks work orders with a live run and the banner counts other tickets", async () => {
  apiFetch.mockImplementation(async (path: string) => {
    if (path === "/tickets") return [
      { id: "t1", title: "Quiet Ticket", status: "open", version: 1, body: null },
      { id: "t2", title: "Busy Ticket", status: "in_progress", version: 1, body: null, activeRun: { stage: "work" } },
    ];
    if (path.includes("/sandbox")) return { exists: false };
    if (path.split("?")[0] === "/forge/runs") return [];
    return baseMock(path) ?? {};
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(wrapWith(qc, <ForgeScreen />));
  await screen.findByText("work running");
  fireEvent.click(screen.getByText("Quiet Ticket"));
  await screen.findByText("1 run in flight");
  expect(screen.getByText("(work)")).toBeInTheDocument();
});

test("a status change just saved is not reverted by the older cached row", async () => {
  apiFetch.mockImplementation(async (path: string, init?: any) => {
    if (path === "/tickets") return [{ id: "t1", title: "My Ticket", status: "open", version: 1, body: null }];
    if (path === "/tickets/t1" && init?.method === "PATCH") return { id: "t1", title: "My Ticket", status: "in_progress", version: 2, body: null };
    if (path.includes("/sandbox")) return { exists: false };
    if (path.split("?")[0] === "/forge/runs") return [];
    return baseMock(path) ?? {};
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(wrapWith(qc, <ForgeScreen />));
  fireEvent.click(await screen.findByText("My Ticket"));
  fireEvent.change(await screen.findByLabelText("Ticket status"), { target: { value: "in_progress" } });
  await waitFor(() => expect(screen.getByLabelText("Ticket status")).toHaveValue("in_progress"));
  await qc.invalidateQueries({ queryKey: ["forge", "tickets"] });
  expect(screen.getByLabelText("Ticket status")).toHaveValue("in_progress");
});

test("a spec edit started before another change still sends the version it started from", async () => {
  let row = { id: "t1", title: "My Ticket", status: "open", version: 1, body: "first" as string | null };
  apiFetch.mockImplementation(async (path: string, init?: any) => {
    if (path === "/tickets") return [row];
    if (path === "/tickets/t1" && init?.method === "PATCH") return { ...row, body: init.body.body, version: row.version + 1 };
    if (path.includes("/sandbox")) return { exists: false };
    if (path.split("?")[0] === "/forge/runs") return [];
    return baseMock(path) ?? {};
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(wrapWith(qc, <ForgeScreen />));
  fireEvent.click(await screen.findByText("My Ticket"));
  fireEvent.click(await screen.findByText("Edit Spec"));
  row = { ...row, body: "changed elsewhere", version: 2 };
  await qc.invalidateQueries({ queryKey: ["forge", "tickets"] });
  await waitFor(() => expect(apiFetch.mock.calls.filter((c: any[]) => c[0] === "/tickets").length).toBeGreaterThanOrEqual(2));
  fireEvent.change(screen.getAllByRole("textbox").find((el) => (el as HTMLTextAreaElement).value === "first")!, { target: { value: "my draft" } });
  fireEvent.click(screen.getByText("Save"));
  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/tickets/t1", expect.objectContaining({ method: "PATCH", body: expect.objectContaining({ expectedVersion: 1, body: "my draft" }) })));
});
