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

test("cleanup button posts to the sweep endpoint and reports the result", async () => {
  apiFetch.mockImplementation(async (path: string) => {
    if (path === "/forge/sandboxes/cleanup") return { discarded: ["t1", "t2"], reclaimedBytes: 3_145_728, orphans: [] };
    if (path === "/tickets") return [];
    if (path === "/forge/agents") return [];
    if (path === "/forge/skills") return [];
    if (path === "/forge/doctor") return [];
    if (path === "/actors") return [];
    if (path === "/forge/recovery") return { interrupted: [] };
    if (path === "/settings/forge.defaultModel.work") return { value: "" };
    return {};
  });

  render(wrap(<ForgeScreen />));
  fireEvent.click(await screen.findByLabelText("Clean up merged sandboxes"));

  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith(
    "/forge/sandboxes/cleanup",
    expect.objectContaining({ method: "POST" }),
  ));
  await screen.findByText(/Removed 2 merged sandboxes \(3\.0 MB\)/);
});

test("cleanup broom spins while the sweep is in flight", async () => {
  let resolve!: (v: any) => void;
  apiFetch.mockImplementation(async (path: string) => {
    if (path === "/forge/sandboxes/cleanup") return new Promise((r) => { resolve = r; });
    if (path === "/tickets") return [];
    if (path === "/forge/agents") return [];
    if (path === "/forge/skills") return [];
    if (path === "/forge/doctor") return [];
    if (path === "/actors") return [];
    if (path === "/forge/recovery") return { interrupted: [] };
    if (path === "/settings/forge.defaultModel.work") return { value: "" };
    return {};
  });
  render(wrap(<ForgeScreen />));
  fireEvent.click(await screen.findByLabelText("Clean up merged sandboxes"));
  await waitFor(() => expect(document.querySelector('[aria-label="Clean up merged sandboxes"] .animate-spin')).toBeInTheDocument());
  resolve({ discarded: [], reclaimedBytes: 0, orphans: [] });
});
