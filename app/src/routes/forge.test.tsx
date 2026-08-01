import { expect, test, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";

const apiFetch = vi.fn();
vi.mock("../api/client.js", () => ({ apiFetch: (...a: any[]) => apiFetch(...a) }));

const { mockState } = vi.hoisted(() => ({ mockState: { activeProjectId: null as string | null } }));
vi.mock("../context/project.js", () => ({
  ProjectProvider: ({ children }: any) => children,
  useProject: () => ({ activeProjectId: mockState.activeProjectId, projects: [], setActiveProject: () => {}, refreshProjects: async () => {} }),
}));

import { QueryClientProvider, QueryClient, focusManager } from "@tanstack/react-query";
import { ForgeScreen } from "./forge.js";
import { NotFoundError, StaleVersionError } from "../api/errors.js";
import { ProjectProvider } from "../context/project.js";

// SpecEditor uses react-query; every render needs a client.
const wrap = (ui: any) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ProjectProvider>{ui}</ProjectProvider></QueryClientProvider>
);

beforeEach(() => {
  mockState.activeProjectId = null;
  apiFetch.mockReset();
  localStorage.clear();
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

  render(wrap(<ForgeScreen />));
  await waitFor(() => expect(screen.getByText("My Ticket")).toBeInTheDocument());
  
  fireEvent.click(screen.getByText("My Ticket"));
  
  await waitFor(() => expect(screen.getByText("Pipeline Settings")).toBeInTheDocument());
  
  const planOpts = screen.getAllByRole("option").filter((o: any) => o.parentElement?.previousElementSibling?.textContent === "Plan Model").map((o: any) => o.value);
  expect(planOpts).toContain("auto::");
  expect(planOpts).toContain("PlanGPT::");
  expect(planOpts).toContain("MultiGPT::big");
  expect(planOpts).not.toContain("WorkGPT::");
  const planModelSelect = screen.getAllByRole("combobox").find((o: any) => o.previousElementSibling?.textContent === "Plan Model")!;
  expect(planModelSelect).toHaveValue("auto::");
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

  render(wrap(<ForgeScreen />));
  await waitFor(() => expect(screen.getByText("My Ticket")).toBeInTheDocument());
  fireEvent.click(screen.getByText("My Ticket"));
  
  await waitFor(() => expect(screen.getByRole("button", { name: /Run pipeline/i })).not.toBeDisabled());
  
  // Change Plan Model selection
  const planSelect = screen.getAllByRole("combobox").find((o: any) => o.previousElementSibling?.textContent === "Plan Model")!;
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
      extraPrompt: "",
      force: false
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

  render(wrap(<ForgeScreen />));
  await waitFor(() => expect(screen.getByText("My Ticket")).toBeInTheDocument());
  fireEvent.click(screen.getByText("My Ticket"));
  
  await waitFor(() => expect(screen.getByRole("button", { name: /Run pipeline/i })).not.toBeDisabled());
  fireEvent.click(screen.getByRole("button", { name: /Run pipeline/i }));
  
  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/forge/pipeline", {
    method: "POST",
    body: { ticketId: "t1", planAgent: "auto", workAgent: "auto", reviewAgent: "auto", extraPrompt: "", force: false }
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

  const { unmount } = render(wrap(<ForgeScreen />));
  await waitFor(() => expect(screen.getByText("Review Ticket")).toBeInTheDocument());
  fireEvent.click(screen.getByText("Review Ticket"));
  
  await waitFor(() => expect(screen.getByText(/Branch:/)).toBeInTheDocument());
  let promoteBtn = screen.getByRole("button", { name: /Promote/i });
  expect(promoteBtn).toBeDisabled();

  unmount();
  localStorage.clear();

  // now with pass
  apiFetch.mockImplementation(async (path) => {
    if (path === "/tickets") return [{ id: "t2", title: "Review Ticket", status: "review" }];
    if (path === "/forge/agents") return [];
    if (path === "/forge/skills") return [];
    if (path === "/forge/tickets/t2/sandbox") return { exists: true, branch: "forge/t2", lastVerdict: "pass" };
    return {};
  });

  render(wrap(<ForgeScreen />));
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

  render(wrap(<ForgeScreen />));
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

test("reattaches to a running run on ticket select: resumes polling and renders buffered console", async () => {
  apiFetch.mockImplementation(async (path) => {
    if (path === "/tickets") return [{ id: "t1", title: "My Ticket", status: "in_progress" }];
    if (path === "/forge/agents") return [];
    if (path === "/forge/skills") return [];
    if (path.includes("/sandbox")) return { exists: false };
    if (path === "/forge/runs") return [
      { id: "run123", ticketId: "t1", status: "running", stage: "work", startedAt: "2026-07-18T00:00:00Z" },
    ];
    if (path === "/forge/runs/run123/output?after=0") {
      return { chunk: "resumed buffered output", next: 25, stage: "work", status: "running" };
    }
    if (path.includes("/output")) return { chunk: "", next: 25, stage: "work", status: "running" };
    return {};
  });

  render(wrap(<ForgeScreen />));
  await waitFor(() => expect(screen.getByText("My Ticket")).toBeInTheDocument());
  fireEvent.click(screen.getByText("My Ticket"));

  await waitFor(() => expect(screen.getByText("resumed buffered output")).toBeInTheDocument());
  expect(screen.getByRole("button", { name: /Run pipeline/i })).toBeDisabled();
  expect(screen.getByRole("button", { name: /Stop/i })).toBeInTheDocument();
});

test("shows final console + verdict state for a recently settled run instead of the pristine form", async () => {
  apiFetch.mockImplementation(async (path) => {
    if (path === "/tickets") return [{ id: "t1", title: "My Ticket", status: "review" }];
    if (path === "/forge/agents") return [];
    if (path === "/forge/skills") return [];
    if (path === "/forge/tickets/t1/sandbox") return { exists: true, branch: "forge/t1", lastVerdict: "pass" };
    if (path === "/forge/runs") return [
      { id: "run456", ticketId: "t1", status: "passed", stage: "review", startedAt: "2026-07-18T00:00:00Z" },
    ];
    if (path === "/forge/runs/run456/output?after=0") {
      return { chunk: "final review output", next: 40, stage: "review", status: "passed" };
    }
    return {};
  });

  render(wrap(<ForgeScreen />));
  await waitFor(() => expect(screen.getByText("My Ticket")).toBeInTheDocument());
  fireEvent.click(screen.getByText("My Ticket"));

  await waitFor(() => expect(screen.getByText("final review output")).toBeInTheDocument());
  expect(screen.getAllByText("review").length).toBeGreaterThan(0); // runStage badge
  expect(screen.getAllByText("passed").length).toBeGreaterThan(0); // runStatus badge
  expect(screen.queryByRole("button", { name: /Stop/i })).not.toBeInTheDocument();
});

test("shows an unavailable note when the settled run's output buffer 404s after a restart", async () => {
  apiFetch.mockImplementation(async (path) => {
    if (path === "/tickets") return [{ id: "t1", title: "My Ticket", status: "review" }];
    if (path === "/forge/agents") return [];
    if (path === "/forge/skills") return [];
    if (path === "/forge/tickets/t1/sandbox") return { exists: true, branch: "forge/t1", lastVerdict: "fail" };
    if (path === "/forge/runs") return [
      { id: "run789", ticketId: "t1", status: "failed", stage: "review", startedAt: "2026-07-18T00:00:00Z" },
    ];
    if (path === "/forge/runs/run789/output?after=0") throw new NotFoundError("run not found");
    return {};
  });

  render(wrap(<ForgeScreen />));
  await waitFor(() => expect(screen.getByText("My Ticket")).toBeInTheDocument());
  fireEvent.click(screen.getByText("My Ticket"));

  await waitFor(() => expect(screen.getByText(/view previous run output unavailable after restart/i)).toBeInTheDocument());
});

test("no runs for ticket -> pristine start state, no console, buttons enabled", async () => {
  apiFetch.mockImplementation(async (path) => {
    if (path === "/tickets") return [{ id: "t1", title: "My Ticket", status: "open" }];
    if (path === "/forge/agents") return [
      { name: "PlanGPT", roles: ["plan"] },
      { name: "WorkGPT", roles: ["work"] },
      { name: "ReviewGPT", roles: ["review"] },
    ];
    if (path === "/forge/skills") return [];
    if (path.includes("/sandbox")) return { exists: false };
    if (path === "/forge/runs") return [];
    return {};
  });

  render(wrap(<ForgeScreen />));
  await waitFor(() => expect(screen.getByText("My Ticket")).toBeInTheDocument());
  fireEvent.click(screen.getByText("My Ticket"));

  await waitFor(() => expect(screen.getByRole("button", { name: /Run pipeline/i })).not.toBeDisabled());
  expect(screen.queryByText(/Live Console/i)).not.toBeInTheDocument();
});

test("renders a red health dot for an agent whose doctor probe failed", async () => {
  apiFetch.mockImplementation(async (path) => {
    if (path === "/tickets") return [{ id: "t1", title: "My Ticket", status: "open" }];
    if (path === "/forge/agents") return [
      { name: "PlanGPT", roles: ["plan"] },
      { name: "WorkGPT", roles: ["work"] },
      { name: "ReviewGPT", roles: ["review"] },
    ];
    if (path === "/forge/skills") return [];
    if (path === "/forge/doctor") return [
      { name: "PlanGPT", binary: "plangpt", probe: { ok: false, error: "boom" }, auth: { known: false, connected: null }, lastChecked: "2026-07-18T00:00:00.000Z" },
    ];
    return {};
  });

  render(wrap(<ForgeScreen />));
  await waitFor(() => expect(screen.getByText("My Ticket")).toBeInTheDocument());
  fireEvent.click(screen.getByText("My Ticket"));
  await waitFor(() => expect(screen.getByText("Pipeline Settings")).toBeInTheDocument());

  const dot = await screen.findByTestId("doctor-dot-PlanGPT");
  expect(dot.className).toContain("bg-red-500");
});

test("shows empty-state when diff 404s", async () => {
  apiFetch.mockImplementation(async (path) => {
    if (path === "/tickets") return [{ id: "t1", title: "My Ticket", status: "review" }];
    if (path === "/forge/agents") return [];
    if (path === "/forge/skills") return [];
    if (path.includes("/sandbox")) return { exists: true, branch: "forge/t1", lastVerdict: "none" };
    if (path.includes("/diff")) throw new NotFoundError("no sandbox");
    return {};
  });

  render(wrap(<ForgeScreen />));
  await waitFor(() => expect(screen.getByText("My Ticket")).toBeInTheDocument());
  fireEvent.click(screen.getByText("My Ticket"));
  
  await waitFor(() => expect(screen.getByText(/Branch:/)).toBeInTheDocument());
  
  const viewDiffBtn = screen.getByRole("button", { name: /View diff/i });
  fireEvent.click(viewDiffBtn);
  
  await waitFor(() => expect(screen.getByText("No sandbox / no changes yet")).toBeInTheDocument());
});

test("sandbox activity panel appears only while running, and hides on 404", async () => {
  let activityCalls = 0;
  apiFetch.mockImplementation(async (path) => {
    if (path === "/tickets") return [{ id: "t1", title: "My Ticket", status: "open" }];
    if (path === "/forge/agents") return [
      { name: "PlanGPT", roles: ["plan"] },
      { name: "WorkGPT", roles: ["work"] },
      { name: "ReviewGPT", roles: ["review"] },
    ];
    if (path === "/forge/skills") return [];
    if (path === "/forge/tickets/t1/sandbox") return { exists: false };
    if (path === "/forge/pipeline") return { runId: "run123" };
    if (path === "/forge/tickets/t1/sandbox/activity") {
      activityCalls++;
      if (activityCalls === 1) throw new NotFoundError("no sandbox for ticket");
      return {
        stage: "work",
        files: [{ path: "src/a.ts", status: "M", additions: 3, deletions: 1 }],
        totalAdditions: 3, totalDeletions: 1, lastChangeAt: "2026-07-18T00:00:00.000Z",
      };
    }
    if (path.includes("/output")) return { chunk: "", next: 0, stage: "plan", status: "running" };
    return {};
  });

  render(wrap(<ForgeScreen />));
  await waitFor(() => expect(screen.getByText("My Ticket")).toBeInTheDocument());
  fireEvent.click(screen.getByText("My Ticket"));
  expect(screen.queryByText("Sandbox activity")).not.toBeInTheDocument();

  await waitFor(() => expect(screen.getByRole("button", { name: /Run pipeline/i })).not.toBeDisabled());
  fireEvent.click(screen.getByRole("button", { name: /Run pipeline/i }));

  await waitFor(() => expect(activityCalls).toBe(1));
  expect(screen.queryByText("Sandbox activity")).not.toBeInTheDocument(); // 404 -> hidden

  await act(async () => { vi.advanceTimersByTime(1000); });

  await waitFor(() => expect(screen.getByText("Sandbox activity")).toBeInTheDocument());
  expect(screen.getByText(/a\.ts/)).toBeInTheDocument();
});

test("spec renders body, edit saves with expectedVersion", async () => {
  apiFetch.mockImplementation(async (path, opts) => {
    if (path === "/tickets") return [{ id: "t1", title: "My Ticket", status: "open", body: "Original body", version: 1 }];
    if (path === "/forge/agents") return [];
    if (path === "/forge/skills") return [];
    if (path.includes("/sandbox")) return { exists: false };
    if (path.includes("/comments")) return [];
    if (path === "/tickets/t1" && opts?.method === "PATCH") return { id: "t1", title: "My Ticket", status: "open", body: "New body", version: 2 };
    return {};
  });

  render(wrap(<ForgeScreen />));
  await waitFor(() => expect(screen.getByText("My Ticket")).toBeInTheDocument());
  fireEvent.click(screen.getByText("My Ticket"));

  await waitFor(() => expect(screen.getByText("Original body")).toBeInTheDocument());
  
  fireEvent.click(screen.getByText(/Edit Spec/i));
  const textarea = screen.getByDisplayValue("Original body");
  fireEvent.change(textarea, { target: { value: "New body" } });
  
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  
  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/tickets/t1", expect.objectContaining({
    method: "PATCH",
    body: { expectedVersion: 1, body: "New body" }
  })));
});

