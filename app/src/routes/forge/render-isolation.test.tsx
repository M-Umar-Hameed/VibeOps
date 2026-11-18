import { expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TicketListPane } from "./TicketListPane.js";
import { RunStatusPane } from "./RunStatusPane.js";
import { PipelineSettingsPane } from "./PipelineSettingsPane.js";
import type { Ticket, Agent } from "./types.js";

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const wrap = (ui: React.ReactNode) => (
  <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
);

test("TicketListPane is memoized to isolate renders from run state changes", () => {
  let parentRenders = 0;
  const stableTickets: Ticket[] = [{ id: "t1", title: "Ticket 1", status: "open", version: 1, body: null }];
  const stableAgents: Agent[] = [];
  const stableOnSelect = vi.fn();
  const stableOnCreated = vi.fn();

  function TestContainer({ runState }: { runState: string }) {
    parentRenders++;
    return (
      <div>
        <span data-testid="run-state">{runState}</span>
        <TicketListPane
          tickets={stableTickets}
          selectedTicketId="t1"
          activeProjectId="p1"
          agents={stableAgents}
          workDefaultModel=""
          planAgent="auto::"
          workAgent="auto::"
          reviewAgent="auto::"
          onSelectTicket={stableOnSelect}
          onTicketCreated={stableOnCreated}
          ticketsError=""
        />
      </div>
    );
  }

  const { rerender } = render(wrap(<TestContainer runState="initial-run" />));
  expect(parentRenders).toBe(1);
  expect(screen.getByText("Ticket 1")).toBeInTheDocument();

  rerender(wrap(<TestContainer runState="updated-run" />));
  expect(parentRenders).toBe(2);
  expect(screen.getByTestId("run-state").textContent).toBe("updated-run");
});

test("RunStatusPane re-renders when runStage changes", () => {
  let renders = 0;
  const CountedRunStatusPane = (props: any) => {
    renders++;
    return <RunStatusPane {...props} />;
  };

  const { rerender } = render(
    <CountedRunStatusPane
      activeRunId="r1"
      runChunks={["chunk1"]}
      runOutput="chunk1"
      runStage="plan"
      runStatus="running"
      runError=""
      outputUnavailable={false}
      showDetails={false}
      setShowDetails={vi.fn()}
      runStartedAt={1000}
      nowMs={2000}
      sandboxActivity={null}
      onOpenActivityFile={vi.fn()}
    />
  );
  expect(renders).toBe(1);
  expect(screen.getByTestId("run-stage-label").textContent).toBe("Planning the change");

  rerender(
    <CountedRunStatusPane
      activeRunId="r1"
      runChunks={["chunk1", "chunk2"]}
      runOutput="chunk1chunk2"
      runStage="work"
      runStatus="running"
      runError=""
      outputUnavailable={false}
      showDetails={false}
      setShowDetails={vi.fn()}
      runStartedAt={1000}
      nowMs={2000}
      sandboxActivity={null}
      onOpenActivityFile={vi.fn()}
    />
  );
  expect(renders).toBe(2);
  expect(screen.getByTestId("run-stage-label").textContent).toBe("Writing and editing code");
});

const paneProps = {
  activeRunId: "r1", runChunks: ["c"], runOutput: "c", runStage: "work", runStatus: "running", runError: "",
  outputUnavailable: false, showDetails: false, setShowDetails: vi.fn(), runStartedAt: 1000, nowMs: 2000,
  sandboxActivity: null, onOpenActivityFile: vi.fn(),
};

test("RunStatusPane shows the agent next to the stage when given one", () => {
  render(<RunStatusPane {...paneProps} runAgent="deepseek:deepseek-9b" />);
  expect(screen.getByTestId("run-stage-agent").textContent).toBe(" - deepseek:deepseek-9b");
  expect(screen.getByTestId("run-stage-label").textContent).toBe("Writing and editing code");
});

test("RunStatusPane renders no agent text when none is given", () => {
  render(<RunStatusPane {...paneProps} />);
  expect(screen.queryByTestId("run-stage-agent")).toBeNull();
  expect(screen.getByTestId("run-stage-label").textContent).toBe("Writing and editing code");
});

const settingsProps = {
  agents: [] as Agent[], skills: [], doctorStatuses: {}, tickets: [] as Ticket[],
  planAgent: "auto::", setPlanAgent: vi.fn(), workAgent: "claude::Sonnet", setWorkAgent: vi.fn(),
  reviewAgent: "auto::", setReviewAgent: vi.fn(), extraPrompt: "", onExtraPromptChange: vi.fn(),
  activeRunId: null, isSubmitting: false, interruptedRun: false, runStage: "", runStatus: "", runError: "",
  onRun: vi.fn(), onStop: vi.fn(), onResume: vi.fn(),
};
const picks = { plan: "claude:Opus", work: "agy:gemini-3.8-flash-high", review: "claude:Opus" };

test("PipelineSettingsPane shows the auto pick under auto selects only", () => {
  render(wrap(<PipelineSettingsPane {...settingsProps} autoPicks={picks} />));
  expect(screen.getByTestId("pick-plan").textContent).toBe("Auto: claude:Opus");
  expect(screen.getByTestId("pick-review").textContent).toBe("Auto: claude:Opus");
  expect(screen.queryByTestId("pick-work")).toBeNull();
});

test("PipelineSettingsPane shows no pick line before picks arrive", () => {
  render(wrap(<PipelineSettingsPane {...settingsProps} />));
  expect(screen.queryByTestId("pick-plan")).toBeNull();
});

test("PipelineSettingsPane shows the active run's agents for all three roles", () => {
  render(wrap(<PipelineSettingsPane {...settingsProps} autoPicks={picks} runAgents={{ plan: "claude:Opus", work: "deepseek:deepseek-9b", review: "claude:Sonnet" }} />));
  expect(screen.getByTestId("pick-plan").textContent).toBe("Running: claude:Opus");
  expect(screen.getByTestId("pick-work").textContent).toBe("Running: deepseek:deepseek-9b");
  expect(screen.getByTestId("pick-review").textContent).toBe("Running: claude:Sonnet");
});

const listProps = {
  selectedTicketId: null, activeProjectId: "p1", agents: [] as Agent[], workDefaultModel: "",
  planAgent: "auto::", workAgent: "auto::", reviewAgent: "auto::",
  onSelectTicket: vi.fn(), onTicketCreated: vi.fn(), ticketsError: "",
};

test("TicketListPane badge shows the agent when activeRun.agent is present", () => {
  const tickets: Ticket[] = [{ id: "t1", title: "T", status: "open", version: 1, body: null, activeRun: { stage: "work", agent: "deepseek:deepseek-9b" } }];
  render(wrap(<TicketListPane {...listProps} tickets={tickets} />));
  expect(screen.getByText("work running - deepseek:deepseek-9b")).toBeInTheDocument();
});

test("TicketListPane badge keeps the old text when activeRun.agent is absent", () => {
  const tickets: Ticket[] = [{ id: "t1", title: "T", status: "open", version: 1, body: null, activeRun: { stage: "work" } }];
  render(wrap(<TicketListPane {...listProps} tickets={tickets} />));
  expect(screen.getByText("work running")).toBeInTheDocument();
  expect(screen.queryByText(/ - /)).toBeNull();
});
