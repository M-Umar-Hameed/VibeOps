import { expect, test, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";

const apiFetch = vi.fn();
vi.mock("../api/client.js", () => ({ apiFetch: (...a: any[]) => apiFetch(...a) }));

import { ForgeScreen } from "./forge.js";

beforeEach(() => {
  apiFetch.mockReset();
  // shouldAdvanceTime: waitFor polls on real timers; frozen clocks deadlock it.
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
});

test("renders agent dropdowns from /forge/agents data", async () => {
  apiFetch.mockImplementation(async (path) => {
    if (path === "/tickets") return [{ id: "t1", title: "My Ticket", status: "open" }];
    if (path === "/forge/agents") return [
      { name: "PlanGPT", roles: ["plan"] },
      { name: "WorkGPT", roles: ["work"] },
      { name: "ReviewGPT", roles: ["review"] },
      { name: "MultiGPT", roles: ["plan", "work", "review"], models: [{name:"big"}] }
    ];
    if (path === "/forge/skills") return [];
    return {};
  });

  render(<ForgeScreen />);
  await waitFor(() => expect(screen.getByText("My Ticket")).toBeInTheDocument());
  
  fireEvent.click(screen.getByText("My Ticket"));
  
  await waitFor(() => expect(screen.getByText("Pipeline Settings")).toBeInTheDocument());
  
  const planOpts = screen.getAllByRole("option").filter((o: any) => o.parentElement?.previousElementSibling?.textContent === "Plan Model").map((o: any) => o.value);
  expect(planOpts).toContain("auto::");
  expect(planOpts).toContain("PlanGPT::");
  expect(planOpts).toContain("MultiGPT::big");
  expect(planOpts).not.toContain("WorkGPT::");
  expect(screen.getAllByRole("combobox")[0]).toHaveValue("auto::");
});

test("Run pipeline posts the selected agents and ticketId", async () => {
  apiFetch.mockImplementation(async (path) => {
    if (path === "/tickets") return [{ id: "t1", title: "My Ticket", status: "open" }];
    if (path === "/forge/agents") return [
      { name: "PlanGPT", roles: ["plan"] },
      { name: "WorkGPT", roles: ["work"] },
      { name: "ReviewGPT", roles: ["review"] },
      { name: "MultiGPT", roles: ["plan", "work", "review"], models: [{name:"big"}] }
    ];
    if (path === "/forge/skills") return [];
    if (path.includes("/sandbox")) return { exists: false };
    if (path === "/forge/pipeline") return { runId: "run123" };
    return {};
  });

  render(<ForgeScreen />);
  await waitFor(() => expect(screen.getByText("My Ticket")).toBeInTheDocument());
  fireEvent.click(screen.getByText("My Ticket"));
  
  await waitFor(() => expect(screen.getByRole("button", { name: /Run pipeline/i })).not.toBeDisabled());
  
  // Change Plan Model selection
  const planSelect = screen.getAllByRole("combobox")[0]; // Plan Model select
  fireEvent.change(planSelect, { target: { value: "MultiGPT::big" } });
  
  fireEvent.click(screen.getByRole("button", { name: /Run pipeline/i }));
  
  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/forge/pipeline", {
    method: "POST",
    body: {
      ticketId: "t1",
      planAgent: "MultiGPT",
      planModel: "big",
      workAgent: "auto",
      reviewAgent: "auto",
      extraPrompt: ""
    }
  }));
});

test("Run pipeline posts untouched defaults without model keys", async () => {
  apiFetch.mockImplementation(async (path) => {
    if (path === "/tickets") return [{ id: "t1", title: "My Ticket", status: "open" }];
    if (path === "/forge/agents") return [
      { name: "MultiGPT", roles: ["plan", "work", "review"], models: [{name:"big"}] }
    ];
    if (path === "/forge/skills") return [];
    if (path.includes("/sandbox")) return { exists: false };
    if (path === "/forge/pipeline") return { runId: "run123" };
    return {};
  });

  render(<ForgeScreen />);
  await waitFor(() => expect(screen.getByText("My Ticket")).toBeInTheDocument());
  fireEvent.click(screen.getByText("My Ticket"));
  
  await waitFor(() => expect(screen.getByRole("button", { name: /Run pipeline/i })).not.toBeDisabled());
  fireEvent.click(screen.getByRole("button", { name: /Run pipeline/i }));
  
  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/forge/pipeline", {
    method: "POST",
    body: { ticketId: "t1", planAgent: "auto", workAgent: "auto", reviewAgent: "auto", extraPrompt: "" }
  }));
});

