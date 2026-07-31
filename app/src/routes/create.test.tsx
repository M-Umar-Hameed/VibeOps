import { expect, test, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";

const ABS = "/mock/path/shot.png";
const apiPost = vi.fn(async (...a: any[]) =>
  a[0] === "/forge/attachments"
    ? { path: ABS, markdown: `![shot.png](${ABS})` }
    : { runId: "run123" });
vi.mock("../lib/api.js", () => ({ api: { get: vi.fn(async () => []), post: (...a: any[]) => apiPost(...a) } }));

const createTicket = vi.fn(async (..._a: any[]) => ({ id: "new1" }));
const nav = vi.fn();
vi.mock("../api/projects.js", () => ({ projects: { list: vi.fn(async () => [{ id: "p1", key: "k", name: "Proj" }]), create: vi.fn() } }));
vi.mock("../api/actors.js", () => ({ actors: { list: vi.fn(async () => []) } }));
vi.mock("../api/tickets.js", () => ({ tickets: { create: (...a: any[]) => createTicket(...a) } }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => nav }));

import { CreateScreen } from "./create.js";
const wrap = (ui: any) => <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>;

beforeEach(() => {
  apiPost.mockClear();
  createTicket.mockClear();
  nav.mockClear();
});

const openQuick = async () => {
  render(wrap(<CreateScreen />));
  fireEvent.click(screen.getByText(/Quick create/i));
  await waitFor(() => screen.getByText("Proj"));
  fireEvent.change(screen.getByLabelText("Project"), { target: { value: "p1" } });
};

test("Save as draft creates ticket, navigates to detail, never calls pipeline", async () => {
  await openQuick();
  fireEvent.change(screen.getByPlaceholderText(/Describe the work/i), { target: { value: "Hello\nDetails here" } });
  fireEvent.click(screen.getByRole("button", { name: /Save as draft/i }));
  await waitFor(() => expect(createTicket).toHaveBeenCalled());
  expect(createTicket.mock.calls[0][0]).toMatchObject({ projectId: "p1", title: "Hello", body: "Details here", priority: "normal" });
  await waitFor(() => expect(nav).toHaveBeenCalledWith({ to: "/tickets/$id", params: { id: "new1" } }));
  expect(apiPost.mock.calls.some((c: any) => c[0] === "/forge/pipeline")).toBe(false);
});

test("Run it creates ticket in selected project then launches pipeline with chosen effort", async () => {
  await openQuick();
  fireEvent.change(screen.getByLabelText("Priority"), { target: { value: "high" } });
  fireEvent.change(screen.getByPlaceholderText(/Describe the work/i), { target: { value: "Fix the header" } });
  fireEvent.click(screen.getByRole("button", { name: /^max$/i }));
  fireEvent.click(screen.getByRole("button", { name: /Run it/i }));

  await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/forge/pipeline", {
    ticketId: "new1",
    planAgent: "auto", workAgent: "auto", reviewAgent: "auto",
    extraPrompt: "", force: false, effort: "max",
  }));
  expect(createTicket.mock.calls[0][0]).toMatchObject({ projectId: "p1", title: "Fix the header", priority: "high" });

  const pipelineIdx = apiPost.mock.calls.findIndex((c: any) => c[0] === "/forge/pipeline");
  expect(createTicket.mock.invocationCallOrder[0]).toBeLessThan(apiPost.mock.invocationCallOrder[pipelineIdx]);

  await waitFor(() => expect(nav).toHaveBeenCalledWith({ to: "/tickets/$id", params: { id: "new1" } }));
});

test("quick composer supports image paste and attachment markdown lands in body", async () => {
  await openQuick();
  const textarea = screen.getByPlaceholderText(/Describe the work/i);

  const file = new File(["dummy"], "shot.png", { type: "image/png" });
  fireEvent.paste(textarea, { clipboardData: { files: [file] } });
  const img = await screen.findByRole("img");
  expect(img).toBeInTheDocument();

  fireEvent.click(screen.getByLabelText("Remove shot.png"));
  await waitFor(() => expect(screen.queryByRole("img")).not.toBeInTheDocument());

  fireEvent.paste(textarea, { clipboardData: { files: [file] } });
  await screen.findByRole("img");

  fireEvent.change(textarea, { target: { value: "With Image" } });
  fireEvent.click(screen.getByRole("button", { name: /Save as draft/i }));

  await waitFor(() => expect(createTicket).toHaveBeenCalled());
  const callArgs = createTicket.mock.calls[createTicket.mock.calls.length - 1][0];
  expect(callArgs.body).toContain(ABS);
  expect(callArgs.title).toBe("With Image");
});
