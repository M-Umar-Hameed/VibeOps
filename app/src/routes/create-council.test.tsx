import { expect, test, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";

const apiFetch = vi.fn();
vi.mock("../api/client.js", () => ({ apiFetch: (...a: any[]) => apiFetch(...a) }));
vi.mock("../api/projects.js", () => ({ projects: { list: vi.fn(async () => [{ id: "p1", key: "k", name: "Proj" }]), create: vi.fn() } }));
vi.mock("../api/actors.js", () => ({ actors: { list: vi.fn(async () => []) } }));
vi.mock("../api/tickets.js", () => ({ tickets: { create: vi.fn() } }));
const nav = vi.fn();
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => nav }));

import { CreateScreen } from "./create.js";
const wrap = (ui: any) => <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>;

beforeEach(() => {
  apiFetch.mockReset();
  nav.mockReset();
  // shouldAdvanceTime: waitFor polls on real timers; frozen clocks deadlock it.
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
});

test("evaluate posts the prompt and console renders polled chunks", async () => {
  let pollCount = 0;
  apiFetch.mockImplementation(async (path: string) => {
    if (path === "/council/evaluate") return { councilId: "c1" };
    if (path.startsWith("/council/c1/output")) {
      pollCount++;
      if (pollCount === 1) return { chunk: "believer thinking...", next: 10, status: "running" };
      if (pollCount === 2) return { chunk: "investor analyzing...", next: 20, status: "running" };
      return { chunk: "", next: 20, status: "running" };
    }
    if (path === "/council/c1") return { status: "running", round: 1 };
    return {};
  });

  render(wrap(<CreateScreen />));
  await waitFor(() => screen.getByText("Proj"));

  fireEvent.change(screen.getByPlaceholderText(/Describe the idea/i), { target: { value: "Build a thing" } });
  fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: "p1" } });
  fireEvent.click(screen.getByText(/Convene council/i));

  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/council/evaluate", {
    method: "POST", body: { prompt: "Build a thing", projectId: "p1" },
  }));

  await waitFor(() => expect(screen.getByText("believer thinking...")).toBeInTheDocument());

  await act(async () => { vi.advanceTimersByTime(1000); });

  await waitFor(() => {
    const pre = document.querySelector("pre");
    expect(pre?.textContent).toBe("believer thinking...investor analyzing...");
  });
});

test("awaiting-answers renders the questions and Submit posts { answers } in order", async () => {
  let statusCall = 0;
  apiFetch.mockImplementation(async (path: string) => {
    if (path === "/council/evaluate") return { councilId: "c1" };
    if (path.startsWith("/council/c1/output")) return { chunk: "", next: 0, status: "running" };
    if (path === "/council/c1") {
      statusCall++;
      if (statusCall === 1) return { status: "running", round: 1 };
      return { status: "awaiting-answers", round: 1, questions: ["What is the budget?", "Who is the audience?"] };
    }
    if (path === "/council/c1/answers") return { ok: true };
    return {};
  });

  render(wrap(<CreateScreen />));
  await waitFor(() => screen.getByText("Proj"));
  fireEvent.change(screen.getByPlaceholderText(/Describe the idea/i), { target: { value: "Build a thing" } });
  fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: "p1" } });
  fireEvent.click(screen.getByText(/Convene council/i));

  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/council/evaluate", expect.anything()));

  await act(async () => { vi.advanceTimersByTime(2000); });
  await waitFor(() => expect(screen.getByText("What is the budget?")).toBeInTheDocument());
  expect(screen.getByText("Who is the audience?")).toBeInTheDocument();

  const inputs = screen.getAllByRole("textbox");
  fireEvent.change(inputs[0], { target: { value: "10k" } });
  fireEvent.change(inputs[1], { target: { value: "Developers" } });
  fireEvent.click(screen.getByText(/Submit answers/i));

  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/council/c1/answers", {
    method: "POST", body: { answers: ["10k", "Developers"] },
  }));
});

test("decided GO renders spec and Create ticket posts { projectId } then navigates", async () => {
  let statusCall = 0;
  apiFetch.mockImplementation(async (path: string) => {
    if (path === "/council/evaluate") return { councilId: "c1" };
    if (path.startsWith("/council/c1/output")) return { chunk: "", next: 0, status: "running" };
    if (path === "/council/c1") {
      statusCall++;
      if (statusCall === 1) return { status: "running", round: 1 };
      return { status: "decided", round: 1, rating: 8, decision: "GO", questions: [], title: "Ship it", spec: "# Spec\nDo the thing." };
    }
    if (path === "/council/c1/create-ticket") return { id: "t9" };
    return {};
  });

  render(wrap(<CreateScreen />));
  await waitFor(() => screen.getByText("Proj"));
  fireEvent.change(screen.getByPlaceholderText(/Describe the idea/i), { target: { value: "Build a thing" } });
  fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: "p1" } });
  fireEvent.click(screen.getByText(/Convene council/i));

  await act(async () => { vi.advanceTimersByTime(2000); });
  await waitFor(() => expect(screen.getByText("# Spec\nDo the thing.")).toBeInTheDocument());
  expect(screen.getByText("8/10")).toBeInTheDocument();

  fireEvent.click(screen.getByText(/Create ticket/i));

  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/council/c1/create-ticket", {
    method: "POST", body: { projectId: "p1" },
  }));
  await waitFor(() => expect(nav).toHaveBeenCalledWith({ to: "/tickets/$id", params: { id: "t9" } }));
});

test("NEEDS-INFO shows the Create-anyway checkbox and posts force: true when checked", async () => {
  let statusCall = 0;
  apiFetch.mockImplementation(async (path: string) => {
    if (path === "/council/evaluate") return { councilId: "c1" };
    if (path.startsWith("/council/c1/output")) return { chunk: "", next: 0, status: "running" };
    if (path === "/council/c1") {
      statusCall++;
      if (statusCall === 1) return { status: "running", round: 1 };
      return { status: "decided", round: 1, rating: 4, decision: "NEEDS-INFO", questions: [], title: "Maybe", spec: "# Spec\nUnclear." };
    }
    if (path === "/council/c1/create-ticket") return { id: "t9" };
    return {};
  });

  render(wrap(<CreateScreen />));
  await waitFor(() => screen.getByText("Proj"));
  fireEvent.change(screen.getByPlaceholderText(/Describe the idea/i), { target: { value: "Build a thing" } });
  fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: "p1" } });
  fireEvent.click(screen.getByText(/Convene council/i));

  await act(async () => { vi.advanceTimersByTime(2000); });
  await waitFor(() => expect(screen.getByText(/Create anyway/i)).toBeInTheDocument());

  const createBtn = screen.getByText(/Create ticket/i);
  expect(createBtn).toBeDisabled();

  fireEvent.click(screen.getByLabelText(/Create anyway/i));
  fireEvent.click(createBtn);

  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/council/c1/create-ticket", {
    method: "POST", body: { projectId: "p1", force: true },
  }));
});
