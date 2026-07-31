import { expect, test, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("../settings.js", () => ({ getSettings: vi.fn(async () => ({ baseUrl: "http://api", apiKey: "key1" })) }));

import { VerdictCard } from "./create.js";

const fetchMock = vi.fn();
const writeText = vi.fn();
const openMock = vi.fn();
let clickSpy: ReturnType<typeof vi.spyOn>;

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

test("Send to NotebookLM copies the brief, opens NotebookLM, and shows the paste note", async () => {
  render(<VerdictCard rating={8} decision={"GO" as any} councilId="c1" />);
  fireEvent.click(screen.getByText(/Send to NotebookLM/i));

  await waitFor(() => expect(writeText).toHaveBeenCalledWith("# Brief"));
  expect(fetchMock).toHaveBeenCalledWith("http://api/export/brief?kind=council&id=c1", {
    headers: { Authorization: "Bearer key1" }
  });
  await waitFor(() => expect(openMock).toHaveBeenCalledWith("https://notebooklm.google.com/", "_blank", "noopener,noreferrer"));
  expect(screen.getByRole("status").textContent).toContain("Brief copied. In NotebookLM: + Add source -> Paste text.");
  expect(clickSpy).not.toHaveBeenCalled();
});

test("clipboard rejection falls back to file download and shows the fallback note", async () => {
  writeText.mockRejectedValue(new Error("denied"));
  render(<VerdictCard rating={8} decision={"GO" as any} councilId="c1" />);
  fireEvent.click(screen.getByText(/Send to NotebookLM/i));

  await waitFor(() => expect(clickSpy).toHaveBeenCalled());
  expect(screen.getByRole("status").textContent).toContain("Clipboard unavailable - brief downloaded instead");
  await waitFor(() => expect(openMock).toHaveBeenCalled());
});

test("Export brief still downloads and never touches the clipboard", async () => {
  render(<VerdictCard rating={8} decision={"GO" as any} councilId="c1" />);
  fireEvent.click(screen.getByText(/Export brief/i));

  await waitFor(() => expect(clickSpy).toHaveBeenCalled());
  expect(writeText).not.toHaveBeenCalled();
  expect(openMock).not.toHaveBeenCalled();
});
