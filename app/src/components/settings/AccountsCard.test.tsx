import { expect, test, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";

const apiFetch = vi.fn();
vi.mock("../../api/client.js", () => ({ apiFetch: (...a: any[]) => apiFetch(...a) }));

import { AccountsCard } from "./AccountsCard.js";
const wrap = (ui: any) => <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>;

const future = new Date(Date.now() + 3_600_000).toISOString();
const data = (runsActive: boolean) => ({
  runsActive,
  lanes: [{
    agent: "claude", kind: "claude", canCheckLogin: true, copiesClaudeSettings: true,
    accounts: [
      { id: "main", label: "Main", configDir: "C:/a", priority: 1, state: { loginOk: true, limitHits: 1, exhaustedUntil: future }, runs: 3, lastRunAt: "2026-10-24T10:00:00.000Z", login: { command: '$env:CLAUDE_CONFIG_DIR="C:/a"; claude', then: "type /login" } },
      { id: "spare", label: "Spare", configDir: "C:/b", priority: 2, state: {}, runs: 0, lastRunAt: null, login: { command: '$env:CLAUDE_CONFIG_DIR="C:/b"; claude', then: "type /login" } },
    ],
    recent: [{ runId: "r1", role: "work", account: "main", startedAt: "2026-10-24T10:00:00.000Z" }],
  }],
});

function mockApi(runsActive = false) {
  apiFetch.mockReset().mockImplementation((path: string, opts?: any) => {
    if (path === "/relay/accounts" && !opts) return Promise.resolve(data(runsActive));
    if (path === "/relay/agents/claude/accounts" && opts?.method === "POST") {
      return Promise.resolve({ account: { id: "acct-1" }, copied: ["CLAUDE.md"], login: { command: '$env:CLAUDE_CONFIG_DIR="C:/new"; claude', then: "type /login" } });
    }
    if (path.endsWith("/check")) return Promise.resolve({ ok: true });
    return Promise.resolve({});
  });
}
beforeEach(() => mockApi());

test("lists accounts with priority, folder, login and limit status", async () => {
  render(wrap(<AccountsCard />));
  await waitFor(() => screen.getByText("Main"));
  expect(screen.getByText("Primary")).toBeInTheDocument();
  expect(screen.getByText("Backup 1")).toBeInTheDocument();
  expect(screen.getByText("C:/b")).toBeInTheDocument();
  expect(screen.getByText("logged_in")).toBeInTheDocument();
  expect(screen.getByText("unchecked")).toBeInTheDocument();
  expect(screen.getByText(/Exhausted until/)).toBeInTheDocument();
  expect(screen.getByText(/Last runs: work on Main/)).toBeInTheDocument();
  expect(screen.getByText('$env:CLAUDE_CONFIG_DIR="C:/b"; claude')).toBeInTheDocument();
});

test("moving a backup up PUTs the new order", async () => {
  render(wrap(<AccountsCard />));
  await waitFor(() => screen.getByLabelText("Move Spare up"));
  fireEvent.click(screen.getByLabelText("Move Spare up"));
  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/relay/agents/claude/accounts/order", { method: "PUT", body: { ids: ["spare", "main"] } }));
});

test("adding an account POSTs the label and shows the login step", async () => {
  render(wrap(<AccountsCard />));
  await waitFor(() => screen.getByLabelText("New account label for claude"));
  fireEvent.change(screen.getByLabelText("New account label for claude"), { target: { value: "Work" } });
  fireEvent.click(screen.getByRole("button", { name: "Add account" }));
  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/relay/agents/claude/accounts", { method: "POST", body: { label: "Work", copySettings: true } }));
  await waitFor(() => expect(screen.getByText('$env:CLAUDE_CONFIG_DIR="C:/new"; claude')).toBeInTheDocument());
  expect(screen.getByText("Copied CLAUDE.md")).toBeInTheDocument();
});

test("while runs are active, changes are disabled with the reason", async () => {
  mockApi(true);
  render(wrap(<AccountsCard />));
  await waitFor(() => screen.getByText("Wait until runs finish to change accounts."));
  fireEvent.change(screen.getByLabelText("New account label for claude"), { target: { value: "Work" } });
  const add = screen.getByRole("button", { name: "Add account" });
  expect(add).toBeDisabled();
  expect(add).toHaveAttribute("title", "Wait until runs finish");
  expect(screen.getByLabelText("Move Spare up")).toBeDisabled();
  expect(screen.getByLabelText("Remove Main")).toBeDisabled();
});

test("check login POSTs the probe and shows the result", async () => {
  render(wrap(<AccountsCard />));
  await waitFor(() => screen.getAllByRole("button", { name: /Check login/ }));
  fireEvent.click(screen.getAllByRole("button", { name: /Check login/ })[0]);
  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/relay/agents/claude/accounts/main/check", { method: "POST", body: undefined }));
  await waitFor(() => expect(screen.getByText("Login check: ok")).toBeInTheDocument());
});

test("disable PATCHes the account", async () => {
  render(wrap(<AccountsCard />));
  await waitFor(() => screen.getAllByRole("button", { name: "Disable" }));
  fireEvent.click(screen.getAllByRole("button", { name: "Disable" })[0]);
  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/relay/agents/claude/accounts/main", { method: "PATCH", body: { disabled: true } }));
});

test("remove asks first and deletes the folder only when ticked", async () => {
  render(wrap(<AccountsCard />));
  await waitFor(() => screen.getByLabelText("Remove Main"));
  fireEvent.click(screen.getByLabelText("Remove Main"));
  fireEvent.click(screen.getByLabelText("Confirm remove Main"));
  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/relay/agents/claude/accounts/main", { method: "DELETE", body: { deleteFolder: false } }));
  fireEvent.click(screen.getByLabelText("Remove Spare"));
  fireEvent.click(screen.getByLabelText("Also delete the folder of Spare"));
  fireEvent.click(screen.getByLabelText("Confirm remove Spare"));
  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/relay/agents/claude/accounts/spare", { method: "DELETE", body: { deleteFolder: true } }));
});
