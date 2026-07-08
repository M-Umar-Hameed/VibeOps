import { expect, test, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";
import { StaleVersionError } from "../api/errors.js";

const update = vi.fn();
vi.mock("../api/tickets.js", () => ({ tickets: {
  get: vi.fn(async () => ({ id: "t1", title: "T", body: "b", status: "open", priority: "normal", assigneeId: null, version: 1 })),
  update: (...a: any[]) => update(...a),
} }));
vi.mock("../api/comments.js", () => ({ comments: { list: vi.fn(async () => []), add: vi.fn() } }));
vi.mock("../api/history.js", () => ({ history: { get: vi.fn(async () => []) } }));
vi.mock("../api/actors.js", () => ({ actors: { list: vi.fn(async () => []) } }));

import { DetailScreen } from "./detail.js";
const wrap = (ui: any) => <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>;

test("Save sends expectedVersion; a 409 shows the banner and keeps the edit", async () => {
  update.mockRejectedValueOnce(new StaleVersionError("stale"));
  render(wrap(<DetailScreen id="t1" />));
  await waitFor(() => screen.getByText("T"));
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "closed" } });
  fireEvent.click(screen.getByText("Save"));
  await waitFor(() => expect(update).toHaveBeenCalledWith("t1", 1, { status: "closed" }));
  await waitFor(() => expect(screen.getByText(/changed elsewhere/)).toBeInTheDocument());
  // edit preserved:
  expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("closed");
});
