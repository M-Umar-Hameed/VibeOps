import { useState, useEffect, useRef } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api.js";
import { NotFoundError } from "../../api/errors.js";
import { parseSel, type Ticket, type SandboxActivityData } from "./types.js";

export function useForgeRun(
  selectedTicket: Ticket | null,
  ticketRuns: any[],
  runsQ: { isSuccess: boolean; isError: boolean; data: unknown; refetch?: () => void },
  queryClient: QueryClient,
  agents: { planAgent: string; workAgent: string; reviewAgent: string },
) {
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [runChunks, setRunChunks] = useState<string[]>([]);
  const [runStage, setRunStage] = useState("");
  const [runStatus, setRunStatus] = useState("");
  const [runError, setRunError] = useState("");
  const [outputUnavailable, setOutputUnavailable] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [interruptedRun, setInterruptedRun] = useState(false);
  const [ticketRunActive, setTicketRunActive] = useState(false);
  const [sandboxActivity, setSandboxActivity] = useState<SandboxActivityData | null>(null);
  const [extraPrompt, setExtraPrompt] = useState("");

  const nextOffsetRef = useRef<number>(0);
  const prevStageRef = useRef("");
  const lastDerivedRunTicketRef = useRef<string | null>(null);

  const resetForTicket = () => {
    setSandboxActivity(null); setOutputUnavailable(false); setRunStartedAt(null); setShowDetails(false);
  };

  const initRunStart = () => {
    setIsSubmitting(true); setRunError(""); setRunChunks([]); setOutputUnavailable(false);
    setRunStage(""); setRunStatus("running"); setRunStartedAt(Date.now()); setShowDetails(false);
    nextOffsetRef.current = 0;
  };

  // Key the guard on the ticket AND its latest run identity, not the ticket alone.
  // Ticket-only meant state was derived once per selection, so a run that STARTED
  // after the ticket was selected (launched from the API, another window, or any
  // path that skips initRunStart) never populated runStartedAt — the badges went
  // live from the query while "Elapsed" stayed hidden. Including the run id and
  // status re-derives on a real transition while still ignoring every other poll,
  // which is what keeps it from clobbering an in-progress local run.
  const latestRunKey = `${ticketRuns[0]?.id ?? ""}:${ticketRuns[0]?.status ?? ""}`;
  useEffect(() => {
    if (!selectedTicket) { lastDerivedRunTicketRef.current = null; return; }
    if (lastDerivedRunTicketRef.current === `${selectedTicket.id}:${latestRunKey}`) return;
    if (runsQ.isError) {
      lastDerivedRunTicketRef.current = `${selectedTicket.id}:${latestRunKey}`;
      setInterruptedRun(false); setTicketRunActive(false); setActiveRunId(null);
      setIsSubmitting(false); setRunChunks([]); setRunStage(""); setRunStatus("");
      setRunError(""); nextOffsetRef.current = 0;
      return;
    }
    if (!runsQ.isSuccess) return;
    lastDerivedRunTicketRef.current = `${selectedTicket.id}:${latestRunKey}`;

    const latest = ticketRuns[0];
    setInterruptedRun(latest?.status === "interrupted");
    setTicketRunActive(latest?.status === "running");
    setRunError("");
    nextOffsetRef.current = 0;

    if (latest?.status === "running") {
      setRunChunks([]); setRunStage(latest.stage || ""); setRunStatus("running");
      setActiveRunId(latest.id); setRunStartedAt(Date.parse(latest.startedAt));
    } else if (["passed", "rejected", "failed", "stopped"].includes(latest?.status)) {
      setActiveRunId(null); setIsSubmitting(false); setRunStage(latest.stage || ""); setRunStatus(latest.status);
      api.get(`/forge/runs/${latest.id}/output?after=0`)
        .then((res: any) => setRunChunks(res.chunk ? [res.chunk] : []))
        .catch(() => setOutputUnavailable(true));
    } else {
      setActiveRunId(null); setIsSubmitting(false); setRunChunks([]); setRunStage(""); setRunStatus("");
    }
  }, [runsQ.isSuccess, runsQ.isError, runsQ.data, selectedTicket?.id]);

  useEffect(() => {
    if (!activeRunId) return;
    prevStageRef.current = "";
    let running = true;
    const poll = async () => {
      try {
        const res = await api.get(`/forge/runs/${activeRunId}/output?after=${nextOffsetRef.current}`) as { chunk: string, next: number, stage: string, status: string };
        if (!running) return;
        if (res.chunk) setRunChunks(prev => [...prev, res.chunk]);
        if (res.next !== undefined) nextOffsetRef.current = res.next;
        if (res.stage !== undefined) setRunStage(res.stage);
        if (res.status !== undefined) setRunStatus(res.status);
        if (res.status === "running" && prevStageRef.current && res.stage !== prevStageRef.current) {
          queryClient.invalidateQueries({ queryKey: ["forge", "tickets"] });
        }
        if (res.stage) prevStageRef.current = res.stage;
        if (res.status && res.status !== "running") {
          setActiveRunId(null); setTicketRunActive(false);
          if (selectedTicket) queryClient.invalidateQueries({ queryKey: ["forge", "sandbox", selectedTicket.id] });
          queryClient.invalidateQueries({ queryKey: ["forge", "tickets"] });
          queryClient.invalidateQueries({ queryKey: ["forge", "runs", selectedTicket?.id] });
        }
        if (selectedTicket) {
          try {
            const act = await api.get(`/forge/tickets/${selectedTicket.id}/sandbox/activity`) as SandboxActivityData;
            if (running) setSandboxActivity(act);
          } catch (e: any) {
            if (running && e instanceof NotFoundError) setSandboxActivity(null);
          }
        }
      } catch (e: any) {
        if (!running) return;
        setRunError(e.message || "Failed to poll output");
        setActiveRunId(null);
      }
    };
    const interval = setInterval(poll, 1000);
    poll();
    return () => { running = false; clearInterval(interval); };
  }, [activeRunId, selectedTicket]);

  useEffect(() => {
    if (runStatus !== "running") return;
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [runStatus]);

  const handleRun = async (force = false) => {
    if (!selectedTicket) return;
    initRunStart();
    try {
      const plan = parseSel(agents.planAgent), work = parseSel(agents.workAgent), review = parseSel(agents.reviewAgent);
      const body: Record<string, any> = {
        ticketId: selectedTicket.id, planAgent: plan.agent, workAgent: work.agent, reviewAgent: review.agent, extraPrompt, force,
      };
      if (plan.model) body.planModel = plan.model;
      if (work.model) body.workModel = work.model;
      if (review.model) body.reviewModel = review.model;
      const res = await api.post("/forge/pipeline", body) as { runId: string };
      setActiveRunId(res.runId);
    } catch (e: any) {
      setRunError(e.message || "Pipeline start failed"); setRunStatus("error");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleStop = async () => {
    if (activeRunId) {
      try { await api.post(`/forge/runs/${activeRunId}/stop`); }
      catch (e: any) { setRunError(e.message || "Failed to stop run"); }
    }
  };

  const handleResume = async () => {
    if (!selectedTicket) return;
    initRunStart();
    try {
      const res = await api.post(`/forge/tickets/${selectedTicket.id}/resume`) as { runId: string };
      setActiveRunId(res.runId); setInterruptedRun(false);
    } catch (e: any) {
      setRunError(e.message || "Pipeline resume failed"); setRunStatus("error");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRework = async () => {
    if (!selectedTicket) return;
    setIsSubmitting(true); setRunError("");
    try {
      const res = await api.post(`/forge/tickets/${selectedTicket.id}/rework`) as { runId: string };
      setActiveRunId(res.runId); setRunStatus("running"); setRunStage("work");
      setRunStartedAt(Date.now()); nextOffsetRef.current = 0; runsQ.refetch?.();
    } catch (e: any) {
      setRunError(e.message || "Rework failed");
    } finally {
      setIsSubmitting(false);
    }
  };

  return {
    activeRunId, setActiveRunId,
    isSubmitting,
    runChunks,
    runOutput: runChunks.join(""),
    runStage,
    runStatus,
    runError, setRunError,
    outputUnavailable,
    showDetails, setShowDetails,
    runStartedAt,
    nowMs,
    interruptedRun,
    ticketRunActive,
    sandboxActivity, setSandboxActivity,
    extraPrompt, setExtraPrompt,
    runActiveForTicket: runStatus === "running" || ticketRunActive,
    handleRun, handleStop, handleResume, handleRework, resetForTicket,
  };
}
