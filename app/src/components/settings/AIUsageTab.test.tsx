import { expect, test, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";

const apiFetch = vi.fn();
vi.mock("../../api/client.js", () => ({ apiFetch: (...a: any[]) => apiFetch(...a) }));
// Link renders outside a RouterProvider in these tests
vi.mock("@tanstack/react-router", () => ({ Link: (p: any) => <a href={p.to}>{p.children}</a> }));

import { AIUsageTab } from "./AIUsageTab.js";
const wrap = (ui: any) => (
  <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>
);

beforeEach(() => {
  apiFetch.mockReset().mockImplementation((path: string) => {
    if (path === "/system/agents") {
      return Promise.resolve({
        sinceDays: 7,
        agents: [
          {
            agent: "claude",
            connected: true,
            account: "dev@example.com",
            plan: "pro",
            authMode: "oauth",
            tokens: { inputTokens: 1_000_000, outputTokens: 300_000, totalTokens: 1_300_000, sessions: 12 },
          },
          {
            agent: "antigravity",
            connected: true,
            account: null,
            authMode: "oauth",
            note: "account not exposed locally",
            tokens: null,
          },
          {
            agent: "codex",
            connected: false,
            account: null,
            authMode: "unknown",
            tokens: null,
          },
        ],
      });
    }
    if (path === "/system/ai-usage") {
      return Promise.resolve({ overview: { totalTokens: 0, totalCost: 0 }, usage: [], agents: [] });
    }
    return Promise.resolve({});
  });
});

test("renders real accounts and observed tokens from /system/agents", async () => {
  render(wrap(<AIUsageTab />));

  await waitFor(() => expect(screen.getByText("dev@example.com")).toBeInTheDocument());
  // "1.3M" renders both in the Overview total and the per-agent row.
  expect(screen.getAllByText("1.3M").length).toBe(2);
  expect(screen.getByText("account not exposed locally")).toBeInTheDocument();
  expect(screen.getByText("Not connected")).toBeInTheDocument();
  expect(
    screen.getByText(/Usage observed by VibeOps from local session logs/),
  ).toBeInTheDocument();
});

test("antigravity shows an em dash when it exposes no token counts", async () => {
  render(wrap(<AIUsageTab />));
  await waitFor(() => expect(screen.getByText("dev@example.com")).toBeInTheDocument());
  expect(screen.getAllByText("—").length).toBeGreaterThan(0);
});

test("shows an honest empty state instead of mock usage numbers", async () => {
  render(wrap(<AIUsageTab />));
  await waitFor(() => expect(screen.getByText(/Usage tracks tokens and costs/)).toBeInTheDocument());
  expect(screen.queryByText(/Claude 3.5 Sonnet/)).not.toBeInTheDocument();
  expect(screen.queryByText(/Provider Token Quotas/)).not.toBeInTheDocument();
});

test("Overview shows the real sum of observed agent tokens, not a fake total", async () => {
  render(wrap(<AIUsageTab />));
  await waitFor(() => expect(screen.getByText("Tokens observed (7d)")).toBeInTheDocument());
  // 1,300,000 (claude) + 0 (antigravity/codex have no tokens) = 1.3M
  // "1.3M" also appears in the per-agent Coding Agents row, so scope to the overview card.
  expect(screen.getByText("Tokens observed (7d)").nextSibling?.textContent).toBe("1.3M");
  expect(screen.queryByText("2.87M")).not.toBeInTheDocument();
  expect(screen.queryByText(/vs last week/)).not.toBeInTheDocument();
  expect(screen.queryByText("$14.23")).not.toBeInTheDocument();
  expect(screen.queryByText(/Cost-Optimized/)).not.toBeInTheDocument();
});

test("shows an honest empty state for agent sessions instead of mock 42/Top Agent Engines", async () => {
  render(wrap(<AIUsageTab />));
  await waitFor(() =>
    expect(
      screen.getByText(/No agent sessions recorded yet/),
    ).toBeInTheDocument(),
  );
  expect(screen.queryByText("42")).not.toBeInTheDocument();
  expect(screen.queryByText(/Top Agent Engines/)).not.toBeInTheDocument();
  expect(screen.queryByText(/Antigravity \(Gemini\)/)).not.toBeInTheDocument();
});

test("Overview sums tokens across multiple agents", async () => {
  apiFetch.mockReset().mockImplementation((path: string) => {
    if (path === "/system/agents") {
      return Promise.resolve({
        sinceDays: 7,
        agents: [
          {
            agent: "claude",
            connected: true,
            account: "a@example.com",
            authMode: "oauth",
            tokens: { inputTokens: 500_000, outputTokens: 100_000, totalTokens: 600_000, sessions: 5 },
          },
          {
            agent: "codex",
            connected: true,
            account: "b@example.com",
            authMode: "oauth",
            tokens: { inputTokens: 300_000, outputTokens: 100_000, totalTokens: 400_000, sessions: 3 },
          },
        ],
      });
    }
    if (path === "/system/ai-usage") {
      return Promise.resolve({ overview: {}, usage: [], agents: [] });
    }
    return Promise.resolve({});
  });

  render(wrap(<AIUsageTab />));
  // 600,000 + 400,000 = 1,000,000 -> "1.0M"
  await waitFor(() => expect(screen.getByText("1.0M")).toBeInTheDocument());
});

test("renders By Ticket list when perTicket data is present", async () => {
  apiFetch.mockReset().mockImplementation((path: string) => {
    if (path === "/system/ai-usage") {
      return Promise.resolve({
        overview: {}, usage: [], agents: [],
        perTicket: [
          { ticketId: "t-1", title: "Implement Auth", tokens: 12000, calls: 5 },
          { ticketId: "t-2", title: "Fix Dashboard", tokens: 5000, calls: 2 },
        ]
      });
    }
    return Promise.resolve({ agents: [] });
  });

  render(wrap(<AIUsageTab />));
  await waitFor(() => expect(screen.getByText("By Work Order")).toBeInTheDocument());
  expect(screen.getByText("Implement Auth")).toBeInTheDocument();
  expect(screen.getByText("12.0K tokens")).toBeInTheDocument();
  expect(screen.getByText("5 calls")).toBeInTheDocument();
  expect(screen.getByText("Fix Dashboard")).toBeInTheDocument();
  expect(screen.getByText("5.0K tokens")).toBeInTheDocument();
  expect(screen.getByText("2 calls")).toBeInTheDocument();
});