test("request-changes posts comment + bounces review->planned", async () => {
  apiFetch.mockImplementation(async (path, opts) => {
    if (path === "/tickets") return [{ id: "t1", title: "My Ticket", status: "review", version: 1 }];
    if (path === "/forge/agents") return [];
    if (path === "/forge/skills") return [];
    if (path.includes("/sandbox")) return { exists: false };
    if (path.includes("/comments") && opts?.method === "POST") return {};
    if (path.includes("/comments")) return [];
    if (path === "/tickets/t1" && opts?.method === "PATCH") return { id: "t1", title: "My Ticket", status: "planned", version: 2 };
    return {};
  });

  render(wrap(<ForgeScreen />));
  await waitFor(() => expect(screen.getByText("My Ticket")).toBeInTheDocument());
  fireEvent.click(screen.getByText("My Ticket"));

  await waitFor(() => expect(screen.getByPlaceholderText(/prefix with CHANGE REQUEST/i)).toBeInTheDocument());
  
  const input = screen.getByPlaceholderText(/prefix with CHANGE REQUEST/i);
  fireEvent.change(input, { target: { value: "Please fix this" } });
  
  const reqBtn = screen.getByRole("button", { name: /Request changes/i });
  expect(reqBtn).not.toBeDisabled();
  fireEvent.click(reqBtn);
  
  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/tickets/t1/comments", expect.objectContaining({
    method: "POST",
    body: { body: "CHANGE REQUEST:\nPlease fix this" }
  })));
  
  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/tickets/t1", expect.objectContaining({
    method: "PATCH",
    body: { expectedVersion: 1, status: "planned" }
  })));
});

