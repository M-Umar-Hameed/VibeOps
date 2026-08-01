import { expect, test, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";
import { StaleVersionError } from "../api/errors.js";

const notesList = vi.fn();
const notesSave = vi.fn();
const notesUpdate = vi.fn();
const notesRemove = vi.fn();
vi.mock("../api/knowledge.js", () => ({ knowledge: { search: vi.fn(async () => [{ content: "backup nightly", sourceKind: "vault", sourceRef: "sop.md", score: 1, citation: "sop.md" }]) } }));
vi.mock("../api/notes.js", () => ({ notes: {
  list: (...a: any[]) => notesList(...a),
  save: (...a: any[]) => notesSave(...a),
  update: (...a: any[]) => notesUpdate(...a),
  remove: (...a: any[]) => notesRemove(...a),
} }));
const apiFetch = vi.fn();
vi.mock("../api/client.js", () => ({ apiFetch: (...a: any[]) => apiFetch(...a) }));

let mockProjectId: string | null = null;
vi.mock("../context/project.js", () => ({
  useProject: () => ({ projects: [], activeProjectId: mockProjectId, setActiveProject: () => {}, refreshProjects: async () => {} }),
}));

import { KnowledgeScreen } from "./knowledge.js";
const wrap = (ui: any) => <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>;

const note = { id: "n1", actorId: "a1", body: "First line\nmore body", title: null, scope: "global", refId: null, indexed: true, version: 1, deletedAt: null, createdAt: "2026-01-01" };

beforeEach(() => {
  notesList.mockReset().mockResolvedValue([]);
  notesSave.mockReset().mockResolvedValue({ id: "n1" });
  notesUpdate.mockReset().mockResolvedValue({ ...note, version: 2 });
  notesRemove.mockReset().mockResolvedValue({ ok: true });
  apiFetch.mockReset().mockResolvedValue({ codex: { indexed: 1, skipped: 0, failed: 0 }, "claude-code": { indexed: 38, skipped: 2, failed: 0 } });
});

test("search shows results with citation", async () => {
  render(wrap(<KnowledgeScreen />));
  fireEvent.change(screen.getByPlaceholderText(/Search Obsidian Vault/i), { target: { value: "backup" } });
  fireEvent.click(screen.getByText("Scan"));
  await waitFor(() => expect(screen.getByText(/backup nightly/)).toBeInTheDocument());
  expect(screen.getByText(/sop.md/)).toBeInTheDocument();
});

test("notes list renders titles and snippets", async () => {
  notesList.mockResolvedValue([note, { ...note, id: "n2", title: "Titled note", body: "irrelevant" }]);
  render(wrap(<KnowledgeScreen />));
  await waitFor(() => expect(screen.getByText("First line")).toBeInTheDocument());
  expect(screen.getByText("Titled note")).toBeInTheDocument();
});

test("editing a note saves with the loaded version as expectedVersion", async () => {
  notesList.mockResolvedValue([note]);
  render(wrap(<KnowledgeScreen />));
  await waitFor(() => screen.getByText("First line"));
  fireEvent.click(screen.getByText("First line"));
  const textarea = await screen.findByDisplayValue(/First line/);
  fireEvent.change(textarea, { target: { value: "edited body" } });
  fireEvent.click(screen.getByText("Save"));
  await waitFor(() => expect(notesUpdate).toHaveBeenCalledWith("n1", 1, { title: undefined, body: "edited body" }));
});

test("a stale version conflict keeps the draft and refetches the note", async () => {
  notesList.mockResolvedValue([note]);
  notesUpdate.mockRejectedValueOnce(new StaleVersionError("stale"));
  render(wrap(<KnowledgeScreen />));
  await waitFor(() => screen.getByText("First line"));
  fireEvent.click(screen.getByText("First line"));
  const textarea = await screen.findByDisplayValue(/First line/);
  fireEvent.change(textarea, { target: { value: "edited body" } });
  fireEvent.click(screen.getByText("Save"));
  await waitFor(() => expect(screen.getByText(/changed elsewhere/)).toBeInTheDocument());
  expect((screen.getByDisplayValue("edited body") as HTMLTextAreaElement).value).toBe("edited body");
  expect(notesList).toHaveBeenCalledTimes(2); // initial load + refetch after conflict
});

test("delete asks for confirmation then removes the note", async () => {
  notesList.mockResolvedValue([note]);
  vi.spyOn(window, "confirm").mockReturnValue(true);
  render(wrap(<KnowledgeScreen />));
  await waitFor(() => screen.getByText("First line"));
  fireEvent.click(screen.getByText("First line"));
  fireEvent.click(await screen.findByText("Delete"));
  await waitFor(() => expect(notesRemove).toHaveBeenCalledWith("n1", 1));
});

test("a failing delete shows the error message inline", async () => {
  notesList.mockResolvedValue([note]);
  notesRemove.mockRejectedValueOnce(new Error("network unreachable"));
  vi.spyOn(window, "confirm").mockReturnValue(true);
  render(wrap(<KnowledgeScreen />));
  await waitFor(() => screen.getByText("First line"));
  fireEvent.click(screen.getByText("First line"));
  fireEvent.click(await screen.findByText("Delete"));
  await waitFor(() => expect(screen.getByText("network unreachable")).toBeInTheDocument());
});

test("creating a note with a title calls notes.save", async () => {
  render(wrap(<KnowledgeScreen />));
  fireEvent.change(screen.getByPlaceholderText("Title (optional)"), { target: { value: "My title" } });
  fireEvent.change(screen.getByPlaceholderText("Note body..."), { target: { value: "new body" } });
  fireEvent.click(screen.getByText("Add note"));
  await waitFor(() => expect(notesSave).toHaveBeenCalledWith({ body: "new body", scope: "global", title: "My title" }));
});

test("sessions tab renders filtered rows and opens active source on click", async () => {
  apiFetch.mockImplementation(async (url) => {
    if (url === "/knowledge/sessions") {
      return [
        { ref: "session-ref-12345", chunkCount: 3, created_at: "2026-07-18T10:00:00Z", excerpt: "excerpt 1" },
        { ref: "session-other-678", chunkCount: 1, created_at: "2026-07-18T11:00:00Z", excerpt: "excerpt 2" }
      ];
    }
    return { codex: { indexed: 1, skipped: 0, failed: 0 }, "claude-code": { indexed: 38, skipped: 2, failed: 0 } };
  });

  render(wrap(<KnowledgeScreen />));
  fireEvent.click(screen.getByText("Sessions"));
  await waitFor(() => expect(screen.getByText(/session-ref-12345/)).toBeInTheDocument());
  expect(screen.getByText(/session-other-678/)).toBeInTheDocument();
  
  fireEvent.change(screen.getByPlaceholderText("Filter by session ref..."), { target: { value: "12345" } });
  expect(screen.getByText(/session-ref-12345/)).toBeInTheDocument();
  expect(screen.queryByText(/session-other-678/)).not.toBeInTheDocument();
  
  fireEvent.click(screen.getByText(/session-ref-12345/));
  await waitFor(() => expect(screen.getByText("Fetching Node Source...")).toBeInTheDocument());
});

test("sync sessions button reports a per-source summary", async () => {
  render(wrap(<KnowledgeScreen />));
  fireEvent.click(screen.getByText("Sync sessions"));
  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/ingest/sessions", { method: "POST", body: {} }));
  await waitFor(() => expect(screen.getByText(/codex 1/)).toBeInTheDocument());
  expect(screen.getByText(/claude-code 38/)).toBeInTheDocument();
});

test("switching the active project changes the graph query key and refetches", async () => {
  apiFetch.mockImplementation(async (url: string) => {
    if (url === "/knowledge/graph") return { nodes: [], edges: [] };
    return { codex: { indexed: 1, skipped: 0, failed: 0 } };
  });
  const client = new QueryClient();
  const wrapStable = (ui: any) => <QueryClientProvider client={client}>{ui}</QueryClientProvider>;

  mockProjectId = "proj-A";
  const { rerender } = render(wrapStable(<KnowledgeScreen />));
  fireEvent.click(screen.getByText("Graph"));
  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/knowledge/graph", { query: { project: "proj-A" } }));

  mockProjectId = "proj-B";
  rerender(wrapStable(<KnowledgeScreen />));
  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/knowledge/graph", { query: { project: "proj-B" } }));
});

test("graph renders each kind with its color and shape, and the legend matches", async () => {
  apiFetch.mockImplementation(async (url: string) => {
    if (url === "/knowledge/graph") {
      return {
        nodes: [
          { id: "v1", kind: "vault" },
          { id: "n1", kind: "note" },
          { id: "s1", kind: "session" },
          { id: "r1", kind: "repo" },
        ],
        edges: [],
      };
    }
    return { codex: { indexed: 1, skipped: 0, failed: 0 } };
  });

  const { container } = render(wrap(<KnowledgeScreen />));
  fireEvent.click(screen.getByText("Graph"));
  await waitFor(() => expect(container.querySelector('g[data-kind="vault"]')).toBeTruthy());

  const expected: Record<string, { cls: string; shape: string; tag: string }> = {
    vault: { cls: "fill-primary-fixed-dim", shape: "circle", tag: "circle" },
    note: { cls: "fill-secondary-container", shape: "square", tag: "rect" },
    session: { cls: "fill-amber-400", shape: "triangle", tag: "polygon" },
    repo: { cls: "fill-emerald-400", shape: "diamond", tag: "polygon" },
  };

  for (const [kind, { cls, shape, tag }] of Object.entries(expected)) {
    const node = container.querySelector(`g[data-kind="${kind}"]`)!;
    expect(node.getAttribute("class")).toContain(cls);
    expect(node.getAttribute("data-shape")).toBe(shape);
    expect(node.querySelector(tag)).toBeTruthy();

    const legend = container.querySelector(`span[data-kind="${kind}"]`)!;
    expect(legend.getAttribute("data-shape")).toBe(shape);
    expect(legend.querySelector("svg")!.getAttribute("class")).toContain(cls);
    expect(legend.querySelector(tag)).toBeTruthy();
  }
});

