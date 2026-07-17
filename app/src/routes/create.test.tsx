import { expect, test, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";

const createTicket = vi.fn(async (..._a: any[]) => ({ id: "new1" }));
const nav = vi.fn();
vi.mock("../api/projects.js", () => ({ projects: { list: vi.fn(async () => [{ id: "p1", key: "k", name: "Proj" }]), create: vi.fn() } }));
vi.mock("../api/actors.js", () => ({ actors: { list: vi.fn(async () => []) } }));
vi.mock("../api/tickets.js", () => ({ tickets: { create: (...a: any[]) => createTicket(...a) } }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => nav }));

import { CreateScreen } from "./create.js";
const wrap = (ui: any) => <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>;

test("creating a ticket posts and navigates to detail", async () => {
  render(wrap(<CreateScreen />));
  // Council is the default mode now; the classic form lives behind the toggle.
  fireEvent.click(screen.getByText(/Quick create/i));
  await waitFor(() => screen.getByText("Proj"));
  fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: "p1" } });
  fireEvent.change(screen.getByPlaceholderText(/Define process scope/i), { target: { value: "Hello" } });
  fireEvent.click(screen.getByText(/EXECUTE_SUBMIT/i));
  await waitFor(() => expect(createTicket).toHaveBeenCalled());
  await waitFor(() => expect(nav).toHaveBeenCalledWith({ to: "/tickets/$id", params: { id: "new1" } }));
});