test("status select renders for the selected ticket with current value", async () => {
  apiFetch.mockImplementation(async (path) => {
    if (path === "/tickets") return [{ id: "t1", title: "My Ticket", status: "open", version: 3 }];
    if (path === "/forge/agents") return [];
    if (path === "/forge/skills") return [];
    if (path.includes("/sandbox")) return { exists: false };
    return {};
  });

  render(wrap(<ForgeScreen />));
  await waitFor(() => expect(screen.getByText("My Ticket")).toBeInTheDocument());
  fireEvent.click(screen.getByText("My Ticket"));

  const statusSelect = await screen.findByLabelText("Ticket status");
  expect(statusSelect).toHaveValue("open");
  expect(statusSelect).not.toBeDisabled();
});

test("status PATCH carries expectedVersion and refreshes ticket list", async () => {
  apiFetch.mockImplementation(async (path, opts: any) => {
    if (path === "/tickets") return [{ id: "t1", title: "My Ticket", status: "open", version: 3 }];
    if (path === "/forge/agents") return [];
    if (path === "/forge/skills") return [];
    if (path.includes("/sandbox")) return { exists: false };
    if (path === "/tickets/t1" && opts?.method === "PATCH") return { id: "t1", title: "My Ticket", status: "closed", version: 4 };
    return {};
  });

  render(wrap(<ForgeScreen />));
  await waitFor(() => expect(screen.getByText("My Ticket")).toBeInTheDocument());
  fireEvent.click(screen.getByText("My Ticket"));

  const statusSelect = await screen.findByLabelText("Ticket status");
  fireEvent.change(statusSelect, { target: { value: "closed" } });

  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/tickets/t1", {
    method: "PATCH",
    body: { expectedVersion: 3, status: "closed" },
  }));
  // loadTickets() refetch after PATCH — this is the 2nd "/tickets" call (1st on mount).
  await waitFor(() => expect(apiFetch.mock.calls.filter((c: any) => c[0] === "/tickets").length).toBeGreaterThanOrEqual(2));
});

