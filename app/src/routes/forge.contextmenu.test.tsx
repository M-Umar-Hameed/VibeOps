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

beforeEach(() => {
  mockState.activeProjectId = null;
  apiFetch.mockReset();
  localStorage.clear();
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
});

test("Running run: Stop is enabled, Retry is disabled, Stop calls stop endpoint and not discard", async () => {
  apiFetch.mockImplementation(async (path: string) => {
    if (path === "/tickets") return [{ id: "t1", title: "My Ticket", status: "in_progress", version: 1, body: "" }];
    if (path === "/forge/agents") return [];
    if (path === "/forge/skills") return [];
    if (path === "/forge/doctor") return [];
    if (path === "/actors") return [];
    if (path === "/settings/forge.defaultModel.work") return { value: "" };
    if (path === "/forge/tickets/t1/sandbox") return { exists: true };
    if (path === "/forge/recovery") return { interrupted: [] };
    if (path === "/tickets/t1/comments") return [];
    if (path.split("?")[0] === "/forge/runs") return [
      { id: "run_a", ticketId: "t1", status: "running", stage: "work", startedAt: "2026-01-01T00:00:00Z", agents: {} }
    ];
    if (path.startsWith("/forge/runs/run_a/output")) return { chunk: "output", next: 6, stage: "work", status: "running" };
    if (path === "/forge/runs/run_a/stop") return { ok: true };
    return {};
  });

  render(wrap(<ForgeScreen />));
  await waitFor(() => expect(screen.getByText("My Ticket")).toBeInTheDocument());
  fireEvent.click(screen.getByText("My Ticket"));

  await waitFor(() => expect(screen.getByLabelText("Actions for run run_a")).toBeInTheDocument());

  // Open menu
  fireEvent.click(screen.getByLabelText("Actions for run run_a"));

  // Check Stop is present, Retry is disabled, and Resume is absent
  expect(screen.getByText("Stop run")).toBeInTheDocument();
  expect(screen.queryByText("Resume run")).not.toBeInTheDocument();
  const retryBtn = screen.getByText("Retry from plan").closest("button");
  expect(retryBtn).toBeDisabled();

  // Click Stop -> confirm view
  fireEvent.click(screen.getByText("Stop run"));
  expect(screen.getByText("Stop this run?")).toBeInTheDocument();

  // Confirm Stop
  const confirmStopBtn = screen.getAllByRole("button", { name: "Stop run" })[0];
  fireEvent.click(confirmStopBtn);

  await waitFor(() => {
    expect(apiFetch).toHaveBeenCalledWith("/forge/runs/run_a/stop", expect.objectContaining({ method: "POST" }));
  });

  const discardCalls = apiFetch.mock.calls.filter((c: any[]) => String(c[0]).includes("/discard"));
  expect(discardCalls.length).toBe(0);
});

test("Settled + resumable run: Resume is enabled and calls resume endpoint, no discard", async () => {
  apiFetch.mockImplementation(async (path: string) => {
    if (path === "/tickets") return [{ id: "t1", title: "My Ticket", status: "open", version: 1, body: "" }];
    if (path === "/forge/agents") return [];
    if (path === "/forge/skills") return [];
    if (path === "/forge/doctor") return [];
    if (path === "/actors") return [];
    if (path === "/settings/forge.defaultModel.work") return { value: "" };
    if (path === "/forge/tickets/t1/sandbox") return { exists: true };
    if (path === "/tickets/t1/comments") return [];
    if (path === "/forge/recovery") return {
      interrupted: [{ ticketId: "t1", resumable: true, reason: "" }]
    };
    if (path.split("?")[0] === "/forge/runs") return [
      { id: "run_b", ticketId: "t1", status: "failed", stage: "work", startedAt: "2026-01-01T00:00:00Z", agents: {} }
    ];
    if (path.startsWith("/forge/runs/run_b/output")) return { chunk: "failed log", next: 10, stage: "work", status: "failed" };
    if (path === "/forge/tickets/t1/resume") return { runId: "run_b_resumed" };
    return {};
  });

  render(wrap(<ForgeScreen />));
  await waitFor(() => expect(screen.getByText("My Ticket")).toBeInTheDocument());
  fireEvent.click(screen.getByText("My Ticket"));

  await waitFor(() => expect(screen.getByLabelText("Actions for run run_b")).toBeInTheDocument());
  fireEvent.click(screen.getByLabelText("Actions for run run_b"));

  // Check Stop is absent, Resume is enabled
  expect(screen.queryByText("Stop run")).not.toBeInTheDocument();
  const resumeBtn = screen.getByText("Resume run").closest("button");
  expect(resumeBtn).not.toBeDisabled();

  fireEvent.click(screen.getByText("Resume run"));

  await waitFor(() => {
    expect(apiFetch).toHaveBeenCalledWith("/forge/tickets/t1/resume", expect.objectContaining({ method: "POST" }));
  });

  const discardCalls = apiFetch.mock.calls.filter((c: any[]) => String(c[0]).includes("/discard"));
  expect(discardCalls.length).toBe(0);
});

