import { expect, test, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const post = vi.fn();
vi.mock("../../lib/api.js", () => ({
  api: { post: (...a: any[]) => post(...a) },
}));

vi.mock("../../lib/native-dialog.js", () => ({
  dialogAvailable: vi.fn(async () => false),
  pickFolder: vi.fn(),
}));

const refreshProjects = vi.fn();
vi.mock("../../context/project.js", () => ({
  useProject: () => ({ refreshProjects }),
}));

import { ImportFromFolder } from "./ImportFromFolder.js";

beforeEach(() => {
  post.mockReset();
  refreshProjects.mockReset();
});

async function openAndScan(path: string) {
  render(<ImportFromFolder />);
  fireEvent.click(screen.getByText("Import from folder..."));
  fireEvent.change(screen.getByPlaceholderText("Folder path..."), { target: { value: path } });
  fireEvent.click(screen.getByText("Scan"));
  await waitFor(() => expect(post).toHaveBeenCalledWith("/projects/scan", { path }));
}

test("selfIsGit renders single-import row, pre-checked, subfolders collapsed", async () => {
  post.mockResolvedValueOnce({
    selfIsGit: true,
    name: "monorepo",
    alreadyProject: false,
    entries: [{ name: "src", path: "/root/src", isGit: false, alreadyProject: false }],
  });

  await openAndScan("/root");

  expect(await screen.findByText("This folder is a git repository — import it as one project")).toBeInTheDocument();
  expect(screen.queryByText("src")).not.toBeInTheDocument();

  fireEvent.click(screen.getByText("Show subfolders anyway"));
  expect(screen.getByText("src")).toBeInTheDocument();

  expect(screen.getByText("Import (1)")).toBeInTheDocument();
});

test("select-all toggles every enabled git row, leaves non-git rows alone", async () => {
  post.mockResolvedValueOnce([
    { name: "repo-a", path: "/root/repo-a", isGit: true, alreadyProject: false },
    { name: "repo-b", path: "/root/repo-b", isGit: true, alreadyProject: false },
    { name: "plain", path: "/root/plain", isGit: false, alreadyProject: false },
  ]);

  await openAndScan("/root");

  await waitFor(() => expect(screen.getByText("repo-a")).toBeInTheDocument());
  expect(screen.getByText("Import (2)")).toBeInTheDocument();

  fireEvent.click(screen.getByText("Select all"));
  expect(screen.getByText("Import (0)")).toBeInTheDocument();

  fireEvent.click(screen.getByText("Select all"));
  expect(screen.getByText("Import (2)")).toBeInTheDocument();
});