test("status select disabled while a run is active for the ticket", async () => {
  apiFetch.mockImplementation(async (path) => {
    if (path === "/tickets") return [{ id: "t1", title: "My Ticket", status: "open", version: 3 }];
    if (path === "/forge/agents") return [];
    if (path === "/forge/skills") return [];
    if (path.includes("/sandbox")) return { exists: false };
    if (path === "/forge/runs") return [{ id: "run123", ticketId: "t1", status: "running", startedAt: "2026-01-01T00:00:00Z" }];
    return {};
  });

  render(wrap(<ForgeScreen />));
  await waitFor(() => expect(screen.getByText("My Ticket")).toBeInTheDocument());
  fireEvent.click(screen.getByText("My Ticket"));

  const statusSelect = await screen.findByLabelText("Ticket status");
  await waitFor(() => expect(statusSelect).toBeDisabled());
  expect(statusSelect).toHaveAttribute("title", "Pipeline run in progress for this ticket");
});

test("paste image attaches a thumbnail and Create task posts body with the absolute-path markdown", async () => {
  const abs = "C:/Users/Admin/.vibeops/attachments/abc.png";
  const posted: any[] = [];
  apiFetch.mockImplementation(async (path: string, init?: any) => {
    if (path === "/tickets" && init?.method === "POST") { posted.push(init.body); return { id: "t9", title: "Fix the header", status: "open" }; }
    if (path.startsWith("/tickets")) return [];
    if (path === "/projects") return [{ id: "p1", key: "inbox" }];
    if (path === "/forge/agents") return [];
    if (path === "/forge/skills") return [];
    if (path === "/actors") return [];
    if (path === "/forge/attachments") return { path: abs, markdown: `![shot.png](${abs})` };
    return {};
  });

  mockState.activeProjectId = "p1";
  render(wrap(<ForgeScreen />));
  const textarea = await screen.findByPlaceholderText(/Describe the work/i);
  fireEvent.change(textarea, { target: { value: "Fix the header" } });

  const file = new File([Uint8Array.from([0x89, 0x50, 0x4e, 0x47])], "shot.png", { type: "image/png" });
  fireEvent.paste(textarea, { clipboardData: { files: [file], getData: () => "" } });

  await waitFor(() => expect(screen.getByRole("img")).toBeInTheDocument());

  fireEvent.click(screen.getByRole("button", { name: /Save as draft/i }));
  await waitFor(() => expect(posted.length).toBe(1));
  expect(posted[0].body).toContain(abs);
});

