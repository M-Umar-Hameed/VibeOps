import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { projects } from "../api/projects.js";
import { actors } from "../api/actors.js";
import { tickets } from "../api/tickets.js";
import { Avatar } from "../components/Avatar.js";
import { api } from "../lib/api.js";
import { useProject } from "../context/project.js";

export function CreateScreen() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const { activeProjectId } = useProject();
  const [mode, setMode] = useState<"council" | "quick">("council");
  const pq = useQuery({ queryKey: ["projects"], queryFn: projects.list });
  const aq = useQuery({ queryKey: ["actors"], queryFn: actors.list });
  const [projectId, setProjectId] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [priority, setPriority] = useState("normal");
  const [assigneeId, setAssigneeId] = useState("");
  const [requiresVerification, setRequiresVerification] = useState(false);

  const createTicket = useMutation({
    mutationFn: () => tickets.create({ projectId, title, body, priority, assigneeId: assigneeId || undefined, requiresVerification }),
    onSuccess: (t) => { qc.invalidateQueries({ queryKey: ["tickets"] }); nav({ to: "/tickets/$id", params: { id: t.id } }); },
  });

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
      
      <form className="space-y-8" onSubmit={(e) => { e.preventDefault(); createTicket.mutate(); }}>
        {/* Title */}
        <div className="space-y-2 group">
          <label className="font-code-sm text-on-surface-variant uppercase tracking-widest flex items-center gap-2">
            <span className="w-1 h-1 bg-primary-fixed-dim rounded-full"></span>
            Title_String
          </label>
          <div className="relative flex items-center">
            <span className="absolute left-4 font-code-label text-primary-fixed-dim opacity-70 font-bold">&gt;</span>
            <input 
              className="w-full bg-surface-container-lowest border border-white/5 focus:border-primary-fixed-dim focus:ring-1 focus:ring-primary-fixed-dim/20 pl-10 pr-4 py-4 font-code-label text-primary-fixed-dim rounded-sm transition-all duration-300 outline-none" 
              placeholder="Define process scope..." 
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
            />
          </div>
        </div>

        {/* Priority & Assignee & Project Row */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* Project */}
          <div className="space-y-2">
            <label className="font-code-sm text-on-surface-variant uppercase tracking-widest flex items-center gap-2">
              <span className="w-1 h-1 bg-primary-fixed-dim rounded-full"></span>
              Project_ID
            </label>
            <div className="relative">
              <select 
                className="w-full bg-surface-container-lowest border border-white/5 focus:border-primary-fixed-dim focus:ring-1 focus:ring-primary-fixed-dim/20 px-4 py-4 font-code-label text-on-surface rounded-sm appearance-none outline-none cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                disabled={!!activeProjectId}
                required
              >
                <option className="bg-surface text-on-surface-variant" value="">Select target namespace</option>
                {pq.data?.map((p) => <option className="bg-surface" key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <span className="absolute right-4 top-1/2 -translate-y-1/2 material-symbols-outlined pointer-events-none opacity-50">expand_more</span>
            </div>
          </div>

          {/* Priority */}
          <div className="space-y-2">
            <label className="font-code-sm text-on-surface-variant uppercase tracking-widest flex items-center gap-2">
              <span className="w-1 h-1 bg-primary-fixed-dim rounded-full"></span>
              Priority_Level
            </label>
            <div className="relative">
              <select 
                className="w-full bg-surface-container-lowest border border-white/5 focus:border-primary-fixed-dim focus:ring-1 focus:ring-primary-fixed-dim/20 px-4 py-4 font-code-label text-on-surface rounded-sm appearance-none outline-none cursor-pointer"
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
              >
                <option className="bg-surface text-on-surface-variant" value="low">LOW_LATENCY</option>
                <option className="bg-surface text-primary-fixed-dim" value="normal">NORMAL_FLOW</option>
                <option className="bg-surface text-secondary-fixed-dim" value="high">HIGH_PRIORITY</option>
                <option className="bg-surface text-error" value="critical">CRITICAL_BLOCKER</option>
              </select>
              <span className="absolute right-4 top-1/2 -translate-y-1/2 material-symbols-outlined pointer-events-none opacity-50">expand_more</span>
            </div>
          </div>

          {/* Assignee */}
          <div className="space-y-2">
            <label className="font-code-sm text-on-surface-variant uppercase tracking-widest flex items-center gap-2">
              <span className="w-1 h-1 bg-primary-fixed-dim rounded-full"></span>
              Operator_Assign
            </label>
            <div className="relative flex items-center gap-2">
              <Avatar actorId={assigneeId} size="md" />
              <div className="relative flex-1">
                <select 
                  className="w-full bg-surface-container-lowest border border-white/5 focus:border-primary-fixed-dim focus:ring-1 focus:ring-primary-fixed-dim/20 px-4 py-4 font-code-label text-on-surface rounded-sm appearance-none outline-none cursor-pointer"
                  value={assigneeId}
                  onChange={(e) => setAssigneeId(e.target.value)}
                >
                  <option className="bg-surface" value="">@unassigned_node</option>
                  {aq.data?.map((a) => <option className="bg-surface" key={a.id} value={a.id}>@{a.name}</option>)}
                </select>
                <span className="absolute right-4 top-1/2 -translate-y-1/2 material-symbols-outlined pointer-events-none opacity-50">expand_more</span>
              </div>
            </div>
          </div>
        </div>

        {/* Description */}
        <div className="space-y-2">
          <div className="flex justify-between items-center">
            <label className="font-code-sm text-on-surface-variant uppercase tracking-widest flex items-center gap-2">
              <span className="w-1 h-1 bg-primary-fixed-dim rounded-full"></span>
              Sys_Description
            </label>
            <span className="font-code-sm text-primary-fixed-dim/40 text-[10px]">MD_SUPPORTED</span>
          </div>
          <div className="relative">
            <textarea 
              className="w-full bg-surface-container-lowest border border-white/5 focus:border-primary-fixed-dim focus:ring-1 focus:ring-primary-fixed-dim/20 p-6 font-code-label text-on-surface rounded-sm transition-all duration-300 resize-y outline-none" 
              placeholder="Describe the operational anomaly or requirement here..." 
              rows={6}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            ></textarea>
          </div>
        </div>

        {/* Verification */}
        <div className="space-y-2">
          <label className="flex items-center gap-2 font-code-sm text-on-surface-variant cursor-pointer">
            <input type="checkbox" checked={requiresVerification} onChange={(e) => setRequiresVerification(e.target.checked)} className="w-4 h-4 rounded border-white/10 bg-surface-container-lowest text-primary-fixed-dim focus:ring-primary-fixed-dim focus:ring-1 outline-none" />
            Require verification to close
          </label>
        </div>

        {/* Footer Actions */}
        <div className="flex flex-col sm:flex-row items-center justify-between gap-6 pt-6 border-t border-white/5">
          <button 
            type="button"
            onClick={() => nav({ to: "/" })}
            className="group flex items-center gap-2 px-6 py-2 text-on-surface-variant hover:text-error transition-all duration-300 cursor-pointer"
          >
            <span className="material-symbols-outlined text-lg group-hover:rotate-90 transition-transform">close</span>
            <span className="font-code-label text-code-label tracking-widest uppercase">ABORT_CANCEL</span>
          </button>
          
          <button 
            type="submit"
            disabled={!projectId || !title || createTicket.isPending}
            className="w-full sm:w-auto px-10 py-4 bg-primary-fixed-dim text-on-primary font-code-label text-code-label font-bold uppercase tracking-[0.15em] rounded-sm neon-glow-primary hover:opacity-90 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-3 cursor-pointer"
          >
            <span className="material-symbols-outlined">bolt</span>
            EXECUTE_SUBMIT
          </button>
        </div>
      </form>

      <div className="absolute bottom-4 left-8 pointer-events-none opacity-20">
        <span className="font-code-sm text-[9px] uppercase tracking-tighter">TS: {new Date().toISOString().substring(0, 19).replace('T', ' ')}</span>
      </div>
        </div>
      )}
    </div>
  );
}

