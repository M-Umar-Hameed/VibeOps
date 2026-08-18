import { expect, test, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

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
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ProjectProvider>{ui}</ProjectProvider></QueryClientProvider>
);

beforeEach(() => {
  mockState.activeProjectId = null;
  apiFetch.mockReset();
  localStorage.clear();
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => vi.useRealTimers());

test("review rows render the folded verdict without any per-ticket /sandbox request", async () => {
  apiFetch.mockImplementation(async (path: string) => {
    if (path === "/tickets") return [{ id: "t1", title: "Review Ticket", status: "review", sandbox: { exists: true, lastVerdict: "pass" } }];
    if (path === "/forge/agents") return [];
    if (path === "/forge/skills") return [];
    return {};
  });

  render(wrap(<ForgeScreen />));
  await waitFor(() => expect(screen.getByText("Review Ticket")).toBeInTheDocument());
  expect(screen.getByText("PASS - awaiting promote")).toBeInTheDocument();

  const sandboxCalls = apiFetch.mock.calls.filter(([p]: any[]) => /\/forge\/tickets\/.*\/sandbox/.test(p));
  expect(sandboxCalls).toEqual([]);
});
