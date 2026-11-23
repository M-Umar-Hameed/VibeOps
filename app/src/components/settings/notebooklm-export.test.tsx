import { expect, test, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";

vi.mock("../../settings.js", () => ({ getSettings: vi.fn(async () => ({ baseUrl: "http://api", apiKey: "key1" })) }));
vi.mock("../../lib/native-dialog.js", () => ({ dialogAvailable: async () => false, pickFolder: async () => null }));

const apiFetch = vi.fn();
vi.mock("../../api/client.js", () => ({ apiFetch: (...a: any[]) => apiFetch(...a) }));

import { StaleVersionError, ApiError } from "../../api/errors.js";
import { ProjectWorkspaceRow } from "./WorkspacesCard.js";

const three = {
  dir: "C:/briefs/p1",
  parts: 3,
  files: [{ name: "part-01.md", chars: 10 }, { name: "part-02.md", chars: 10 }, { name: "part-03.md", chars: 10 }],
};
const FILES_CALL = ["/export/brief-files", { method: "POST", body: { kind: "project", id: "p1" } }] as const;
const INDEX_FIRST = 'Export failed. Use "Index docs" first, then retry.';

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
  apiFetch.mockReset().mockImplementation(async (path: string) => (path.startsWith("/jobs") ? [] : three));
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

test("Send saves files, opens NotebookLM, names the dir and count", async () => {
  render(wrap(<ProjectWorkspaceRow project={repoProject} />));
  fireEvent.click(screen.getByText(/Send to NotebookLM/i));

  await waitFor(() => expect(openMock).toHaveBeenCalledWith("https://notebooklm.google.com/", "_blank", "noopener,noreferrer"));
  expect(apiFetch).toHaveBeenCalledWith(...FILES_CALL);
  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toContain(
      "Saved 3 files to C:/briefs/p1. In NotebookLM: + Add source -> Upload files, and select all of them."
    )
  );
  expect(writeText).not.toHaveBeenCalled();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(clickSpy).not.toHaveBeenCalled();
});

test("Export saves files without opening NotebookLM", async () => {
  render(wrap(<ProjectWorkspaceRow project={repoProject} />));
  fireEvent.click(screen.getByText(/Export brief/i));

  await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Saved 3 files to C:/briefs/p1."));
  expect(apiFetch).toHaveBeenCalledWith(...FILES_CALL);
  expect(openMock).not.toHaveBeenCalled();
  expect(writeText).not.toHaveBeenCalled();
  expect(clickSpy).not.toHaveBeenCalled();
});

test("one file uses the singular", async () => {
  apiFetch.mockImplementation(async (path: string) =>
    path.startsWith("/jobs") ? [] : { dir: "C:/briefs/p1", parts: 1, files: [{ name: "part-01.md", chars: 5 }] }
  );
  render(wrap(<ProjectWorkspaceRow project={repoProject} />));
  fireEvent.click(screen.getByText(/Export brief/i));

  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toContain(
      "Saved 1 file to C:/briefs/p1. In NotebookLM: + Add source -> Upload files, and select all of them."
    )
  );
});

test.each([[/Send to NotebookLM/i], [/Export brief/i]])("409 shows the Index docs notice (%s)", async (button) => {
  apiFetch.mockImplementation(async (path: string) => {
    if (path.startsWith("/jobs")) return [];
    throw new StaleVersionError('project has no indexed repo docs - run "Index docs" in the workspace first');
  });
  render(wrap(<ProjectWorkspaceRow project={repoProject} />));
  fireEvent.click(screen.getByText(button));

  await waitFor(() => expect(screen.getByRole("status").textContent).toContain(INDEX_FIRST));
  expect(openMock).not.toHaveBeenCalled();
});

test("other failure shows the generic notice", async () => {
  apiFetch.mockImplementation(async (path: string) => {
    if (path.startsWith("/jobs")) return [];
    throw new ApiError("boom", 500);
  });
  render(wrap(<ProjectWorkspaceRow project={repoProject} />));
  fireEvent.click(screen.getByText(/Export brief/i));

  await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Export failed: boom"));
  expect(screen.getByRole("status").textContent).not.toContain("Index docs");
});
