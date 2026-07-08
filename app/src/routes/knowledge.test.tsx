import { expect, test, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";

vi.mock("../api/knowledge.js", () => ({ knowledge: { search: vi.fn(async () => [{ content: "backup nightly", sourceKind: "vault", sourceRef: "sop.md", score: 1, citation: "sop.md" }]) } }));
vi.mock("../api/notes.js", () => ({ notes: { save: vi.fn(async () => ({ id: "n1" })) } }));

import { KnowledgeScreen } from "./knowledge.js";
const wrap = (ui: any) => <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>;

test("search shows results with citation", async () => {
  render(wrap(<KnowledgeScreen />));
  fireEvent.change(screen.getByPlaceholderText("search"), { target: { value: "backup" } });
  fireEvent.click(screen.getByText("Search"));
  await waitFor(() => expect(screen.getByText(/backup nightly/)).toBeInTheDocument());
  expect(screen.getByText(/sop.md/)).toBeInTheDocument();
});