const composerMocks = (pipelineImpl?: (init: any) => any) => {
  mockState.activeProjectId = "p1";
  apiFetch.mockImplementation(async (path: string, init?: any) => {
    if (path === "/tickets" && init?.method === "POST") return { id: "t9", title: "Fix the header", status: "open" };
    if (path.startsWith("/tickets")) return [];
    if (path === "/projects") return [{ id: "p1", key: "inbox" }];
    if (path === "/forge/agents") return [];
    if (path === "/forge/skills") return [];
    if (path === "/actors") return [];
    if (path === "/forge/runs") return [];
    if (path.includes("/sandbox")) return { exists: false };
    if (path.includes("/comments")) return [];
    if (path === "/forge/pipeline") return pipelineImpl ? pipelineImpl(init) : { runId: "run123", doctorWarnings: [] };
    return {};
  });
};

test("composer Run it: tickets POST then pipeline POST with default effort standard", async () => {
  composerMocks();
  render(wrap(<ForgeScreen />));
  const textarea = await screen.findByPlaceholderText(/Describe the work/i);
  fireEvent.change(textarea, { target: { value: "Fix the header" } });
  fireEvent.click(screen.getByRole("button", { name: /Run it/i }));

  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/forge/pipeline", {
    method: "POST",
    body: {
      ticketId: "t9",
      planAgent: "auto", workAgent: "auto", reviewAgent: "auto",
      extraPrompt: "", force: false, effort: "standard",
    },
  }));
  expect(apiFetch).toHaveBeenCalledWith("/tickets", expect.objectContaining({
    method: "POST",
    body: expect.objectContaining({ projectId: "p1" }),
  }));
  const postIdx = (p: string) => apiFetch.mock.calls.findIndex((c: any) => c[0] === p && c[1]?.method === "POST");
  expect(postIdx("/tickets")).toBeGreaterThanOrEqual(0);
  expect(postIdx("/forge/pipeline")).toBeGreaterThan(postIdx("/tickets"));
});

