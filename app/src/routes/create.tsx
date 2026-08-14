import { useState, useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { projects } from "../api/projects.js";
import { actors } from "../api/actors.js";
import { tickets } from "../api/tickets.js";
import { Avatar } from "../components/Avatar.js";
import { api } from "../lib/api.js";
import { useProject } from "../context/project.js";
import { WorkOrderComposer, modelOptionsForRole } from "../components/WorkOrderComposer.js";
import { Markdown } from "../components/Markdown.js";
import { exportBrief, sendBriefToNotebookLM } from "../lib/notebooklm.js";
import { RunContextMenu, type MenuItemSpec } from "../components/RunContextMenu.js";

const COUNCIL_KEY = "vibeops.activeCouncilId";

export function CreateScreen() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const { activeProjectId } = useProject();
  const [mode, setMode] = useState<"council" | "quick">("council");
  const pq = useQuery({ queryKey: ["projects"], queryFn: projects.list });
  const aq = useQuery({ queryKey: ["actors"], queryFn: actors.list });
  const agentsQ = useQuery({
    queryKey: ["forge", "agents"],
    queryFn: () => api.get("/forge/agents") as Promise<{ name: string; roles: string[]; models?: { name: string }[] }[]>,
    staleTime: Infinity,
  });
  const workDefaultQ = useQuery({
    queryKey: ["settings", "forge.defaultModel.work"],
    queryFn: async () => (await api.get("/settings/forge.defaultModel.work")).value || "",
  });
  const [projectId, setProjectId] = useState("");
  const [priority, setPriority] = useState("normal");
  const [assigneeId, setAssigneeId] = useState("");
  const [requiresVerification, setRequiresVerification] = useState(false);

  useEffect(() => {
    if (activeProjectId) setProjectId(activeProjectId);
  }, [activeProjectId]);

  return (
    <div className="w-full max-w-3xl mx-auto mt-8">
      <p className="text-sm text-on-surface-variant/70 text-center mb-4">Council-review or quick-create a new ticket.</p>
      <div className="flex gap-2 mb-6 justify-center">
        <button
          type="button"
          onClick={() => setMode("council")}
          className={`px-6 py-2 font-code-label text-code-label uppercase tracking-widest rounded-sm cursor-pointer ${mode === "council" ? "bg-primary-fixed-dim text-on-primary" : "bg-surface-container-lowest text-on-surface-variant border border-white/10"}`}
        >
          Council
        </button>
        <button
          type="button"
          onClick={() => setMode("quick")}
          className={`px-6 py-2 font-code-label text-code-label uppercase tracking-widest rounded-sm cursor-pointer ${mode === "quick" ? "bg-primary-fixed-dim text-on-primary" : "bg-surface-container-lowest text-on-surface-variant border border-white/10"}`}
        >
          Quick create
        </button>
      </div>

      {mode === "council" && <CouncilPanel projects={pq.data ?? []} activeProjectId={activeProjectId} nav={nav} />}

      {mode === "quick" && (
        <div className="glass-card rounded-lg p-8 relative overflow-hidden">
          <div className="absolute top-0 left-0 w-full h-[2px] bg-gradient-to-r from-primary-fixed-dim via-transparent to-transparent opacity-50"></div>
          <div className="mb-10 text-center">
            <h2 className="font-code-label text-2xl text-primary-fixed-dim tracking-[0.2em] uppercase terminal-cursor">INITIALIZE_WORK_ORDER</h2>
            <div className="h-[1px] w-24 bg-primary-fixed-dim/30 mx-auto mt-4"></div>
          </div>
          <WorkOrderComposer
            createTicket={({ title, body }) =>
              tickets.create({ projectId, title, body, priority, assigneeId: assigneeId || undefined, requiresVerification })}
            launchPipeline={(t, effort, work) => api.post("/forge/pipeline", {
              ticketId: t.id,
              planAgent: "auto", workAgent: work?.agent ?? "auto", reviewAgent: "auto",
              ...(work?.model ? { workModel: work.model } : {}),
              extraPrompt: "", force: false, effort,
            }) as Promise<{ runId: string; doctorWarnings?: string[] }>}
            onCreated={(t, { pipelineError }) => {
              qc.invalidateQueries({ queryKey: ["tickets"] });
              if (!pipelineError) nav({ to: "/tickets/$id", params: { id: t.id } });
            }}
            submitDisabled={!projectId}
            modelOptions={modelOptionsForRole(agentsQ.data ?? [], "work")}
            defaultModel={workDefaultQ.data ?? ""}
            inlineControls={
              <>
                <select
                  aria-label="Project"
                  className="bg-surface-container-lowest border border-white/10 rounded px-2 py-1 text-xs text-on-surface outline-none cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                  value={projectId}
                  onChange={(e) => setProjectId(e.target.value)}
                  disabled={!!activeProjectId}
                >
                  <option className="bg-surface text-on-surface-variant" value="">Select project</option>
                  {pq.data?.map((p) => <option className="bg-surface" key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <select
                  aria-label="Priority"
                  className="bg-surface-container-lowest border border-white/10 rounded px-2 py-1 text-xs text-on-surface outline-none cursor-pointer"
                  value={priority}
                  onChange={(e) => setPriority(e.target.value)}
                >
                  <option className="bg-surface" value="low">low</option>
                  <option className="bg-surface" value="normal">normal</option>
                  <option className="bg-surface" value="high">high</option>
                  <option className="bg-surface" value="critical">critical</option>
                </select>
              </>
            }
            moreOptions={
              <details className="text-xs text-on-surface-variant">
                <summary className="cursor-pointer hover:text-on-surface">More options</summary>
                <div className="mt-2 space-y-2">
                  <div className="flex items-center gap-2">
                    <Avatar actorId={assigneeId} size="md" />
                    <select
                      aria-label="Assignee"
                      className="flex-1 bg-surface-container-lowest border border-white/10 rounded px-2 py-1 text-xs text-on-surface outline-none cursor-pointer"
                      value={assigneeId}
                      onChange={(e) => setAssigneeId(e.target.value)}
                    >
                      <option className="bg-surface" value="">@unassigned</option>
                      {aq.data?.map((a) => <option className="bg-surface" key={a.id} value={a.id}>@{a.name}</option>)}
                    </select>
                  </div>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={requiresVerification} onChange={(e) => setRequiresVerification(e.target.checked)} className="w-4 h-4 rounded border-white/10 bg-surface-container-lowest text-primary-fixed-dim focus:ring-primary-fixed-dim focus:ring-1 outline-none" />
                    Require verification to close
                  </label>
                </div>
              </details>
            }
          />
        </div>
      )}
    </div>
  );
}

type Project = { id: string; name: string };
type CouncilStatus = "idle" | "running" | "awaiting-answers" | "decided" | "consumed" | "failed";
type Decision = "GO" | "NO-GO" | "NEEDS-INFO";
type CouncilRow = { id: string; status: CouncilStatus; round: number; startedAt: string; promptPreview: string; resumable?: boolean; resumeReason?: string };
type CouncilDetail = {
  status: CouncilStatus; round?: number; rating?: number; decision?: Decision;
  questions?: string[]; title?: string; spec?: string;
  believer?: string; investor?: string; skeptic?: string;
};

function CouncilPanel({ projects, activeProjectId, nav }: { projects: Project[]; activeProjectId: string | null; nav: ReturnType<typeof useNavigate> }) {
  const [ideaPrompt, setIdeaPrompt] = useState("");
  const [councilProjectId, setCouncilProjectId] = useState("");

  useEffect(() => {
    if (activeProjectId) setCouncilProjectId(activeProjectId);
  }, [activeProjectId]);
  const [councilId, setCouncilId] = useState<string | null>(null);
  const [councilStatus, setCouncilStatus] = useState<CouncilStatus>("idle");
  const [rowMenu, setRowMenu] = useState<{ items: MenuItemSpec[]; x: number; y: number; label: string } | null>(null);
  const [councilOutput, setCouncilOutput] = useState("");
  const [councilRating, setCouncilRating] = useState<number | undefined>(undefined);
  const [councilDecision, setCouncilDecision] = useState<Decision | undefined>(undefined);
  const [councilQuestions, setCouncilQuestions] = useState<string[]>([]);
  // Title is shown inside the spec preview; only the setter side effects matter.
  const [, setCouncilTitle] = useState("");
  const [councilSpec, setCouncilSpec] = useState("");
  const [personaTexts, setPersonaTexts] = useState<{ believer?: string; investor?: string; skeptic?: string }>({});
  const [showConsole, setShowConsole] = useState(false);
  const [expanded, setExpanded] = useState<null | "believer" | "investor" | "skeptic" | "spec">(null);
  const [answers, setAnswers] = useState<string[]>([]);
  const [forceCreate, setForceCreate] = useState(false);
  const [requiresVerification, setRequiresVerification] = useState(false);
  const [evaluating, setEvaluating] = useState(false);
  const [submittingAnswers, setSubmittingAnswers] = useState(false);
  const [creatingTicket, setCreatingTicket] = useState(false);
  const [councilError, setCouncilError] = useState("");
  const nextOffsetRef = useRef(0);
  const outputRef = useRef<HTMLPreElement>(null);

  const [councilRound, setCouncilRound] = useState(1);
  const MAX_ACTIVE = 3; // mirrors MAX_ACTIVE in src/council/runs.ts
  const councilListQ = useQuery({
    queryKey: ["council", "list"],
    queryFn: () => api.get("/council") as Promise<CouncilRow[]>,
    refetchInterval: 4000,
  });
  const rows = Array.isArray(councilListQ.data) ? councilListQ.data : [];
  const activeRows = rows.filter((r) => r.status === "running" || r.status === "awaiting-answers");

  useEffect(() => {
    if (!councilId || councilStatus !== "running") return;
    let running = true;
    const poll = async () => {
      try {
        const res = await api.get(`/council/${councilId}/output?after=${nextOffsetRef.current}`) as { chunk: string; next: number; status: string };
        if (!running) return;
        if (res.chunk) {
          setCouncilOutput(prev => prev + res.chunk);
          setTimeout(() => {
            if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight;
          }, 10);
        }
        nextOffsetRef.current = res.next;
        if (res.status !== "running") running = false;
      } catch (e: any) {
        if (!running) return;
        setCouncilError(e.message || "Failed to poll output");
        running = false;
      }
    };
    const interval = setInterval(poll, 1000);
    poll();
    return () => { running = false; clearInterval(interval); };
  }, [councilId, councilStatus]);

  useEffect(() => {
    if (!councilId || councilStatus !== "running") return;
    let running = true;
    const poll = async () => {
      try {
        const res = await api.get(`/council/${councilId}`) as {
          status: CouncilStatus; round?: number; rating?: number; decision?: Decision;
          questions?: string[]; title?: string; spec?: string;
          believer?: string; investor?: string; skeptic?: string;
        };
        if (!running) return;
        setCouncilStatus(res.status);
        if (res.round !== undefined) setCouncilRound(res.round);
        if (res.rating !== undefined) setCouncilRating(res.rating);
        if (res.decision !== undefined) setCouncilDecision(res.decision);
        if (res.questions !== undefined) {
          setCouncilQuestions(res.questions);
          setAnswers(res.questions.map(() => ""));
        }
        if (res.title !== undefined) setCouncilTitle(res.title);
        if (res.spec !== undefined) setCouncilSpec(res.spec);
        setPersonaTexts({ believer: res.believer, investor: res.investor, skeptic: res.skeptic });
        if (res.status !== "running") running = false;
      } catch (e: any) {
        if (!running) return;
        setCouncilError(e.message || "Failed to poll council status");
        running = false;
      }
    };
    const interval = setInterval(poll, 2000);
    poll();
    return () => { running = false; clearInterval(interval); };
  }, [councilId, councilStatus]);

  const loadCouncil = async (id: string) => {
    const res = await api.get(`/council/${id}`) as CouncilDetail;
    setCouncilId(id);
    localStorage.setItem(COUNCIL_KEY, id);
    setCouncilStatus(res.status);
    if (res.round !== undefined) setCouncilRound(res.round);
    if (res.rating !== undefined) setCouncilRating(res.rating);
    if (res.decision !== undefined) setCouncilDecision(res.decision);
    if (res.questions !== undefined) { setCouncilQuestions(res.questions); setAnswers(res.questions.map(() => "")); }
    if (res.title !== undefined) setCouncilTitle(res.title);
    if (res.spec !== undefined) setCouncilSpec(res.spec);
    setPersonaTexts({ believer: res.believer, investor: res.investor, skeptic: res.skeptic });
    nextOffsetRef.current = 0;
  };

  useEffect(() => {
    const saved = localStorage.getItem(COUNCIL_KEY);
    if (!saved) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get(`/council/${saved}`) as CouncilDetail;
        if (cancelled) return;
        if (res.status === "running" || res.status === "awaiting-answers" || res.status === "decided") {
          await loadCouncil(saved);
        } else {
          localStorage.removeItem(COUNCIL_KEY);
        }
      } catch {
        if (!cancelled) localStorage.removeItem(COUNCIL_KEY);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const handleEvaluate = async () => {
    const prompt = ideaPrompt.trim();
    if (!prompt || !councilProjectId) return;
    if (activeRows.length >= MAX_ACTIVE) {
      const holding = activeRows.map((r) => `"${r.promptPreview}"`).join(", ");
      setCouncilError(`Max ${MAX_ACTIVE} councils active. Finish or answer one first: ${holding}`);
      return;
    }
    setEvaluating(true);
    setCouncilError("");
    try {
      const res = await api.post("/council/evaluate", { prompt, projectId: councilProjectId }) as { councilId: string };
      setCouncilId(res.councilId);
      localStorage.setItem(COUNCIL_KEY, res.councilId);
      setPersonaTexts({});
      setCouncilStatus("running");
      setCouncilOutput("");
      setCouncilQuestions([]);
      setAnswers([]);
      setCouncilRating(undefined);
      setCouncilDecision(undefined);
      setCouncilSpec("");
      setCouncilTitle("");
      setForceCreate(false);
      nextOffsetRef.current = 0;
    } catch (e: any) {
      setCouncilError(e.message || "Failed to start council");
    } finally {
      setEvaluating(false);
    }
  };

  const handleSubmitAnswers = async () => {
    if (!councilId) return;
    setSubmittingAnswers(true);
    setCouncilError("");
    try {
      await api.post(`/council/${councilId}/answers`, { answers });
      setCouncilStatus("running");
    } catch (e: any) {
      setCouncilError(e.message || "Failed to submit answers");
    } finally {
      setSubmittingAnswers(false);
    }
  };

  const handleCreateTicket = async () => {
    if (!councilId || !councilProjectId) return;
    setCreatingTicket(true);
    setCouncilError("");
    try {
      const body: { projectId: string; force?: boolean; requiresVerification?: boolean } = { projectId: councilProjectId, requiresVerification };
      if (councilDecision !== "GO" && forceCreate) body.force = true;
      const ticket = await api.post(`/council/${councilId}/create-ticket`, body) as { id: string };
      localStorage.removeItem(COUNCIL_KEY);
      nav({ to: "/tickets/$id", params: { id: ticket.id } });
    } catch (e: any) {
      setCouncilError(e.message || "Failed to create ticket");
    } finally {
      setCreatingTicket(false);
    }
  };

  const handleStartOver = () => {
    localStorage.removeItem(COUNCIL_KEY);
    setPersonaTexts({});
    setShowConsole(false);
    setExpanded(null);
    setCouncilId(null);
    setCouncilStatus("idle");
    setCouncilOutput("");
    setCouncilQuestions([]);
    setAnswers([]);
    setCouncilRating(undefined);
    setCouncilDecision(undefined);
    setCouncilSpec("");
    setCouncilTitle("");
    setForceCreate(false);
    setCouncilError("");
    nextOffsetRef.current = 0;
  };

  const personaGrid = (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      <PersonaCard name="Believer" text={personaTexts.believer} onExpand={() => setExpanded("believer")} />
      <PersonaCard name="Investor" text={personaTexts.investor} onExpand={() => setExpanded("investor")} />
      <PersonaCard name="Skeptic" text={personaTexts.skeptic} onExpand={() => setExpanded("skeptic")} />
    </div>
  );

  const personaGridLabeled = (
    <div className="space-y-2">
      <div className="font-code-sm text-on-surface-variant uppercase tracking-widest">Round {councilRound} positions</div>
      {personaGrid}
    </div>
  );

  const allPersonasHaveText = !!(personaTexts.believer && personaTexts.investor && personaTexts.skeptic);

  const handleResumeCouncil = async (id: string) => {
    await api.post(`/council/${id}/resume`);
    await loadCouncil(id);
    setCouncilStatus("running");
    localStorage.setItem(COUNCIL_KEY, id);
    councilListQ.refetch();
  };

  const buildCouncilItems = (row: CouncilRow): MenuItemSpec[] => {
    const inFlight = row.status === "running" || row.status === "awaiting-answers";
    const slot1: MenuItemSpec = inFlight
      ? { key: "stop", label: "Stop session", danger: true, disabled: true,
          disabledReason: "Council has no stop control" }
      : row.status === "failed"
        ? { key: "resume", label: "Resume session",
            disabled: row.resumable === false,
            disabledReason: row.resumeReason || "session is not resumable",
            onSelect: () => handleResumeCouncil(row.id) }
        : { key: "resume", label: "Resume session", disabled: true,
            disabledReason: "nothing to resume for this session" };
    const retry: MenuItemSpec = {
      key: "retry", label: "Retry (new session)",
      disabled: inFlight, disabledReason: "session in flight",
      confirm: {
        title: "Start a new session?",
        message: "Clears this view and starts fresh from round 1. Existing session records are kept.",
        confirmLabel: "New session",
      },
      onSelect: () => { handleStartOver(); },
    };
    return [slot1, retry];
  };

  const openCouncilMenu = (row: CouncilRow, x: number, y: number) =>
    setRowMenu({ items: buildCouncilItems(row), x, y, label: `Actions for session ${row.id.substring(0, 8)}` });

  return (
    <div className="glass-card rounded-lg p-8 relative overflow-hidden space-y-6">
      <CouncilList rows={rows} activeCount={activeRows.length} max={MAX_ACTIVE} onOpen={loadCouncil} onRowMenu={openCouncilMenu} />
      {councilStatus !== "idle" && (
        <button
          type="button"
          onClick={handleStartOver}
          className="px-6 py-2 bg-surface-container-highest text-on-surface font-code-label uppercase tracking-widest rounded-sm cursor-pointer"
        >
          New council
        </button>
      )}
      {councilStatus === "idle" && (
        <div className="space-y-6">
          <div className="space-y-4">

          <div className="space-y-2">
            <label className="font-code-sm text-on-surface-variant uppercase tracking-widest">Idea</label>
            <textarea
              className="w-full bg-surface-container-lowest border border-white/5 p-6 font-code-label text-on-surface rounded-sm outline-none resize-y"
              placeholder="Describe the idea for the council to evaluate..."
              rows={6}
              value={ideaPrompt}
              onChange={(e) => setIdeaPrompt(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <label className="font-code-sm text-on-surface-variant uppercase tracking-widest">Project</label>
            <select
              className="w-full bg-surface-container-lowest border border-white/5 px-4 py-4 font-code-label text-on-surface rounded-sm outline-none cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              value={councilProjectId}
              onChange={(e) => setCouncilProjectId(e.target.value)}
              disabled={!!activeProjectId}
            >
              <option value="">Select target namespace</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <button
            type="button"
            onClick={handleEvaluate}
            disabled={evaluating || !ideaPrompt.trim() || !councilProjectId}
            className="w-full px-10 py-4 bg-primary-fixed-dim text-on-primary font-code-label font-bold uppercase tracking-[0.15em] rounded-sm disabled:opacity-50 cursor-pointer"
          >
            Convene council
          </button>
          </div>
        </div>
      )}

      {councilId && councilStatus === "running" && (
        <div className="space-y-4">
          {personaGridLabeled}
          {allPersonasHaveText ? (
            <div className="text-xs uppercase tracking-widest text-primary-fixed-dim animate-pulse">Chairman deliberating...</div>
          ) : (
            <div className="text-xs uppercase tracking-widest text-on-surface-variant animate-pulse">Council in session...</div>
          )}
          <ConsoleToggle show={showConsole} onToggle={() => setShowConsole(s => !s)} output={councilOutput} outputRef={outputRef} />
        </div>
      )}

      {councilId && councilStatus === "awaiting-answers" && (
        <div className="space-y-4">
          <VerdictCard rating={councilRating} decision={councilDecision} councilId={councilId} />
          <SpecBlock spec={councilSpec} onExpand={() => setExpanded("spec")} />
          {personaGridLabeled}
          <ConsoleToggle show={showConsole} onToggle={() => setShowConsole(s => !s)} output={councilOutput} />
          {councilQuestions.map((q, i) => (
            <div key={i} className="space-y-1">
              <label className="text-sm text-on-surface-variant">{q}</label>
              <input
                className="w-full bg-surface-container-lowest border border-white/5 px-4 py-3 text-on-surface rounded-sm outline-none"
                value={answers[i] ?? ""}
                onChange={(e) => setAnswers(prev => { const next = [...prev]; next[i] = e.target.value; return next; })}
              />
            </div>
          ))}
          <button
            type="button"
            onClick={handleSubmitAnswers}
            disabled={submittingAnswers}
            className="w-full px-10 py-4 bg-primary-fixed-dim text-on-primary font-code-label font-bold uppercase tracking-[0.15em] rounded-sm disabled:opacity-50 cursor-pointer"
          >
            Submit answers
          </button>
        </div>
      )}

      {councilId && councilStatus === "decided" && (
        <div className="space-y-4">
          <VerdictCard rating={councilRating} decision={councilDecision} councilId={councilId} />
          {personaGridLabeled}
          <SpecBlock spec={councilSpec} onExpand={() => setExpanded("spec")} />
          <ConsoleToggle show={showConsole} onToggle={() => setShowConsole(s => !s)} output={councilOutput} />
          {councilDecision !== "GO" && (
            <label className="flex items-center gap-2 text-sm text-on-surface-variant">
              <input type="checkbox" checked={forceCreate} onChange={(e) => setForceCreate(e.target.checked)} />
              Create anyway
            </label>
          )}
          <label className="flex items-center gap-2 text-sm text-on-surface-variant">
            <input type="checkbox" checked={requiresVerification} onChange={(e) => setRequiresVerification(e.target.checked)} />
            Require verification to close
          </label>
          <button
            type="button"
            onClick={handleCreateTicket}
            disabled={creatingTicket || (councilDecision !== "GO" && !forceCreate)}
            className="w-full px-10 py-4 bg-primary-fixed-dim text-on-primary font-code-label font-bold uppercase tracking-[0.15em] rounded-sm disabled:opacity-50 cursor-pointer"
          >
            {councilDecision === "GO" ? "Create work order" : "Create ticket"}
          </button>
        </div>
      )}

      {councilId && councilStatus === "failed" && (
        <div className="space-y-4">
          <div className="text-error text-sm">{councilError || "Council run failed."}</div>
          <button
            type="button"
            onClick={handleStartOver}
            className="px-6 py-2 bg-surface-container-highest text-on-surface font-code-label uppercase tracking-widest rounded-sm cursor-pointer"
          >
            Start over
          </button>
        </div>
      )}

      {councilError && councilStatus !== "failed" && <div className="text-error text-sm">{councilError}</div>}
      {expanded && (
        <ReadingOverlay
          title={expanded === "spec" ? "Spec" : expanded.charAt(0).toUpperCase() + expanded.slice(1)}
          text={
            expanded === "spec" ? councilSpec
            : expanded === "believer" ? (personaTexts.believer ?? "")
            : expanded === "investor" ? (personaTexts.investor ?? "")
            : (personaTexts.skeptic ?? "")
          }
          onClose={() => setExpanded(null)}
        />
      )}
      {rowMenu && <RunContextMenu {...rowMenu} onClose={() => setRowMenu(null)} />}
    </div>
  );
}

function SpecBlock({ spec, onExpand }: { spec: string; onExpand: () => void }) {
  if (!spec) return null;
  return (
    <div className="p-4 max-h-64 overflow-y-auto bg-background/80 border border-white/10 rounded-lg">
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="font-code-label text-xs uppercase tracking-widest text-on-surface-variant">Spec</div>
        <button
          type="button"
          aria-label="Expand spec"
          onClick={onExpand}
          className="text-[10px] uppercase tracking-wider text-primary-fixed-dim hover:underline cursor-pointer"
        >
          Expand
        </button>
      </div>
      <Markdown text={spec} className="text-sm text-on-surface space-y-2 leading-relaxed text-left max-w-[72ch]" />
    </div>
  );
}

function CouncilList({ rows, activeCount, max, onOpen, onRowMenu }: {
  rows: CouncilRow[]; activeCount: number; max: number; onOpen: (id: string) => void;
  onRowMenu: (row: CouncilRow, x: number, y: number) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="font-code-sm text-on-surface-variant uppercase tracking-widest">Sessions</div>
        <div className="text-xs text-on-surface-variant">{activeCount}/{max} active</div>
      </div>
      <ul className="space-y-1">
        {rows.map((r) => {
          const awaiting = r.status === "awaiting-answers";
          return (
            <li key={r.id} className="relative">
              <button
                type="button"
                onClick={() => onOpen(r.id)}
                onContextMenu={(e) => { e.preventDefault(); onRowMenu(r, e.clientX, e.clientY); }}
                className={`w-full text-left flex items-center gap-3 px-3 py-2 pr-9 rounded-sm border cursor-pointer ${awaiting ? "border-amber-500/40 bg-amber-500/10" : "border-white/10 bg-surface-container-lowest"}`}
              >
                <span className={`px-2 py-0.5 rounded-sm text-[10px] uppercase tracking-wider ${awaiting ? "bg-amber-500/20 text-amber-400" : "bg-surface-container-highest text-on-surface-variant"}`}>{r.status}</span>
                <span className="text-xs text-on-surface-variant">R{r.round}</span>
                <span className="flex-1 truncate text-sm text-on-surface">{r.promptPreview}</span>
                {awaiting && <span className="text-[10px] uppercase tracking-wider text-amber-400">Answer</span>}
              </button>
              <button
                type="button"
                aria-label={`Actions for session ${r.id.substring(0, 8)}`}
                onClick={(e) => { const b = e.currentTarget.getBoundingClientRect(); onRowMenu(r, b.right, b.bottom); }}
                className="absolute top-1/2 -translate-y-1/2 right-1 px-1 text-on-surface-variant hover:text-on-surface"
              >
                <span className="material-symbols-outlined text-lg">more_vert</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function VerdictCard({ rating, decision, councilId }: { rating?: number; decision?: Decision; councilId?: string }) {
  const [notice, setNotice] = useState<string | null>(null);
  const handleExport = async () => {
    if (!councilId) return;
    try {
      await exportBrief("council", councilId);
    } catch (e) {
      console.error(e);
    }
  };
  const handleSendToNotebookLM = async () => {
    if (!councilId) return;
    try {
      setNotice(await sendBriefToNotebookLM("council", councilId));
    } catch (e) {
      console.error(e);
    }
  };

  return (
    <div className="flex flex-col gap-4 p-4 border border-white/10 rounded-sm">
      <div className="flex justify-between items-center w-full">
        <div className="flex items-center gap-4">
          <span className={`px-4 py-2 rounded-sm font-code-label text-lg font-bold uppercase ${
            decision === "GO" ? "bg-green-500/20 text-green-400"
            : decision === "NO-GO" ? "bg-red-500/20 text-red-400"
            : decision === "NEEDS-INFO" ? "bg-amber-500/20 text-amber-400"
            : "bg-surface-container-highest text-on-surface"
          }`}>
            {decision ?? "PENDING"}
          </span>
          <span className="px-3 py-1 bg-primary-fixed-dim/20 text-primary-fixed-dim rounded-sm font-code-label text-sm">
            {rating ?? 0}/10
          </span>
        </div>
        {councilId && (
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleSendToNotebookLM}
              className="px-2 py-0.5 rounded font-code-sm text-[10px] uppercase tracking-wider bg-primary/20 text-primary hover:bg-primary/30 border border-primary/30 cursor-pointer transition-colors"
            >
              Send to NotebookLM
            </button>
            <button
              type="button"
              onClick={handleExport}
              className="px-2 py-0.5 rounded font-code-sm text-[10px] uppercase tracking-wider bg-primary/20 text-primary hover:bg-primary/30 border border-primary/30 cursor-pointer transition-colors"
            >
              Export brief
            </button>
          </div>
        )}
      </div>
      {notice && (
        <div role="status" className="text-xs text-on-surface-variant">{notice}</div>
      )}
    </div>
  );
}

function PersonaCard({ name, text, onExpand }: { name: string; text?: string; onExpand: () => void }) {
  return (
    <div className="p-4 border border-white/10 rounded-sm space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="font-code-label text-xs uppercase tracking-widest text-on-surface-variant">{name}</div>
        {text && (
          <button
            type="button"
            aria-label={`Expand ${name}`}
            onClick={onExpand}
            className="text-[10px] uppercase tracking-wider text-primary-fixed-dim hover:underline cursor-pointer"
          >
            Expand
          </button>
        )}
      </div>
      {text ? (
        <Markdown text={text} className="text-sm text-on-surface space-y-2 leading-relaxed text-left" />
      ) : (
        <div className="text-sm text-on-surface-variant/50 animate-pulse">Deliberating...</div>
      )}
    </div>
  );
}

function ReadingOverlay({ title, text, onClose }: { title: string; text: string; onClose: () => void }) {
  return (
    <div role="dialog" aria-modal="true" aria-label={title} className="fixed inset-0 z-50 bg-background/95 overflow-y-auto">
      <div className="max-w-[72ch] mx-auto p-8 space-y-4">
        <div className="flex items-center justify-between">
          <div className="font-code-label text-sm uppercase tracking-widest text-on-surface-variant">{title}</div>
          <button
            type="button"
            aria-label="Collapse"
            onClick={onClose}
            className="text-xs uppercase tracking-widest text-on-surface-variant hover:text-on-surface cursor-pointer"
          >
            Collapse
          </button>
        </div>
        <Markdown text={text} className="text-base text-on-surface space-y-3 leading-relaxed text-left" />
      </div>
    </div>
  );
}

function ConsoleToggle({ show, onToggle, output, outputRef }: {
  show: boolean; onToggle: () => void; output: string;
  outputRef?: React.RefObject<HTMLPreElement | null>;
}) {
  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={onToggle}
        className="text-xs uppercase tracking-widest text-on-surface-variant hover:text-on-surface cursor-pointer"
      >
        {show ? "Hide console" : "Show console"}
      </button>
      {show && (
        <pre ref={outputRef} className="p-4 h-64 overflow-y-auto bg-background/80 text-code-sm text-on-surface font-mono whitespace-pre-wrap border border-white/10 rounded-lg">
          {output}
        </pre>
      )}
    </div>
  );
}
