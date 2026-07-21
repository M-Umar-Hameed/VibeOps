import { expect, test, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";

const ABS = "/mock/path/shot.png";
const apiPost = vi.fn(async () => ({ path: ABS, markdown: `![shot.png](${ABS})` }));
vi.mock("../lib/api.js", () => ({ api: { get: vi.fn(async () => []), post: (...a: any[]) => apiPost(...a) } }));

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

test("quick form supports image paste and attachment", async () => {
  render(wrap(<CreateScreen />));
  fireEvent.click(screen.getByText(/Quick create/i));
  await waitFor(() => screen.getByText("Proj"));
  
  const textarea = screen.getByPlaceholderText(/Describe the operational anomaly/i);
  
  const file = new File(["dummy"], "shot.png", { type: "image/png" });
  
  fireEvent.paste(textarea, {
    clipboardData: { files: [file] }
  });
  
  const img = await screen.findByRole("img");
  expect(img).toBeInTheDocument();
  
  fireEvent.click(screen.getByLabelText("Remove shot.png"));
  await waitFor(() => expect(screen.queryByRole("img")).not.toBeInTheDocument());
  
  fireEvent.paste(textarea, {
    clipboardData: { files: [file] }
  });
  await screen.findByRole("img");
  
  fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: "p1" } });
  fireEvent.change(screen.getByPlaceholderText(/Define process scope/i), { target: { value: "With Image" } });
  
  fireEvent.click(screen.getByText(/EXECUTE_SUBMIT/i));
  
  await waitFor(() => expect(createTicket).toHaveBeenCalled());
  
  const callArgs = createTicket.mock.calls[createTicket.mock.calls.length - 1][0];
  expect(callArgs.body).toContain(ABS);
  expect(callArgs.title).toBe("With Image");
});
