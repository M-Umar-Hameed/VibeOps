import { expect, test, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";

const apiFetch = vi.fn();
vi.mock("../api/client.js", () => ({ apiFetch: (...a: any[]) => apiFetch(...a) }));
vi.mock("../api/projects.js", () => ({ projects: { list: vi.fn(async () => [{ id: "p1", key: "k", name: "Proj" }]), create: vi.fn() } }));
vi.mock("../api/actors.js", () => ({ actors: { list: vi.fn(async () => []) } }));
vi.mock("../api/tickets.js", () => ({ tickets: { create: vi.fn() } }));
const nav = vi.fn();
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => nav }));

import { CreateScreen } from "./create.js";
const wrap = (ui: any) => <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>;

beforeEach(() => {
  localStorage.clear();
  apiFetch.mockReset();
  nav.mockReset();
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
});

test("Failed row: Resume is enabled, Retry is present, Stop is absent", async () => {
  apiFetch.mockImplementation(async (path: string) => {
    if (path === "/council") return [
      { id: "c1", status: "failed", round: 3, startedAt: "2026-01-01T00:00:00Z", promptPreview: "idea", resumable: true }
    ];
    if (path === "/forge/agents") return [];
    if (path === "/forge/skills") return [];
    return {};
  });

  render(wrap(<CreateScreen />));
  await waitFor(() => expect(screen.getByLabelText("Actions for session c1")).toBeInTheDocument());

  fireEvent.click(screen.getByLabelText("Actions for session c1"));

  const resumeBtn = screen.getByText("Resume session").closest("button");
  expect(resumeBtn).not.toBeDisabled();
  expect(screen.getByText("Retry (new session)")).toBeInTheDocument();
  expect(screen.queryByText("Stop session")).not.toBeInTheDocument();
});

test("Resume calls /council/:id/resume and loads session, does NOT call /council/evaluate", async () => {
  apiFetch.mockImplementation(async (path: string) => {
    if (path === "/council") return [
      { id: "c1", status: "failed", round: 3, startedAt: "2026-01-01T00:00:00Z", promptPreview: "idea", resumable: true }
    ];
    if (path === "/council/c1/resume") return { ok: true };
    if (path === "/council/c1") return {
      status: "decided", round: 3, believer: "b", investor: "i", skeptic: "s", questions: []
    };
    if (path === "/forge/agents") return [];
    if (path === "/forge/skills") return [];
    return {};
  });

  render(wrap(<CreateScreen />));
  await waitFor(() => expect(screen.getByLabelText("Actions for session c1")).toBeInTheDocument());

  fireEvent.click(screen.getByLabelText("Actions for session c1"));
  fireEvent.click(screen.getByText("Resume session"));

  await waitFor(() => {
    expect(apiFetch).toHaveBeenCalledWith("/council/c1/resume", expect.objectContaining({ method: "POST" }));
  });

  const evaluateCalls = apiFetch.mock.calls.filter((c: any[]) => String(c[0]).includes("/council/evaluate"));
  expect(evaluateCalls.length).toBe(0);
});

test("In-flight row: Stop is disabled with reason, Retry is disabled", async () => {
  apiFetch.mockImplementation(async (path: string) => {
    if (path === "/council") return [
      { id: "c2", status: "running", round: 1, startedAt: "2026-01-01T00:00:00Z", promptPreview: "idea 2" }
    ];
    if (path === "/forge/agents") return [];
    if (path === "/forge/skills") return [];
    return {};
  });

  render(wrap(<CreateScreen />));
  await waitFor(() => expect(screen.getByLabelText("Actions for session c2")).toBeInTheDocument());

  fireEvent.click(screen.getByLabelText("Actions for session c2"));

  const stopBtn = screen.getByText("Stop session").closest("button");
  expect(stopBtn).toBeDisabled();
  expect(screen.getByText("Council has no stop control")).toBeInTheDocument();

  const retryBtn = screen.getByText("Retry (new session)").closest("button");
  expect(retryBtn).toBeDisabled();
  expect(screen.getByText("session in flight")).toBeInTheDocument();
});

test("Not-resumable failed row: Resume is disabled with reason", async () => {
  apiFetch.mockImplementation(async (path: string) => {
    if (path === "/council") return [
      { id: "c3", status: "failed", round: 2, startedAt: "2026-01-01T00:00:00Z", promptPreview: "idea 3", resumable: false, resumeReason: "session state missing" }
    ];
    if (path === "/forge/agents") return [];
    if (path === "/forge/skills") return [];
    return {};
  });

  render(wrap(<CreateScreen />));
  await waitFor(() => expect(screen.getByLabelText("Actions for session c3")).toBeInTheDocument());

  fireEvent.click(screen.getByLabelText("Actions for session c3"));

  const resumeBtn = screen.getByText("Resume session").closest("button");
  expect(resumeBtn).toBeDisabled();
  expect(screen.getByText("session state missing")).toBeInTheDocument();
});