test("effort pill changes pipeline payload", async () => {
  composerMocks();
  render(wrap(<ForgeScreen />));
  const textarea = await screen.findByPlaceholderText(/Describe the work/i);
  fireEvent.change(textarea, { target: { value: "Big refactor" } });
  fireEvent.click(screen.getByRole("button", { name: /^max$/i }));
  fireEvent.click(screen.getByRole("button", { name: /Run it/i }));

  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/forge/pipeline", expect.objectContaining({
    method: "POST",
    body: expect.objectContaining({ effort: "max" }),
  })));
});

test("Save as draft creates ticket, never calls pipeline", async () => {
  composerMocks();
  render(wrap(<ForgeScreen />));
  const textarea = await screen.findByPlaceholderText(/Describe the work/i);
  fireEvent.change(textarea, { target: { value: "Just a draft" } });
  fireEvent.click(screen.getByRole("button", { name: /Save as draft/i }));

  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/tickets", expect.objectContaining({ method: "POST" })));
  expect(apiFetch.mock.calls.some((c: any) => c[0] === "/forge/pipeline")).toBe(false);
});

test("doctor warnings from pipeline start surface as a dismissible note", async () => {
  composerMocks(() => ({ runId: "run123", doctorWarnings: ["agy: auth expired"] }));
  render(wrap(<ForgeScreen />));
  const textarea = await screen.findByPlaceholderText(/Describe the work/i);
  fireEvent.change(textarea, { target: { value: "Fix the header" } });
  fireEvent.click(screen.getByRole("button", { name: /Run it/i }));

  await waitFor(() => expect(screen.getByText(/agy: auth expired/)).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: /Dismiss warnings/i }));
  expect(screen.queryByText(/agy: auth expired/)).not.toBeInTheDocument();
});

test("pipeline 409 shows inline error text; ticket still created", async () => {
  composerMocks(() => { throw new StaleVersionError("per-ticket token cap exceeded: 999 > 100"); });
  render(wrap(<ForgeScreen />));
  const textarea = await screen.findByPlaceholderText(/Describe the work/i);
  fireEvent.change(textarea, { target: { value: "Fix the header" } });
  fireEvent.click(screen.getByRole("button", { name: /Run it/i }));

  await waitFor(() => expect(screen.getByText(/per-ticket token cap exceeded/)).toBeInTheDocument());
  expect(apiFetch).toHaveBeenCalledWith("/tickets", expect.objectContaining({ method: "POST" }));
});

