import { useState, useEffect, useMemo, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import { useStreamConnected } from "../lib/events.js";
import { useProject } from "../context/project.js";
import { SpecEditor } from "../components/SpecEditor.js";
import {
  type Ticket, type Agent, type Skill, type SandboxStatus, type DoctorStatus, SELECTED_TICKET_KEY,
} from "./forge/types.js";
import { useForgeRun } from "./forge/useForgeRun.js";
import { TicketHeader } from "./forge/TicketHeader.js";
import { TicketListPane } from "./forge/TicketListPane.js";
import { PipelineSettingsPane } from "./forge/PipelineSettingsPane.js";
import { RunStatusPane } from "./forge/RunStatusPane.js";
import { SandboxPane } from "./forge/SandboxPane.js";
import { DiscussionPane } from "./forge/DiscussionPane.js";
import { RunHistoryPane } from "./forge/RunHistoryPane.js";

export function ForgeScreen() {
  const { activeProjectId } = useProject();
  const queryClient = useQueryClient();
  const streamConnected = useStreamConnected();
  const [selectedTicket, setSelectedTicket] = useState<Ticket | null>(null);
  const [planAgent, setPlanAgent] = useState("auto::");
  const [workAgent, setWorkAgent] = useState("auto::");
  const [reviewAgent, setReviewAgent] = useState("auto::");
  const [selectedActivityFile, setSelectedActivityFile] = useState<string | null>(null);

  const ticketsQ = useQuery({
    queryKey: ["forge", "tickets", activeProjectId],
    // One request: GET /tickets folds sandbox status into review rows, so the
    // old per-review-ticket /sandbox loop (an N+1) is gone.
    queryFn: async () =>
      await api.get(activeProjectId ? `/tickets?projectId=${encodeURIComponent(activeProjectId)}` : "/tickets") as Ticket[],
    refetchInterval: streamConnected ? false : 5000,
  });
  const tickets = ticketsQ.data ?? [];
  const ticketsError = ticketsQ.error ? ((ticketsQ.error as any).message || "Failed to load tickets") : "";

  const closedQ = useQuery({
    queryKey: ["forge", "closed", activeProjectId],
    queryFn: async () =>
      await api.get(`/tickets?status=closed&limit=50${activeProjectId ? `&projectId=${encodeURIComponent(activeProjectId)}` : ""}`) as Ticket[],
    refetchInterval: false,
    staleTime: 30000,
  });
  const closedTickets = Array.isArray(closedQ.data) ? closedQ.data : [];

  const agentsQ = useQuery({ queryKey: ["forge", "agents"], queryFn: () => api.get("/forge/agents") as Promise<Agent[]>, staleTime: Infinity });
  const workDefaultQ = useQuery({
    queryKey: ["settings", "forge.defaultModel.work"],
    queryFn: async () => (await api.get("/settings/forge.defaultModel.work")).value || "",
  });
  const skillsQ = useQuery({ queryKey: ["forge", "skills"], queryFn: () => api.get("/forge/skills") as Promise<Skill[]>, staleTime: Infinity });
  const actorsQ = useQuery({ queryKey: ["actors"], queryFn: () => api.get("/actors") as Promise<any[]>, staleTime: Infinity });
  const doctorQ = useQuery({ queryKey: ["forge", "doctor"], queryFn: () => api.get("/forge/doctor") as Promise<DoctorStatus[]>, staleTime: Infinity });

  const agents = agentsQ.data ?? [];
  const skills = skillsQ.data ?? [];
  const actors = actorsQ.data ?? [];
  const agentsError = agentsQ.error ? ((agentsQ.error as any).message || "Failed to load agents") : "";
  const doctorStatuses = useMemo(() => {
    const byName: Record<string, DoctorStatus> = {};
    for (const s of Array.isArray(doctorQ.data) ? doctorQ.data : []) byName[s.name] = s;
    return byName;
  }, [doctorQ.data]);

  const sandboxQ = useQuery({
    queryKey: ["forge", "sandbox", selectedTicket?.id],
    queryFn: () => api.get(`/forge/tickets/${selectedTicket!.id}/sandbox`) as Promise<SandboxStatus>,
    enabled: !!selectedTicket,
  });

  const runsQ = useQuery({
    queryKey: ["forge", "runs", selectedTicket?.id],
    queryFn: () => api.get(`/forge/runs?ticketId=${encodeURIComponent(selectedTicket!.id)}`),
    enabled: !!selectedTicket,
  });
  const ticketRuns = useMemo(() => {
    const all = Array.isArray(runsQ.data) ? runsQ.data : [];
    return all.filter((r: any) => r.ticketId === selectedTicket?.id).sort((a: any, b: any) => b.startedAt.localeCompare(a.startedAt));
  }, [runsQ.data, selectedTicket?.id]);

  const recoveryQ = useQuery({
    queryKey: ["forge", "recovery"],
    queryFn: () => api.get("/forge/recovery") as Promise<{ interrupted: { ticketId: string; resumable: boolean; reason: string }[] }>,
    refetchInterval: streamConnected ? false : 5000,
  });
  const recoveryByTicket = useMemo(() => {
    const m = new Map<string, { resumable: boolean; reason: string }>();
    for (const it of recoveryQ.data?.interrupted ?? []) m.set(it.ticketId, it);
    return m;
  }, [recoveryQ.data]);

  const run = useForgeRun(selectedTicket, ticketRuns, runsQ, queryClient, { planAgent, workAgent, reviewAgent });

  useEffect(() => {
    if (selectedTicket) run.resetForTicket();
  }, [selectedTicket?.id]);

  useEffect(() => {
    if (selectedTicket) localStorage.setItem(SELECTED_TICKET_KEY, selectedTicket.id);
  }, [selectedTicket?.id]);

  useEffect(() => {
    if (!ticketsQ.isSuccess || !closedQ.isSuccess) return;
    const inEither = (tid: string) => tickets.some(t => t.id === tid) || closedTickets.some(t => t.id === tid);
    if (selectedTicket) {
      if (!inEither(selectedTicket.id)) {
        setSelectedTicket(null);
        localStorage.removeItem(SELECTED_TICKET_KEY);
      }
      return;
    }
    const saved = localStorage.getItem(SELECTED_TICKET_KEY);
    if (!saved) return;
    const found = tickets.find(t => t.id === saved) ?? closedTickets.find(t => t.id === saved);
    if (found) setSelectedTicket(found);
    else localStorage.removeItem(SELECTED_TICKET_KEY);
  }, [ticketsQ.data, ticketsQ.isSuccess, closedQ.data, closedQ.isSuccess, selectedTicket]);

  const handleSelectTicket = useCallback((t: Ticket) => setSelectedTicket(t), []);
  const handleTicketCreated = useCallback((t: Ticket) => setSelectedTicket(t), []);
  const handleOpenActivityFile = useCallback((path: string) => setSelectedActivityFile(path), []);
  const handleActivityFileConsumed = useCallback(() => setSelectedActivityFile(null), []);
  const handleResumeRun = useCallback((runId: string) => run.setActiveRunId(runId), [run.setActiveRunId]);

  return (
    <div className="absolute inset-0 flex overflow-hidden">
      <TicketListPane
        tickets={tickets} selectedTicketId={selectedTicket?.id ?? null}
        activeProjectId={activeProjectId} agents={agents} workDefaultModel={workDefaultQ.data ?? ""}
        planAgent={planAgent} workAgent={workAgent} reviewAgent={reviewAgent}
        onSelectTicket={handleSelectTicket} onTicketCreated={handleTicketCreated} ticketsError={ticketsError}
        closedTickets={closedTickets}
      />

      <div className="flex-1 flex flex-col overflow-y-auto bg-surface-container-lowest">
        {selectedTicket ? (
          <div className="p-6 md:p-8 space-y-8 max-w-4xl mx-auto w-full">
            <TicketHeader selectedTicket={selectedTicket} runActiveForTicket={run.runActiveForTicket} onTicketUpdated={setSelectedTicket} />
            {agentsError && <div className="text-error text-sm">{agentsError}</div>}
            
            <SpecEditor
              ticket={selectedTicket} 
              onSave={(t) => { setSelectedTicket(t); queryClient.invalidateQueries({ queryKey: ["forge", "tickets"] }); }}
            />

            <PipelineSettingsPane
              agents={agents} skills={skills} doctorStatuses={doctorStatuses} runsData={runsQ.data} tickets={tickets}
              planAgent={planAgent} setPlanAgent={setPlanAgent} workAgent={workAgent} setWorkAgent={setWorkAgent}
              reviewAgent={reviewAgent} setReviewAgent={setReviewAgent} extraPrompt={run.extraPrompt}
              onExtraPromptChange={run.setExtraPrompt} activeRunId={run.activeRunId} isSubmitting={run.isSubmitting}
              interruptedRun={run.interruptedRun} runStage={run.runStage} runStatus={run.runStatus} runError={run.runError}
              onRun={run.handleRun} onStop={run.handleStop} onResume={run.handleResume}
            />

            <RunStatusPane
              activeRunId={run.activeRunId} runChunks={run.runChunks} runOutput={run.runOutput} runStage={run.runStage}
              runStatus={run.runStatus} runError={run.runError} outputUnavailable={run.outputUnavailable}
              showDetails={run.showDetails} setShowDetails={run.setShowDetails} runStartedAt={run.runStartedAt}
              nowMs={run.nowMs} sandboxActivity={run.sandboxActivity} rejectionReason={ticketRuns[0]?.rejectionReason}
              onOpenActivityFile={handleOpenActivityFile}
            />

            <SandboxPane
              selectedTicket={selectedTicket} sandbox={sandboxQ.data ?? null}
              sandboxQError={(sandboxQ.error as any)?.message ?? ""} runStatus={run.runStatus}
              runActiveForTicket={run.runActiveForTicket} isSubmitting={run.isSubmitting} ticketRuns={ticketRuns}
              onRework={run.handleRework} selectedActivityFile={selectedActivityFile}
              onActivityFileConsumed={handleActivityFileConsumed}
            />

            <DiscussionPane selectedTicket={selectedTicket} actors={actors} onTicketUpdated={setSelectedTicket} />
            <RunHistoryPane
              ticketRuns={ticketRuns} recoveryByTicket={recoveryByTicket}
              selectedTicketId={selectedTicket?.id ?? null} onResumeRun={handleResumeRun}
            />
          </div>
        ) : tickets.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
            <span className="material-symbols-outlined text-6xl text-on-surface-variant/30 mb-6">construction</span>
            <div className="text-on-surface-variant max-w-md">
              <p className="mb-6 text-lg">The Forge is where autonomous agents write and review code for your work orders.</p>
              <button onClick={() => document.querySelector('textarea')?.focus()} className="bg-primary text-on-primary px-6 py-2 rounded font-bold uppercase tracking-widest cursor-pointer hover:brightness-110">Create a task to start</button>
            </div>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center text-on-surface-variant/50">Select a work order to enter the Forge</div>
        )}
      </div>
    </div>
  );
}