test("Settled + not resumable run: Resume is disabled with reason", async () => {
  apiFetch.mockImplementation(async (path: string) => {
    if (path === "/tickets") return [{ id: "t1", title: "My Ticket", status: "open", version: 1, body: "" }];
    if (path === "/forge/agents") return [];
    if (path === "/forge/skills") return [];
    if (path === "/forge/doctor") return [];
    if (path === "/actors") return [];
    if (path === "/settings/forge.defaultModel.work") return { value: "" };
    if (path === "/forge/tickets/t1/sandbox") return { exists: false };
    if (path === "/tickets/t1/comments") return [];
    if (path === "/forge/recovery") return {
      interrupted: [{ ticketId: "t1", resumable: false, reason: "no sandbox for this run" }]
    };
    if (path.split("?")[0] === "/forge/runs") return [
      { id: "run_c", ticketId: "t1", status: "failed", stage: "work", startedAt: "2026-01-01T00:00:00Z", agents: {} }
    ];
    if (path.startsWith("/forge/runs/run_c/output")) return { chunk: "failed log", next: 10, stage: "work", status: "failed" };
    return {};
  });

  render(wrap(<ForgeScreen />));
  await waitFor(() => expect(screen.getByText("My Ticket")).toBeInTheDocument());
  fireEvent.click(screen.getByText("My Ticket"));

  await waitFor(() => expect(screen.getByLabelText("Actions for run run_c")).toBeInTheDocument());
  fireEvent.click(screen.getByLabelText("Actions for run run_c"));

  const resumeBtn = screen.getByText("Resume run").closest("button");
  expect(resumeBtn).toBeDisabled();
  expect(screen.getByText("no sandbox for this run")).toBeInTheDocument();
});

test("Retry from settled run: opens confirm and posts fresh pipeline, no discard", async () => {
  apiFetch.mockImplementation(async (path: string) => {
    if (path === "/tickets") return [{ id: "t1", title: "My Ticket", status: "open", version: 1, body: "" }];
    if (path === "/forge/agents") return [];
    if (path === "/forge/skills") return [];
    if (path === "/forge/doctor") return [];
    if (path === "/actors") return [];
    if (path === "/settings/forge.defaultModel.work") return { value: "" };
    if (path === "/forge/tickets/t1/sandbox") return { exists: false };
    if (path === "/tickets/t1/comments") return [];
    if (path === "/forge/recovery") return { interrupted: [] };
    if (path.split("?")[0] === "/forge/runs") return [
      { id: "run_d", ticketId: "t1", status: "stopped", stage: "work", startedAt: "2026-01-01T00:00:00Z", agents: {} }
    ];
    if (path.startsWith("/forge/runs/run_d/output")) return { chunk: "stopped log", next: 10, stage: "work", status: "stopped" };
    if (path === "/forge/pipeline") return { runId: "run_d_fresh" };
    return {};
  });

  render(wrap(<ForgeScreen />));
  await waitFor(() => expect(screen.getByText("My Ticket")).toBeInTheDocument());
  fireEvent.click(screen.getByText("My Ticket"));

  await waitFor(() => expect(screen.getByLabelText("Actions for run run_d")).toBeInTheDocument());
  fireEvent.click(screen.getByLabelText("Actions for run run_d"));

  expect(screen.queryByText("Stop run")).not.toBeInTheDocument();
  const retryBtn = screen.getByText("Retry from plan").closest("button");
  expect(retryBtn).not.toBeDisabled();

  fireEvent.click(screen.getByText("Retry from plan"));
  expect(screen.getByText("Retry from the beginning?")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Retry run" }));

  await waitFor(() => {
    expect(apiFetch).toHaveBeenCalledWith("/forge/pipeline", {
      method: "POST",
      body: {
        ticketId: "t1",
        planAgent: "auto",
        workAgent: "auto",
        reviewAgent: "auto",
        force: false,
      },
    });
  });

  const discardCalls = apiFetch.mock.calls.filter((c: any[]) => String(c[0]).includes("/discard"));
  expect(discardCalls.length).toBe(0);
});