test("Promote button disabled when lastVerdict is not pass and enabled when it is", async () => {
  apiFetch.mockImplementation(async (path) => {
    if (path === "/tickets") return [{ id: "t2", title: "Review Ticket", status: "review" }];
    if (path === "/forge/agents") return [];
    if (path === "/forge/skills") return [];
    if (path === "/forge/tickets/t2/sandbox") return { exists: true, branch: "forge/t2", lastVerdict: "fail" };
    return {};
  });

  const { unmount } = render(<ForgeScreen />);
  await waitFor(() => expect(screen.getByText("Review Ticket")).toBeInTheDocument());
  fireEvent.click(screen.getByText("Review Ticket"));
  
  await waitFor(() => expect(screen.getByText(/Branch:/)).toBeInTheDocument());
  let promoteBtn = screen.getByRole("button", { name: /Promote/i });
  expect(promoteBtn).toBeDisabled();

  unmount();

  // now with pass
  apiFetch.mockImplementation(async (path) => {
    if (path === "/tickets") return [{ id: "t2", title: "Review Ticket", status: "review" }];
    if (path === "/forge/agents") return [];
    if (path === "/forge/skills") return [];
    if (path === "/forge/tickets/t2/sandbox") return { exists: true, branch: "forge/t2", lastVerdict: "pass" };
    return {};
  });

  render(<ForgeScreen />);
  await waitFor(() => expect(screen.getByText("Review Ticket")).toBeInTheDocument());
  fireEvent.click(screen.getByText("Review Ticket"));
  
  await waitFor(() => expect(screen.getByText(/Branch:/)).toBeInTheDocument());
  promoteBtn = screen.getByRole("button", { name: /Promote/i });
  expect(promoteBtn).not.toBeDisabled();
});

test("console appends polled chunks (mock two successive output responses, use fake timers)", async () => {
  let pollCount = 0;
  apiFetch.mockImplementation(async (path) => {
    if (path === "/tickets") return [{ id: "t1", title: "My Ticket", status: "open" }];
    if (path === "/forge/agents") return [
      { name: "PlanGPT", roles: ["plan"] },
      { name: "WorkGPT", roles: ["work"] },
      { name: "ReviewGPT", roles: ["review"] }
    ];
    if (path === "/forge/skills") return [];
    if (path.includes("/sandbox")) return { exists: false };
    if (path === "/forge/pipeline") return { runId: "run123" };
    if (path.includes("/output")) {
      pollCount++;
      if (pollCount === 1) return { chunk: "starting...", next: 10, stage: "plan", status: "running" };
      if (pollCount === 2) return { chunk: "done!", next: 15, stage: "review", status: "passed" };
      return { chunk: "", next: 15, stage: "review", status: "passed" };
    }
    return {};
  });

  render(<ForgeScreen />);
  await waitFor(() => expect(screen.getByText("My Ticket")).toBeInTheDocument());
  fireEvent.click(screen.getByText("My Ticket"));
  
  await waitFor(() => expect(screen.getByRole("button", { name: /Run pipeline/i })).not.toBeDisabled());
  fireEvent.click(screen.getByRole("button", { name: /Run pipeline/i }));
  
  await waitFor(() => expect(screen.getByText("starting...")).toBeInTheDocument());
  
  await act(async () => {
    vi.advanceTimersByTime(1000);
  });
  
  await waitFor(() => {
    const pre = document.querySelector("pre");
    expect(pre?.textContent).toBe("starting...done!");
  });
  
  const callCountAfterSettle = pollCount;
  
  await act(async () => {
    vi.advanceTimersByTime(2000);
  });
  
  expect(pollCount).toBe(callCountAfterSettle);
});