type Project = { id: string; name: string };
type CouncilStatus = "idle" | "running" | "awaiting-answers" | "decided" | "consumed" | "failed";
type Decision = "GO" | "NO-GO" | "NEEDS-INFO";

function CouncilPanel({ projects, activeProjectId, nav }: { projects: Project[]; activeProjectId: string | null; nav: ReturnType<typeof useNavigate> }) {
  const [ideaPrompt, setIdeaPrompt] = useState("");
  const [councilProjectId, setCouncilProjectId] = useState("");

  useEffect(() => {
    if (activeProjectId) setCouncilProjectId(activeProjectId);
  }, [activeProjectId]);
  const [councilId, setCouncilId] = useState<string | null>(null);
  const [councilStatus, setCouncilStatus] = useState<CouncilStatus>("idle");
  const [councilOutput, setCouncilOutput] = useState("");
  const [councilRating, setCouncilRating] = useState<number | undefined>(undefined);
  const [councilDecision, setCouncilDecision] = useState<Decision | undefined>(undefined);
  const [councilQuestions, setCouncilQuestions] = useState<string[]>([]);
  // Title is shown inside the spec preview; only the setter side effects matter.
  const [, setCouncilTitle] = useState("");
  const [councilSpec, setCouncilSpec] = useState("");
  const [answers, setAnswers] = useState<string[]>([]);
  const [forceCreate, setForceCreate] = useState(false);
  const [requiresVerification, setRequiresVerification] = useState(false);
  const [evaluating, setEvaluating] = useState(false);
  const [submittingAnswers, setSubmittingAnswers] = useState(false);
  const [creatingTicket, setCreatingTicket] = useState(false);
  const [councilError, setCouncilError] = useState("");
  const nextOffsetRef = useRef(0);
  const outputRef = useRef<HTMLPreElement>(null);

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
          status: CouncilStatus; rating?: number; decision?: Decision;
          questions?: string[]; title?: string; spec?: string;
        };
        if (!running) return;
        setCouncilStatus(res.status);
        if (res.rating !== undefined) setCouncilRating(res.rating);
        if (res.decision !== undefined) setCouncilDecision(res.decision);
        if (res.questions !== undefined) {
          setCouncilQuestions(res.questions);
          setAnswers(res.questions.map(() => ""));
        }
        if (res.title !== undefined) setCouncilTitle(res.title);
        if (res.spec !== undefined) setCouncilSpec(res.spec);
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

  const handleEvaluate = async () => {
    const prompt = ideaPrompt.trim();
    if (!prompt || !councilProjectId) return;
    setEvaluating(true);
    setCouncilError("");
    try {
      const res = await api.post("/council/evaluate", { prompt, projectId: councilProjectId }) as { councilId: string };
      setCouncilId(res.councilId);
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
      nav({ to: "/tickets/$id", params: { id: ticket.id } });
    } catch (e: any) {
      setCouncilError(e.message || "Failed to create ticket");
    } finally {
      setCreatingTicket(false);
    }
  };

  const handleStartOver = () => {
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

  return (
    <div className="glass-card rounded-lg p-8 relative overflow-hidden space-y-6">
      {councilStatus === "idle" && (
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
      )}

      {councilId && councilStatus === "running" && (
        <div className="glass-card rounded-xl border border-white/10 overflow-hidden flex flex-col">
          <div className="p-3 bg-surface-container/50 border-b border-white/5 text-xs uppercase tracking-widest text-on-surface-variant">Live Console</div>
          <pre ref={outputRef} className="p-4 h-64 overflow-y-auto bg-background/80 text-code-sm text-on-surface font-mono whitespace-pre-wrap">
            {councilOutput}
          </pre>
        </div>
      )}

      {councilId && councilStatus === "awaiting-answers" && (
        <div className="space-y-4">
          <VerdictCard rating={councilRating} decision={councilDecision} councilId={councilId} />
          <details>
            <summary className="cursor-pointer text-xs uppercase tracking-widest text-on-surface-variant">Full console</summary>
            <pre className="p-4 h-64 overflow-y-auto bg-background/80 text-code-sm text-on-surface font-mono whitespace-pre-wrap">{councilOutput}</pre>
          </details>
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
          <pre className="p-4 h-64 overflow-y-auto bg-background/80 text-code-sm text-on-surface font-mono whitespace-pre-wrap border border-white/10 rounded-lg">{councilSpec}</pre>
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
            Create ticket
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
    </div>
  );
}

function VerdictCard({ rating, decision, councilId }: { rating?: number; decision?: Decision; councilId?: string }) {
  const handleExport = async () => {
    if (!councilId) return;
    try {
      const { getSettings } = await import("../settings.js");
      const { baseUrl, apiKey } = await getSettings();
      const res = await fetch(`${baseUrl}/export/brief?kind=council&id=${councilId}`, {
        headers: { Authorization: `Bearer ${apiKey}` }
      });
      if (!res.ok) throw new Error("Export failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const disp = res.headers.get("Content-Disposition");
      let filename = `council-${councilId.substring(0,8)}.md`;
      if (disp && disp.includes("filename=")) {
        filename = disp.split("filename=")[1].replace(/"/g, "");
      }
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error(e);
    }
  };

  return (
    <div className="flex flex-col gap-4 p-4 border border-white/10 rounded-sm">
      <div className="flex justify-between items-center w-full">
        <div className="flex items-center gap-4">
          <span className="px-3 py-1 bg-primary-fixed-dim/20 text-primary-fixed-dim rounded-sm font-code-label text-sm">
            {rating ?? 0}/10
          </span>
          <span className="px-3 py-1 bg-surface-container-highest text-on-surface rounded-sm font-code-label text-sm uppercase">
            {decision ?? "PENDING"}
          </span>
        </div>
        {councilId && (
          <div className="flex items-center gap-3">
            <a href="https://notebooklm.google.com/" target="_blank" rel="noreferrer" className="text-primary-fixed-dim hover:underline font-code-sm text-[10px] uppercase tracking-wider">
              Open NotebookLM
            </a>
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
    </div>
  );
}
