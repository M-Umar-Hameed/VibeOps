import { expect, test, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";

const apiFetch = vi.fn();
vi.mock("../api/client.js", () => ({ apiFetch: (...a: any[]) => apiFetch(...a) }));

const { mockState } = vi.hoisted(() => ({ mockState: { activeProjectId: null as string | null } }));
vi.mock("../context/project.js", () => ({
  ProjectProvider: ({ children }: any) => children,
  useProject: () => ({ activeProjectId: mockState.activeProjectId, projects: [], setActiveProject: () => {}, refreshProjects: async () => {} }),
}));

const { conn } = vi.hoisted(() => ({ conn: { v: true } }));
vi.mock("../lib/events.js", () => ({
  useStreamConnected: () => conn.v,
  startEventStream: vi.fn(),
  stopEventStream: vi.fn(),
}));

import { QueryClientProvider, QueryClient } from "@tanstack/react-query";
import { ForgeScreen } from "./forge.js";
import { ProjectProvider } from "../context/project.js";

const wrap = (ui: any) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ProjectProvider>{ui}</ProjectProvider></QueryClientProvider>
);

const countCalls = (p: string) => apiFetch.mock.calls.filter((c: any[]) => String(c[0]).startsWith(p)).length;

beforeEach(() => {
  mockState.activeProjectId = null;
  conn.v = true;
  apiFetch.mockReset();
  localStorage.clear();
  apiFetch.mockImplementation(async (path: string) => {
    if (path === "/tickets") return [{ id: "t1", title: "My Ticket", status: "open" }];
    if (path === "/forge/recovery") return { interrupted: [] };
    if (path === "/forge/runs") return [];
    if (path === "/forge/agents" || path === "/forge/skills" || path === "/actors" || path === "/forge/doctor") return [];
    return {};
  });
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => { vi.useRealTimers(); });

test("connected: no interval-driven refetch of tickets or recovery", async () => {
  conn.v = true;
  render(wrap(<ForgeScreen />));
  await waitFor(() => expect(screen.getByText("My Ticket")).toBeInTheDocument());
  const t0 = countCalls("/tickets");
  const r0 = countCalls("/forge/recovery");
  await act(async () => { vi.advanceTimersByTime(15000); });
  expect(countCalls("/tickets")).toBe(t0);
  expect(countCalls("/forge/recovery")).toBe(r0);
});

test("disconnected: interval fallback refetches", async () => {
  conn.v = false;
  render(wrap(<ForgeScreen />));
  await waitFor(() => expect(screen.getByText("My Ticket")).toBeInTheDocument());
  const t0 = countCalls("/tickets");
  await act(async () => { vi.advanceTimersByTime(6000); });
  await waitFor(() => expect(countCalls("/tickets")).toBeGreaterThan(t0));
});
