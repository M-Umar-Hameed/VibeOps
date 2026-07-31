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
  localStorage.clear();
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

  expect(document.querySelector("pre")).toBeNull();
  fireEvent.click(await screen.findByText(/Show console/i));

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
  await waitFor(() => expect(screen.getByText("What is the budget?")).toBeInTheDocument(), { timeout: 6000 });
  expect(screen.getByText("Who is the audience?")).toBeInTheDocument();
  expect(document.querySelector("pre")).toBeNull();
  expect(screen.getByText(/Show console/i)).toBeInTheDocument();

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
      return { status: "decided", round: 1, rating: 8, decision: "GO", questions: [], title: "Ship it", spec: "# Spec\nDo the thing.", believer: "**Great idea", investor: "Costly but fine", skeptic: "Meh" };
    }
    if (path === "/council/c1/create-ticket") return { id: "t9" };
    return {};
  });

  render(wrap(<CreateScreen />));
  await waitFor(() => screen.getByText("Proj"));
  fireEvent.change(screen.getByPlaceholderText(/Describe the idea/i), { target: { value: "Build a thing" } });
  fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: "p1" } });
  fireEvent.click(screen.getByText(/Convene council/i));
  await waitFor(() => expect(localStorage.getItem("vibeops.activeCouncilId")).toBe("c1"));

  await act(async () => { vi.advanceTimersByTime(2000); });
  await waitFor(() => expect(screen.getByText(/Do the thing/)).toBeInTheDocument(), { timeout: 6000 });
  expect(screen.getByText("GO")).toBeInTheDocument();
  expect(screen.getByText("8/10")).toBeInTheDocument();
  expect(screen.getByText("Great idea")).toBeInTheDocument();
  expect(screen.getByText("Costly but fine")).toBeInTheDocument();
  expect(screen.getByText("Meh")).toBeInTheDocument();

  fireEvent.click(screen.getByText(/Create work order/i));

  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/council/c1/create-ticket", {
    method: "POST", body: { projectId: "p1", requiresVerification: false },
  }));
  await waitFor(() => expect(nav).toHaveBeenCalledWith({ to: "/tickets/$id", params: { id: "t9" } }));
  await waitFor(() => expect(localStorage.getItem("vibeops.activeCouncilId")).toBeNull());
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
  await waitFor(() => expect(screen.getByText(/Create anyway/i)).toBeInTheDocument(), { timeout: 6000 });

  const createBtn = screen.getByText(/Create ticket/i);
  expect(createBtn).toBeDisabled();

  fireEvent.click(screen.getByLabelText(/Create anyway/i));
  fireEvent.click(createBtn);

  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/council/c1/create-ticket", {
    method: "POST", body: { projectId: "p1", requiresVerification: false, force: true },
  }));
});

test("stored councilId reattaches on mount and resumes output polling", async () => {
  localStorage.setItem("vibeops.activeCouncilId", "c9");
  apiFetch.mockImplementation(async (path: string) => {
    if (path === "/council/c9") return { status: "running", round: 1 };
    if (path.startsWith("/council/c9/output")) return { chunk: "resumed chunk", next: 13, status: "running" };
    return {};
  });

  render(wrap(<CreateScreen />));
  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/council/c9"));
  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith(expect.stringMatching(/^\/council\/c9\/output/)));

  fireEvent.click(await screen.findByText(/Show console/i));
  await waitFor(() => expect(screen.getByText("resumed chunk")).toBeInTheDocument());
});

test("stored councilId pointing at consumed session clears the key", async () => {
  localStorage.setItem("vibeops.activeCouncilId", "c9");
  apiFetch.mockImplementation(async (path: string) => {
    if (path === "/council/c9") return { status: "consumed", round: 1 };
    return {};
  });

  render(wrap(<CreateScreen />));
  await waitFor(() => expect(localStorage.getItem("vibeops.activeCouncilId")).toBeNull());
  expect(screen.getByPlaceholderText(/Describe the idea/i)).toBeInTheDocument(); // idle form intact
});