test("Run History row shows effort badge when the run record has one", async () => {
  apiFetch.mockImplementation(async (path: string) => {
    if (path === "/tickets") return [{ id: "t1", title: "My Ticket", status: "review" }];
    if (path === "/forge/agents") return [];
    if (path === "/forge/skills") return [];
    if (path.includes("/sandbox")) return { exists: false };
    if (path.includes("/comments")) return [];
    if (path === "/forge/runs") return [
      { id: "run456", ticketId: "t1", status: "passed", stage: "review", startedAt: "2026-07-18T00:00:00Z", effort: "max" },
    ];
    if (path.includes("/output")) return { chunk: "", next: 0, stage: "review", status: "passed" };
    return {};
  });
  render(wrap(<ForgeScreen />));
  await waitFor(() => expect(screen.getByText("My Ticket")).toBeInTheDocument());
  fireEvent.click(screen.getByText("My Ticket"));
  await waitFor(() => expect(screen.getByText("Run History")).toBeInTheDocument());
  expect(screen.getByTestId("run-effort-run456")).toHaveTextContent("max");
});

test("tickets refetch every 5s, on window focus, and stop after unmount", async () => {
  apiFetch.mockImplementation(async (path) => {
    if (path === "/tickets") return [{ id: "t1", title: "My Ticket", status: "open" }];
    if (path === "/forge/agents") return [];
    if (path === "/forge/skills") return [];
    return {};
  });

  const { unmount } = render(wrap(<ForgeScreen />));
  await waitFor(() => expect(screen.getByText("My Ticket")).toBeInTheDocument());
  const calls = () => apiFetch.mock.calls.filter((c: any) => c[0] === "/tickets").length;
  const base = calls();

  await act(async () => { vi.advanceTimersByTime(5000); });
  await waitFor(() => expect(calls()).toBeGreaterThanOrEqual(base + 1));

  const beforeFocus = calls();
  await act(async () => { focusManager.setFocused(false); focusManager.setFocused(true); });
  await waitFor(() => expect(calls()).toBeGreaterThanOrEqual(beforeFocus + 1));
  focusManager.setFocused(undefined);

  unmount();
  const afterUnmount = calls();
  await act(async () => { vi.advanceTimersByTime(15000); });
  expect(calls()).toBe(afterUnmount);
});

test("no active project blocks composer submit and shows a hint", async () => {
  composerMocks();
  mockState.activeProjectId = null;
  render(wrap(<ForgeScreen />));
  const textarea = await screen.findByPlaceholderText(/Describe the work/i);
  fireEvent.change(textarea, { target: { value: "Fix the header" } });
  expect(screen.getByText(/Select a project to create a work order/i)).toBeInTheDocument();
  const runBtn = screen.getByRole("button", { name: /Run it/i });
  expect(runBtn).toBeDisabled();
  fireEvent.click(runBtn);
  expect(apiFetch.mock.calls.some((c: any) => c[0] === "/tickets" && c[1]?.method === "POST")).toBe(false);
});


