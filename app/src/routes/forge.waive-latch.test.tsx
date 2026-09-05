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

// Selecting a ticket whose run is still going latches ticketRunActive true. The
// selection guard stops that latch recomputing, so if the settling poll does not
// clear it, every post-run control stays disabled for as long as the ticket is
// selected — the operator sees a live-looking button that does nothing.
test("a run settling under the selected ticket re-enables the policy waiver", async () => {
  let polls = 0;
  apiFetch.mockImplementation(async (path: string) => {
    if (path === "/tickets") return [{ id: "t1", title: "My Ticket", status: "planned", version: 1, body: "" }];
    if (path === "/forge/agents") return [];
    if (path === "/forge/skills") return [];
    if (path === "/forge/doctor") return [];
    if (path === "/actors") return [];
    if (path === "/settings/forge.defaultModel.work") return { value: "" };
    if (path === "/forge/recovery") return { interrupted: [] };
    if (path === "/tickets/t1/comments") return [];
    if (path === "/forge/tickets/t1/sandbox") {
      return { exists: true, branch: "forge/t1", lastVerdict: "fail", protectedViolation: [".github/workflows/release-build.yml"] };
    }
    if (path.split("?")[0] === "/forge/runs") {
      return [{ id: "run_a", ticketId: "t1", status: "running", stage: "review", startedAt: "2026-01-01T00:00:00Z", agents: {} }];
    }
    if (path.startsWith("/forge/runs/run_a/output")) {
      // First poll still running (this is what latches), then the run settles.
      polls += 1;
      return polls === 1
        ? { chunk: "", next: 0, stage: "review", status: "running" }
        : { chunk: "", next: 0, stage: "review", status: "rejected" };
    }
    if (path === "/forge/tickets/t1/waive-policy") return { ok: true };
    return {};
  });

  render(wrap(<ForgeScreen />));
  await waitFor(() => expect(screen.getByText("My Ticket")).toBeInTheDocument());
  fireEvent.click(screen.getByText("My Ticket"));

  const waiver = () => screen.getByRole("button", { name: /allow for this run only/i });
  await screen.findByRole("button", { name: /allow for this run only/i });
  await waitFor(() => expect(waiver()).not.toBeDisabled(), { timeout: 15000 });

  fireEvent.click(waiver());
  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith(
    "/forge/tickets/t1/waive-policy",
    expect.objectContaining({ method: "POST" }),
  ));
});