test("persona markdown renders with no literal asterisk or hash characters", async () => {
  let statusCall = 0;
  apiFetch.mockImplementation(async (path: string) => {
    if (path === "/council/evaluate") return { councilId: "c1" };
    if (path.startsWith("/council/c1/output")) return { chunk: "", next: 0, status: "running" };
    if (path === "/council/c1") {
      statusCall++;
      if (statusCall === 1) return { status: "running", round: 1 };
      return {
        status: "decided", round: 1, rating: 8, decision: "GO", questions: [], title: "T", spec: "plain spec",
        believer: "### Upside\n**bold** claim\n- item one\n1. first point",
        investor: "fine", skeptic: "fine too",
      };
    }
    return {};
  });

  render(wrap(<CreateScreen />));
  await waitFor(() => screen.getByText("Proj"));
  fireEvent.change(screen.getByPlaceholderText(/Describe the idea/i), { target: { value: "Build a thing" } });
  fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: "p1" } });
  fireEvent.click(screen.getByText(/Convene council/i));

  await act(async () => { vi.advanceTimersByTime(2000); });
  await waitFor(() => expect(screen.getByText("Upside")).toBeInTheDocument(), { timeout: 6000 });

  expect(screen.getByText("bold").tagName).toBe("STRONG");
  expect(screen.getByText("item one").closest("ul")).not.toBeNull();
  expect(screen.getByText("first point").closest("ol")).not.toBeNull();
  expect(document.body.textContent).not.toContain("**");
  expect(document.body.textContent).not.toContain("###");
});

test("expand opens wide reading view for a card and collapse returns to grid", async () => {
  let statusCall = 0;
  apiFetch.mockImplementation(async (path: string) => {
    if (path === "/council/evaluate") return { councilId: "c1" };
    if (path.startsWith("/council/c1/output")) return { chunk: "", next: 0, status: "running" };
    if (path === "/council/c1") {
      statusCall++;
      if (statusCall === 1) return { status: "running", round: 1 };
      return {
        status: "decided", round: 1, rating: 8, decision: "GO", questions: [], title: "T", spec: "the spec text",
        believer: "believer body", investor: "investor body", skeptic: "skeptic body",
      };
    }
    return {};
  });

  render(wrap(<CreateScreen />));
  await waitFor(() => screen.getByText("Proj"));
  fireEvent.change(screen.getByPlaceholderText(/Describe the idea/i), { target: { value: "Build a thing" } });
  fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: "p1" } });
  fireEvent.click(screen.getByText(/Convene council/i));

  await act(async () => { vi.advanceTimersByTime(2000); });
  await waitFor(() => expect(screen.getByText("believer body")).toBeInTheDocument(), { timeout: 6000 });

  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(screen.getByLabelText("Expand Believer"));
  const dialog = screen.getByRole("dialog");
  expect(dialog).toHaveAttribute("aria-label", "Believer");
  expect(dialog.textContent).toContain("believer body");

  fireEvent.click(screen.getByLabelText("Collapse"));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByText("believer body")).toBeInTheDocument();

  fireEvent.click(screen.getByLabelText("Expand spec"));
  expect(screen.getByRole("dialog")).toHaveAttribute("aria-label", "Spec");
});

test("all personas populated while running shows chairman deliberating, verdict replaces it", async () => {
  let statusCall = 0;
  apiFetch.mockImplementation(async (path: string) => {
    if (path === "/council/evaluate") return { councilId: "c1" };
    if (path.startsWith("/council/c1/output")) return { chunk: "", next: 0, status: "running" };
    if (path === "/council/c1") {
      statusCall++;
      if (statusCall <= 1) return { status: "running", round: 1 };
      if (statusCall === 2) return { status: "running", round: 1, believer: "b", investor: "i", skeptic: "s" };
      return { status: "decided", round: 1, rating: 8, decision: "GO", questions: [], title: "T", spec: "spec", believer: "b", investor: "i", skeptic: "s" };
    }
    return {};
  });

  render(wrap(<CreateScreen />));
  await waitFor(() => screen.getByText("Proj"));
  fireEvent.change(screen.getByPlaceholderText(/Describe the idea/i), { target: { value: "Build a thing" } });
  fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: "p1" } });
  fireEvent.click(screen.getByText(/Convene council/i));

  await waitFor(() => expect(screen.getByText(/Council in session/i)).toBeInTheDocument());

  await act(async () => { vi.advanceTimersByTime(2000); });
  await waitFor(() => expect(screen.getByText(/Chairman deliberating/i)).toBeInTheDocument(), { timeout: 6000 });
  expect(screen.queryByText(/Council in session/i)).toBeNull();

  await act(async () => { vi.advanceTimersByTime(2000); });
  await waitFor(() => expect(screen.getByText("GO")).toBeInTheDocument(), { timeout: 6000 });
  expect(screen.queryByText(/Chairman deliberating/i)).toBeNull();
});