test("stage change during a run triggers exactly one tickets refetch; same stage does not", async () => {
  let pollCount = 0;
  apiFetch.mockImplementation(async (path) => {
    if (path === "/tickets") return [{ id: "t1", title: "My Ticket", status: "in_progress" }];
    if (path === "/forge/agents") return [
      { name: "PlanGPT", roles: ["plan"] },
      { name: "WorkGPT", roles: ["work"] },
      { name: "ReviewGPT", roles: ["review"] },
    ];
    if (path === "/forge/skills") return [];
    if (path === "/forge/runs") return [];
    if (path.includes("/sandbox")) return { exists: false };
    if (path === "/forge/pipeline") return { runId: "run123" };
    if (path.includes("/output")) {
      pollCount++;
      if (pollCount <= 2) return { chunk: "", next: 0, stage: "plan", status: "running" };
      return { chunk: "", next: 0, stage: "work", status: "running" };
    }
    return {};
  });

  render(wrap(<ForgeScreen />));
  await waitFor(() => expect(screen.getByText("My Ticket")).toBeInTheDocument());
  fireEvent.click(screen.getByText("My Ticket"));
  await waitFor(() => expect(screen.getByRole("button", { name: /Run pipeline/i })).not.toBeDisabled());
  fireEvent.click(screen.getByRole("button", { name: /Run pipeline/i }));
  await waitFor(() => expect(pollCount).toBeGreaterThanOrEqual(1));

  const tCalls = () => apiFetch.mock.calls.filter((c: any) => c[0] === "/tickets").length;
  const base = tCalls();

  await act(async () => { vi.advanceTimersByTime(1000); }); // poll 2: stage plan again -> no refetch
  expect(tCalls()).toBe(base);

  await act(async () => { vi.advanceTimersByTime(1000); }); // poll 3: plan -> work -> one refetch
  await waitFor(() => expect(tCalls()).toBe(base + 1));

  await act(async () => { vi.advanceTimersByTime(1000); }); // poll 4: work again -> no refetch
  expect(tCalls()).toBe(base + 1);
});

test("restores stored ticket selection on mount and renders its run history", async () => {
  apiFetch.mockImplementation(async (path) => {
    if (path === "/tickets") return [{ id: "t1", title: "My Ticket", status: "in_progress" }];
    if (path === "/forge/agents") return [];
    if (path === "/forge/skills") return [];
    if (path === "/forge/runs") return [
      { id: "run777", ticketId: "t1", status: "passed", stage: "review", startedAt: "2024-01-01T00:00:00Z", agents: {} },
    ];
    if (path.includes("/output")) return { chunk: "", next: 0, stage: "review", status: "passed" };
    if (path.includes("/sandbox")) return { exists: false };
    return {};
  });
  localStorage.setItem("vibeops.forgeSelectedTicketId", "t1");

  render(wrap(<ForgeScreen />));
  await waitFor(() => expect(screen.getByText("Run History")).toBeInTheDocument());
  expect(screen.getByText("Run run777")).toBeInTheDocument();
});

test("clears a stored ticket id absent from the list and shows no empty detail panel", async () => {
  apiFetch.mockImplementation(async (path) => {
    if (path === "/tickets") return [{ id: "t2", title: "Other Ticket", status: "open" }];
    if (path === "/forge/agents") return [];
    if (path === "/forge/skills") return [];
    return {};
  });
  localStorage.setItem("vibeops.forgeSelectedTicketId", "t1");

  render(wrap(<ForgeScreen />));
  await waitFor(() => expect(screen.getByText("Other Ticket")).toBeInTheDocument());
  await waitFor(() => expect(localStorage.getItem("vibeops.forgeSelectedTicketId")).toBeNull());
  expect(screen.getByText("Select a work order to enter the Forge")).toBeInTheDocument();
});

test("protected-path violation shows the waive action, hides Approve, and posts the exact paths", async () => {
  apiFetch.mockImplementation(async (path, opts) => {
    if (path === "/tickets") return [{ id: "t2", title: "Review Ticket", status: "review" }];
    if (path === "/forge/agents") return [];
    if (path === "/forge/skills") return [];
    if (path === "/forge/tickets/t2/sandbox") return { exists: true, branch: "forge/t2", lastVerdict: "pass", protectedViolation: ["vitest.config.ts"] };
    if (path === "/forge/tickets/t2/waive-policy" && opts?.method === "POST") return { waived: ["vitest.config.ts"] };
    return {};
  });

  render(wrap(<ForgeScreen />));
  await waitFor(() => expect(screen.getByText("Review Ticket")).toBeInTheDocument());
  fireEvent.click(screen.getByText("Review Ticket"));
  await waitFor(() => expect(screen.getByText(/Branch:/)).toBeInTheDocument());

  expect(screen.getByText(/Protected-path policy violation/i)).toBeInTheDocument();
  expect(screen.getByText("vitest.config.ts")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Approve override/i })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Promote/i })).toBeDisabled();

  fireEvent.click(screen.getByRole("button", { name: /Waive policy for these files/i }));
  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/forge/tickets/t2/waive-policy", {
    method: "POST",
    body: { paths: ["vitest.config.ts"] },
  }));
});
