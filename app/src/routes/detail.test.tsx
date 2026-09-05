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
vi.mock("@tanstack/react-router", () => ({ Link: (p: any) => <a onClick={p.onClick}>{p.children}</a> }));

import { DetailScreen } from "./detail.js";
import { SELECTED_TICKET_KEY } from "./forge/types.js";
const wrap = (ui: any) => <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>;

test("Changing status auto-saves with expectedVersion; a 409 shows the banner and keeps the edit", async () => {
  update.mockRejectedValueOnce(new StaleVersionError("stale"));
  render(wrap(<DetailScreen id="t1" />));
  await waitFor(() => screen.getByText("T"));
  // Status select auto-saves on change (no separate Save button in this UI).
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "closed" } });
  await waitFor(() => expect(update).toHaveBeenCalledWith("t1", 1, { status: "closed" }));
  await waitFor(() => expect(screen.getByText(/changed elsewhere/)).toBeInTheDocument());
  // edit preserved:
  expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("closed");
});

test("Open in Forge writes SELECTED_TICKET_KEY", async () => {
  localStorage.clear();
  render(wrap(<DetailScreen id="t1" />));
  await waitFor(() => screen.getByText("T"));
  fireEvent.click(screen.getByText("Open in Forge"));
  expect(localStorage.getItem(SELECTED_TICKET_KEY)).toBe("t1");
});
