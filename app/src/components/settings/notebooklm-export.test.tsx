import { expect, test, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";

vi.mock("../../settings.js", () => ({ getSettings: vi.fn(async () => ({ baseUrl: "http://api", apiKey: "key1" })) }));
vi.mock("../../lib/native-dialog.js", () => ({ dialogAvailable: async () => false, pickFolder: async () => null }));

import { ProjectWorkspaceRow } from "./WorkspacesCard.js";

const fetchMock = vi.fn();
const writeText = vi.fn();
const openMock = vi.fn();
let clickSpy: ReturnType<typeof vi.spyOn>;

const wrap = (ui: any) => <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>;
const repoProject = { id: "p1", key: "P1", name: "Repo Project", createdAt: "2023", repoPath: "/tmp/p1", isGit: true } as any;
const noRepoProject = { id: "p2", key: "P2", name: "No Repo", createdAt: "2023", repoPath: null, isGit: false } as any;

beforeEach(() => {
  fetchMock.mockReset();
  writeText.mockReset();
  openMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("open", openMock);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  URL.createObjectURL = vi.fn(() => "blob:x");
  URL.revokeObjectURL = vi.fn();
  clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  fetchMock.mockResolvedValue({ ok: true, text: async () => "# Brief", headers: { get: () => null } });
});

afterEach(() => {
  clickSpy.mockRestore();
  vi.unstubAllGlobals();
});

test("buttons appear on a repo-bound row and are absent without a repo", () => {
  const { rerender } = render(wrap(<ProjectWorkspaceRow project={repoProject} />));
  expect(screen.getByText(/Send to NotebookLM/i)).toBeInTheDocument();
  expect(screen.getByText(/Export brief/i)).toBeInTheDocument();

  rerender(wrap(<ProjectWorkspaceRow project={noRepoProject} />));
  expect(screen.queryByText(/Send to NotebookLM/i)).toBeNull();
  expect(screen.queryByText(/Export brief/i)).toBeNull();
});

test("Send to NotebookLM copies the project brief, opens NotebookLM, shows the paste note", async () => {
  render(wrap(<ProjectWorkspaceRow project={repoProject} />));
  fireEvent.click(screen.getByText(/Send to NotebookLM/i));

  await waitFor(() => expect(writeText).toHaveBeenCalledWith("# Brief"));
  expect(fetchMock).toHaveBeenCalledWith("http://api/export/brief?kind=project&id=p1", {
    headers: { Authorization: "Bearer key1" }
  });
  await waitFor(() => expect(openMock).toHaveBeenCalledWith("https://notebooklm.google.com/", "_blank", "noopener,noreferrer"));
  expect(screen.getByRole("status").textContent).toContain("Brief copied. In NotebookLM: + Add source -> Paste text.");
  expect(clickSpy).not.toHaveBeenCalled();
});

test("clipboard rejection falls back to file download and shows the fallback note", async () => {
  writeText.mockRejectedValue(new Error("denied"));
  render(wrap(<ProjectWorkspaceRow project={repoProject} />));
  fireEvent.click(screen.getByText(/Send to NotebookLM/i));

  await waitFor(() => expect(clickSpy).toHaveBeenCalled());
  expect(screen.getByRole("status").textContent).toContain("Clipboard unavailable - brief downloaded instead");
  await waitFor(() => expect(openMock).toHaveBeenCalled());
});

test("Export brief downloads and never touches the clipboard", async () => {
  render(wrap(<ProjectWorkspaceRow project={repoProject} />));
  fireEvent.click(screen.getByText(/Export brief/i));

  await waitFor(() => expect(clickSpy).toHaveBeenCalled());
  expect(writeText).not.toHaveBeenCalled();
  expect(openMock).not.toHaveBeenCalled();
});
