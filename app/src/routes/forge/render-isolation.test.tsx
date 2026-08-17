import { expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TicketListPane } from "./TicketListPane.js";
import { RunStatusPane } from "./RunStatusPane.js";
import type { Ticket, Agent, SandboxStatus } from "./types.js";

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const wrap = (ui: React.ReactNode) => (
  <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
);

test("TicketListPane is memoized to isolate renders from run state changes", () => {
  let parentRenders = 0;
  const stableTickets: Ticket[] = [{ id: "t1", title: "Ticket 1", status: "open", version: 1, body: null }];
  const stableSandboxes: Record<string, SandboxStatus> = {};
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
          sandboxes={stableSandboxes}
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
