import { useState, useEffect, useRef } from "react";
import { api } from "../lib/api.js";
import { NotFoundError } from "../api/errors.js";
import { useProject } from "../context/project.js";
import { parseUnifiedDiff, type DiffFile } from "../lib/diff-parse.js";

type Ticket = { id: string; title: string; status: string };
type Agent = { name: string; roles: string[]; models?: { name: string }[] };
type Skill = { name: string };
type SandboxStatus = { exists: boolean; branch?: string; lastVerdict?: string };
type Diff = { diff: string };
type DoctorStatus = { name: string; binary: string; probe: { ok: boolean; error?: string }; auth: { known: boolean; connected: boolean | null }; lastChecked: string };
type SandboxActivityFile = { path: string; status: "A" | "M" | "D"; additions: number; deletions: number };
type SandboxActivityData = { stage: string; files: SandboxActivityFile[]; totalAdditions: number; totalDeletions: number; lastChangeAt: string };

export function ForgeScreen() {
  const { activeProjectId } = useProject();
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [sandboxes, setSandboxes] = useState<Record<string, SandboxStatus>>({});
  const [ticketsError, setTicketsError] = useState("");
  const [selectedTicket, setSelectedTicket] = useState<Ticket | null>(null);

  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentsError, setAgentsError] = useState("");
  const [doctorStatuses, setDoctorStatuses] = useState<Record<string, DoctorStatus>>({});
  
  const [skills, setSkills] = useState<Skill[]>([]);

  const [planAgent, setPlanAgent] = useState("auto::");
  const [workAgent, setWorkAgent] = useState("auto::");
  const [reviewAgent, setReviewAgent] = useState("auto::");
  const [extraPrompt, setExtraPrompt] = useState("");

  const [autocompleteOpen, setAutocompleteOpen] = useState(false);
  const [autocompleteFilter, setAutocompleteFilter] = useState("");
  const [autocompleteCursor, setAutocompleteCursor] = useState(0);

  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [runOutput, setRunOutput] = useState("");
  const [runStage, setRunStage] = useState("");
  const [runStatus, setRunStatus] = useState("");
  const [runError, setRunError] = useState("");
  const nextOffsetRef = useRef<number>(0);
  const outputRef = useRef<HTMLPreElement>(null);

  const [sandbox, setSandbox] = useState<SandboxStatus | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [diffParsed, setDiffParsed] = useState<DiffFile[]>([]);
  const [diffMode, setDiffMode] = useState<"sbs" | "unified" | "explain">("sbs");
  const [diffExplain, setDiffExplain] = useState<string | null>(null);
  const [explaining, setExplaining] = useState(false);
  const [selectedDiffFile, setSelectedDiffFile] = useState<DiffFile | null>(null);
  const [sandboxError, setSandboxError] = useState("");
  const [sandboxActivity, setSandboxActivity] = useState<SandboxActivityData | null>(null);
  const [selectedActivityFile, setSelectedActivityFile] = useState<string | null>(null);
  const [viewDiff, setViewDiff] = useState(false);

  const [interruptedRun, setInterruptedRun] = useState(false);
  const [ticketRunActive, setTicketRunActive] = useState(false);
  const [ticketRuns, setTicketRuns] = useState<any[]>([]);

  const [newTask, setNewTask] = useState("");
  const [newTaskError, setNewTaskError] = useState("");
  const [creating, setCreating] = useState(false);

  const createTask = async () => {
    const text = newTask.trim();
    if (!text) return;
    setCreating(true);
    setNewTaskError("");
    try {
      const projects = await api.get("/projects") as { id: string; key: string }[];
      const project = projects.find(p => p.key === "inbox") ?? projects[0];
      if (!project) throw new Error("no project available");
      const [title, ...rest] = text.split("\n");
      const t = await api.post("/tickets", {
        projectId: project.id, title: title.slice(0, 200), body: rest.join("\n"),
      }) as Ticket;
      setNewTask("");
      await loadTickets();
      setSelectedTicket(t);
    } catch (e: any) {
      setNewTaskError(e.message || "Failed to create task");
    } finally {
      setCreating(false);
    }
  };

  const loadTickets = async () => {
    try {
      const t = await api.get(activeProjectId ? `/tickets?projectId=${encodeURIComponent(activeProjectId)}` : "/tickets") as Ticket[];
      setTickets(t);
      const reviewIds = t.filter(x => x.status === "review").map(x => x.id);
      const sMap: Record<string, SandboxStatus> = {};
      for (const id of reviewIds) {
        try {
          const s = await api.get(`/forge/tickets/${id}/sandbox`) as SandboxStatus;
          sMap[id] = s;
        } catch (e) { /* ignore single sandbox error for list */ }
      }
      setSandboxes(sMap);
    } catch (e: any) {
      setTicketsError(e.message || "Failed to load tickets");
    }
  };

  useEffect(() => {
    api.get("/forge/agents")
       .then(a => {
         const ags = a as Agent[];
         setAgents(ags);
       })
       .catch((err: any) => setAgentsError(err.message || "Failed to load agents"));
       
    api.get("/forge/skills").then(s => setSkills(s as Skill[])).catch(() => {});

    api.get("/forge/doctor")
       .then(d => {
         const byName: Record<string, DoctorStatus> = {};
         for (const s of d as DoctorStatus[]) byName[s.name] = s;
         setDoctorStatuses(byName);
       })
       .catch(() => {}); // health dots are informational -- never block the panel
  }, []);

  useEffect(() => {
    loadTickets();
  }, [activeProjectId]);

  const loadSandbox = async (ticketId: string) => {
    setSandboxError("");
    try {
      const s = await api.get(`/forge/tickets/${ticketId}/sandbox`) as SandboxStatus;
      setSandbox(s);
      if (!s.exists) {
        setDiff(null);
        setDiffParsed([]);
        setDiffExplain(null);
        setViewDiff(false);
      }
    } catch (e: any) {
      setSandboxError(e.message || "Failed to load sandbox");
    }
  };

  useEffect(() => {
    if (selectedTicket) {
      loadSandbox(selectedTicket.id);
      api.get("/forge/runs").then((r: any) => {
        const tr = r.filter((run: any) => run.ticketId === selectedTicket.id);
        const sorted = tr.sort((a: any, b: any) => b.startedAt.localeCompare(a.startedAt));
        setTicketRuns(sorted);
        const latest = sorted[0];
        setInterruptedRun(latest?.status === "interrupted");
        setTicketRunActive(latest?.status === "running");
      }).catch(() => { setInterruptedRun(false); setTicketRunActive(false); setTicketRuns([]); });
      setRunOutput("");
      setRunStage("");
      setRunStatus("");
      setRunError("");
      setActiveRunId(null);
      setIsSubmitting(false);
      nextOffsetRef.current = 0;
      setViewDiff(false);
      setDiff(null);
      setDiffParsed([]);
      setDiffExplain(null);
      setSandboxActivity(null);
      setConfirmApprove(false); // never carry an armed confirm across tickets
    }
  }, [selectedTicket]);

  useEffect(() => {
    if (viewDiff && selectedTicket && diff === null) {
      const path = runStatus === "running"
        ? `/forge/tickets/${selectedTicket.id}/diff?worktree=true`
        : `/forge/tickets/${selectedTicket.id}/diff`;
      api.get(path)
         .then(d => {
           const text = (d as Diff).diff;
           setDiff(text);
           if (text) {
             const parsed = parseUnifiedDiff(text);
             setDiffParsed(parsed.files);
             setSelectedDiffFile(parsed.files[0] || null);
           }
         })
         .catch((e: any) => {
            if (e instanceof NotFoundError) {
              setDiff("");
            } else {
              setSandboxError(e.message || "Failed to load diff");
            }
         });
    }
  }, [viewDiff, selectedTicket, diff, runStatus]);

  // Once a targeted file diff finishes loading (triggered from the activity
  // panel), select it -- runs after the effect above's default files[0] pick.
  useEffect(() => {
    if (selectedActivityFile && diffParsed.length > 0) {
      const match = diffParsed.find(f => f.path === selectedActivityFile);
      if (match) setSelectedDiffFile(match);
      setSelectedActivityFile(null);
    }
  }, [selectedActivityFile, diffParsed]);

  const fetchExplain = async (fresh = false) => {
    if (!selectedTicket) return;
    setExplaining(true);
    setSandboxError("");
    try {
      const res = await api.post(`/forge/tickets/${selectedTicket.id}/explain-diff${fresh ? "?fresh=true" : ""}`);
      setDiffExplain((res as any).summary);
    } catch (e: any) {
      setSandboxError(e.message || "Failed to explain diff");
    } finally {
      setExplaining(false);
    }
  };

  useEffect(() => {
    if (!activeRunId) return;
    let running = true;
    const poll = async () => {
      try {
        const res = await api.get(`/forge/runs/${activeRunId}/output?after=${nextOffsetRef.current}`) as { chunk: string, next: number, stage: string, status: string };
        if (!running) return;
        
        if (res.chunk) {
          setRunOutput(prev => prev + res.chunk);
          setTimeout(() => {
            if (outputRef.current) {
              outputRef.current.scrollTop = outputRef.current.scrollHeight;
            }
          }, 10);
        }
        nextOffsetRef.current = res.next;
        setRunStage(res.stage);
        setRunStatus(res.status);
        if (res.status !== "running") {
          setActiveRunId(null);
          if (selectedTicket) loadSandbox(selectedTicket.id);
          loadTickets(); // ticket status moved server-side; refresh the columns
          
          // Refresh runs list to get updated history
          api.get("/forge/runs").then((r: any) => {
            const tr = r.filter((run: any) => run.ticketId === selectedTicket?.id);
            setTicketRuns(tr.sort((a: any, b: any) => b.startedAt.localeCompare(a.startedAt)));
          }).catch(() => {});
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

  const handleRun = async (force = false) => {
    if (!selectedTicket) return;
    setIsSubmitting(true);
    setRunError("");
    setRunOutput("");
    setRunStage("");
    setRunStatus("running");
    nextOffsetRef.current = 0;
    try {
      const parseSel = (s: string) => { const [agent, model] = s.split("::"); return { agent, model }; };
      const plan = parseSel(planAgent), work = parseSel(workAgent), review = parseSel(reviewAgent);
      const body: Record<string, any> = {
        ticketId: selectedTicket.id,
        planAgent: plan.agent, workAgent: work.agent, reviewAgent: review.agent,
        extraPrompt,
        force,
      };
      if (plan.model) body.planModel = plan.model;
      if (work.model) body.workModel = work.model;
      if (review.model) body.reviewModel = review.model;
      const res = await api.post("/forge/pipeline", body) as { runId: string };
      setActiveRunId(res.runId);
    } catch (e: any) {
      setRunError(e.message || "Pipeline start failed");
      setRunStatus("error");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleStop = async () => {
    if (activeRunId) {
      try {
        await api.post(`/forge/runs/${activeRunId}/stop`);
      } catch (e: any) {
        setRunError(e.message || "Failed to stop run");
      }
    }
  };

  const handleResume = async () => {
    if (!selectedTicket) return;
    setIsSubmitting(true);
    setRunError("");
    setRunOutput("");
    setRunStage("");
    setRunStatus("running");
    nextOffsetRef.current = 0;
    try {
      const res = await api.post(`/forge/tickets/${selectedTicket.id}/resume`) as { runId: string };
      setActiveRunId(res.runId);
      setInterruptedRun(false);
    } catch (e: any) {
      setRunError(e.message || "Pipeline resume failed");
      setRunStatus("error");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handlePromote = async () => {
    if (!selectedTicket) return;
    try {
      await api.post(`/forge/tickets/${selectedTicket.id}/promote`);
      await loadTickets();
      await loadSandbox(selectedTicket.id);
    } catch (e: any) {
      setSandboxError(e.message || "Failed to promote");
    }
  };

  const [confirmApprove, setConfirmApprove] = useState(false);
  const handleApprove = async () => {
    if (!selectedTicket) return;
    if (!confirmApprove) { setConfirmApprove(true); return; }
    setConfirmApprove(false);
    try {
      await api.post(`/forge/tickets/${selectedTicket.id}/approve`);
      await loadSandbox(selectedTicket.id);
    } catch (e: any) {
      setSandboxError(e.message || "Failed to approve");
    }
  };

  const handleDiscard = async () => {
    if (!selectedTicket) return;
    try {
      await api.post(`/forge/tickets/${selectedTicket.id}/discard`);
      await loadTickets();
      await loadSandbox(selectedTicket.id);
    } catch (e: any) {
      setSandboxError(e.message || "Failed to discard");
    }
  };

  const openActivityFile = (path: string) => {
    setDiffMode("sbs");
    setSelectedActivityFile(path);
    setDiff(null);
    setDiffParsed([]);
    setViewDiff(true);
  };

  const handlePromptChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setExtraPrompt(val);
    
    const cursor = e.target.selectionStart;
    const textBeforeCursor = val.slice(0, cursor);
    const words = textBeforeCursor.split(/\s+/);
    const lastWord = words[words.length - 1];
    
    if (lastWord.startsWith("/")) {
      setAutocompleteFilter(lastWord.slice(1).toLowerCase());
      setAutocompleteCursor(cursor);
      setAutocompleteOpen(true);
    } else {
      setAutocompleteOpen(false);
    }
  };

  const insertSkill = (skillName: string) => {
    const textBeforeCursor = extraPrompt.slice(0, autocompleteCursor);
    const textAfterCursor = extraPrompt.slice(autocompleteCursor);
    
    const lastSlashIndex = textBeforeCursor.lastIndexOf("/");
    
    const newText = textBeforeCursor.slice(0, lastSlashIndex) + "/" + skillName + " " + textAfterCursor;
    setExtraPrompt(newText);
    setAutocompleteOpen(false);
  };

  const groups = {
    open: tickets.filter(t => t.status === "open"),
    planned: tickets.filter(t => t.status === "planned"),
    in_progress: tickets.filter(t => t.status === "in_progress"),
    review: tickets.filter(t => t.status === "review"),
  };

  const planAgents = agents.filter(a => a.roles.includes("plan"));
  const workAgents = agents.filter(a => a.roles.includes("work"));
  const reviewAgents = agents.filter(a => a.roles.includes("review"));

  type ModelOption = { agent: string; model: string; label: string };
  function dotColor(name: string): string {
    const s = doctorStatuses[name];
    if (!s) return "bg-white/20"; // never checked
    return s.probe.ok ? "bg-green-500" : "bg-red-500";
  }

  function roleOptions(list: Agent[]): ModelOption[] {
    return list.flatMap(a =>
      a.models && a.models.length > 0
        ? a.models.map(m => ({ agent: a.name, model: m.name, label: `${a.name} - ${m.name}` }))
        : [{ agent: a.name, model: "", label: a.name }]
    );
  }

  const filteredSkills = skills.filter(s => s.name.toLowerCase().includes(autocompleteFilter));
  const runActiveForTicket = runStatus === "running" || ticketRunActive;

  return (
    // -m cancels the outlet padding so this screen owns its own scrolling —
    // otherwise the outer scroller and the columns double up scrollbars.
    <div className="absolute inset-0 flex overflow-hidden">
      <div className="w-80 border-r border-white/10 bg-surface-container/30 overflow-y-auto flex flex-col">
        <div className="p-4 border-b border-white/5 space-y-3">
          <div>
            <h2 className="font-headline-sm text-on-surface font-bold">Forge Tickets</h2>
            <p className="text-xs text-on-surface-variant/70 mt-1">Plan, run, and promote agent work per ticket.</p>
          </div>
          <div className="space-y-2">
            <textarea
              className="w-full bg-surface-container/50 border border-white/10 rounded px-3 py-2 text-sm text-on-surface outline-none min-h-[56px] resize-y"
              placeholder="New task: first line is the title, the rest is the brief."
              value={newTask}
              onChange={e => setNewTask(e.target.value)}
            />
            <button
              onClick={createTask}
              disabled={creating || !newTask.trim()}
              className="w-full px-3 py-2 rounded bg-surface-container-highest hover:bg-white/10 text-on-surface text-xs font-bold uppercase tracking-widest transition-all disabled:opacity-50 cursor-pointer"
            >
              Create task
            </button>
            {newTaskError && <div className="text-error text-xs">{newTaskError}</div>}
          </div>
        </div>
        {ticketsError && <div className="text-error text-xs p-4">{ticketsError}</div>}
        <div className="flex-1 p-4 space-y-6">
          {Object.entries(groups).map(([status, list]) => (
            <div key={status} className="space-y-2">
              <h3 className="font-code-label text-code-label text-on-surface-variant uppercase tracking-widest">{status}</h3>
              <div className="space-y-2">
                {list.map(t => (
                  <div
                    key={t.id}
                    onClick={() => setSelectedTicket(t)}
                    className={`p-3 rounded border transition-colors cursor-pointer ${selectedTicket?.id === t.id ? 'bg-primary-fixed-dim/10 border-primary-fixed-dim text-primary' : 'bg-surface-container-lowest border-white/5 text-on-surface hover:border-white/20'}`}
                  >
                    <div className="text-sm font-medium truncate">{t.title}</div>
                    {status === "review" && sandboxes[t.id]?.lastVerdict === "pass" && (
                      <div className="mt-2 text-[10px] font-code-label bg-green-500/20 text-green-400 px-2 py-1 rounded inline-block">PASS - awaiting promote</div>
                    )}
                  </div>
                ))}
                {list.length === 0 && <div className="text-xs text-on-surface-variant/50 italic">None</div>}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="flex-1 flex flex-col overflow-y-auto bg-surface-container-lowest">
        {selectedTicket ? (
          <div className="p-6 md:p-8 space-y-8 max-w-4xl mx-auto w-full">
            <div>
              <h2 className="font-headline-md text-primary font-bold">{selectedTicket.title}</h2>
              <div className="text-xs text-on-surface-variant font-code-sm mt-1">Ticket ID: {selectedTicket.id}</div>
            </div>

            {agentsError && <div className="text-error text-sm">{agentsError}</div>}
            
            <div className="glass-card rounded-xl border border-white/10 p-6 flex flex-col gap-4">
              <h3 className="font-headline-sm text-on-surface font-bold border-b border-white/5 pb-2">Pipeline Settings</h3>
              
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="flex flex-col gap-1">
                  <label className="text-xs font-code-sm text-on-surface-variant uppercase">Plan Model</label>
                  <select value={planAgent} onChange={e => setPlanAgent(e.target.value)} className="bg-surface-container/50 border border-white/10 rounded px-3 py-2 text-sm text-on-surface outline-none cursor-pointer">
                    <option value="auto::">Auto (routing strategy)</option>
                    {roleOptions(planAgents).map(o => (
                      <option key={`${o.agent}::${o.model}`} value={`${o.agent}::${o.model}`}>{o.label}</option>
                    ))}
                  </select>
                  <div className="flex flex-wrap gap-2 mt-1">
                    {planAgents.map(a => (
                      <span key={a.name} className="inline-flex items-center gap-1 text-[10px] text-on-surface-variant">
                        <span data-testid={`doctor-dot-${a.name}`} className={`w-1.5 h-1.5 rounded-full ${dotColor(a.name)}`} />
                        {a.name}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-xs font-code-sm text-on-surface-variant uppercase">Work Model</label>
                  <select value={workAgent} onChange={e => setWorkAgent(e.target.value)} className="bg-surface-container/50 border border-white/10 rounded px-3 py-2 text-sm text-on-surface outline-none cursor-pointer">
                    <option value="auto::">Auto (routing strategy)</option>
                    {roleOptions(workAgents).map(o => (
                      <option key={`${o.agent}::${o.model}`} value={`${o.agent}::${o.model}`}>{o.label}</option>
                    ))}
                  </select>
                  <div className="flex flex-wrap gap-2 mt-1">
                    {workAgents.map(a => (
                      <span key={a.name} className="inline-flex items-center gap-1 text-[10px] text-on-surface-variant">
                        <span data-testid={`doctor-dot-${a.name}`} className={`w-1.5 h-1.5 rounded-full ${dotColor(a.name)}`} />
                        {a.name}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-xs font-code-sm text-on-surface-variant uppercase">Review Model</label>
                  <select value={reviewAgent} onChange={e => setReviewAgent(e.target.value)} className="bg-surface-container/50 border border-white/10 rounded px-3 py-2 text-sm text-on-surface outline-none cursor-pointer">
                    <option value="auto::">Auto (routing strategy)</option>
                    {roleOptions(reviewAgents).map(o => (
                      <option key={`${o.agent}::${o.model}`} value={`${o.agent}::${o.model}`}>{o.label}</option>
                    ))}
                  </select>
                  <div className="flex flex-wrap gap-2 mt-1">
                    {reviewAgents.map(a => (
                      <span key={a.name} className="inline-flex items-center gap-1 text-[10px] text-on-surface-variant">
                        <span data-testid={`doctor-dot-${a.name}`} className={`w-1.5 h-1.5 rounded-full ${dotColor(a.name)}`} />
                        {a.name}
                      </span>
                    ))}
                  </div>
                </div>
              </div>

              <div className="flex flex-col gap-1 relative">
                <label className="text-xs font-code-sm text-on-surface-variant uppercase">Operator Prompt</label>
                <textarea
                  className="bg-surface-container/50 border border-white/10 rounded px-3 py-2 text-sm text-on-surface outline-none min-h-[80px] resize-y"
                  placeholder="Extra instructions for this run (optional). Type / for skills."
                  value={extraPrompt}
                  onChange={handlePromptChange}
                  onKeyDown={e => {
                    if (e.key === "Escape") setAutocompleteOpen(false);
                  }}
                />
                {autocompleteOpen && filteredSkills.length > 0 && (
                  <ul className="absolute bottom-full left-0 mb-1 w-64 max-h-48 overflow-y-auto bg-surface-container-highest border border-white/10 rounded shadow-lg z-10">
                    {filteredSkills.map(s => (
                      <li
                        key={s.name}
                        onClick={() => insertSkill(s.name)}
                        className="px-3 py-2 text-sm hover:bg-primary/20 hover:text-primary cursor-pointer text-on-surface transition-colors"
                      >
                        /{s.name}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="flex items-center flex-wrap gap-4 gap-y-2 pt-2">
                <button
                  onClick={() => handleRun()}
                  disabled={!!activeRunId || isSubmitting || !planAgent || !workAgent || !reviewAgent}
                  className="px-6 py-2 rounded bg-primary hover:brightness-110 text-on-primary text-sm font-bold uppercase tracking-widest transition-all disabled:opacity-50 cursor-pointer"
                >
                  Run pipeline
                </button>
                {runStatus === "error" && runError.includes("token cap exceeded") && (
                  <button
                    onClick={() => handleRun(true)}
                    disabled={isSubmitting}
                    className="px-4 py-2 rounded bg-amber-500/20 hover:bg-amber-500/40 text-amber-400 text-sm font-bold uppercase tracking-widest transition-all cursor-pointer"
                  >
                    Run anyway (force)
                  </button>
                )}
                {activeRunId && (
                  <button
                    onClick={handleStop}
                    className="px-4 py-2 rounded bg-error/20 hover:bg-error/40 text-error text-sm font-bold uppercase tracking-widest transition-all cursor-pointer"
                  >
                    Stop
                  </button>
                )}
                {interruptedRun && !activeRunId && (
                  <div className="flex items-center gap-3">
                    <span className="text-amber-400 text-sm font-medium">Run interrupted (app restarted)</span>
                    <button
                      onClick={handleResume}
                      disabled={isSubmitting}
                      className="px-4 py-2 rounded bg-amber-500/20 hover:bg-amber-500/40 text-amber-400 text-sm font-bold uppercase tracking-widest transition-all disabled:opacity-50 cursor-pointer"
                    >
                      Resume
                    </button>
                  </div>
                )}
                {runStage && (
                  <div className="flex items-center gap-2">
                    <span className="px-2 py-1 bg-surface-container border border-white/10 rounded text-[10px] font-code-label text-on-surface-variant uppercase">{runStage}</span>
                    <span className="px-2 py-1 bg-surface-container border border-white/10 rounded text-[10px] font-code-label text-on-surface-variant uppercase">{runStatus}</span>
                  </div>
                )}
              </div>
              {runError && <div className="text-error text-sm">{runError}</div>}
            </div>

            {(activeRunId || runOutput) && (
              <div className="glass-card rounded-xl border border-white/10 overflow-hidden flex flex-col">
                <div className="p-3 bg-surface-container/50 border-b border-white/5 flex items-center justify-between">
                  <span className="font-code-sm text-xs text-on-surface-variant uppercase tracking-widest">Live Console</span>
                  {activeRunId && <span className="w-2 h-2 rounded-full bg-secondary animate-pulse"></span>}
                </div>
                <pre ref={outputRef} className="p-4 h-64 overflow-y-auto bg-background/80 text-code-sm text-on-surface font-mono whitespace-pre-wrap custom-scrollbar">
                  {runOutput}
                </pre>
              </div>
            )}

            {runStatus === "running" && sandboxActivity && (
              <div className="glass-card rounded-xl border border-white/10 p-6 flex flex-col gap-4">
                <div className="flex items-center justify-between border-b border-white/5 pb-2">
                  <h3 className="font-headline-sm text-on-surface font-bold">Sandbox activity</h3>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-code-sm">
                      <span className="text-green-400">+{sandboxActivity.totalAdditions ?? 0}</span>{" "}
                      <span className="text-red-400">-{sandboxActivity.totalDeletions ?? 0}</span>
                    </span>
                    <span className="px-2 py-1 bg-surface-container border border-white/10 rounded text-[10px] font-code-label text-on-surface-variant uppercase">{sandboxActivity.stage}</span>
                  </div>
                </div>
                {(sandboxActivity.files ?? []).length === 0 ? (
                  <div className="text-sm text-on-surface-variant italic">
                    {sandboxActivity.stage === "plan" ? "planning, no file changes expected" : "no file changes yet"}
                  </div>
                ) : (
                  <div className="max-h-64 overflow-y-auto border border-white/10 rounded-lg bg-surface-container-lowest">
                    {sandboxActivity.files.map(f => (
                      <button
                        key={f.path}
                        onClick={() => openActivityFile(f.path)}
                        className="w-full text-left p-2 text-xs font-mono border-b border-white/5 truncate flex items-center justify-between text-on-surface hover:bg-white/5"
                      >
                        <span className="truncate" title={f.path}>{f.status} {f.path}</span>
                        <span className="flex-shrink-0 flex gap-1 ml-2">
                          {f.additions > 0 && <span className="text-green-400">+{f.additions}</span>}
                          {f.deletions > 0 && <span className="text-red-400">-{f.deletions}</span>}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="glass-card rounded-xl border border-white/10 p-6 flex flex-col gap-4">
              <h3 className="font-headline-sm text-on-surface font-bold border-b border-white/5 pb-2">Sandbox</h3>
              {sandboxError && <div className="text-error text-sm">{sandboxError}</div>}
              
              {sandbox?.exists ? (
                <div className="space-y-4">
                  <div className="flex items-center gap-4">
                    <span className="text-sm text-on-surface-variant"><span className="font-bold text-on-surface">Branch:</span> {sandbox.branch}</span>
                    <span className="text-sm text-on-surface-variant"><span className="font-bold text-on-surface">Verdict:</span> {sandbox.lastVerdict || "none"}</span>
                  </div>
                  
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => setViewDiff(!viewDiff)}
                      className="px-4 py-2 rounded bg-surface-container-highest hover:bg-white/10 text-on-surface text-sm transition-all cursor-pointer"
                    >
                      {viewDiff ? "Hide diff" : "View diff"}
                    </button>
                    <button
                      onClick={handlePromote}
                      disabled={sandbox.lastVerdict !== "pass" || runActiveForTicket}
                      title={
                        runActiveForTicket
                          ? "Pipeline run in progress for this ticket"
                          : sandbox.lastVerdict !== "pass"
                            ? "Needs a passing review — inspect the diff, then use Approve override"
                            : undefined
                      }
                      className="px-4 py-2 rounded bg-green-500/20 hover:bg-green-500/40 text-green-400 text-sm font-bold uppercase transition-all disabled:opacity-50 cursor-pointer"
                    >
                      Promote
                    </button>
                    {sandbox.lastVerdict !== "pass" && (
                      <button
                        onClick={handleApprove}
                        disabled={runActiveForTicket}
                        title={runActiveForTicket ? "Pipeline run in progress for this ticket" : undefined}
                        className="px-4 py-2 rounded bg-amber-500/20 hover:bg-amber-500/40 text-amber-400 text-sm font-bold uppercase transition-all disabled:opacity-50 cursor-pointer"
                      >
                        {confirmApprove ? "Confirm approve?" : "Approve override"}
                      </button>
                    )}
                    <button
                      onClick={handleDiscard}
                      className="px-4 py-2 rounded bg-error/20 hover:bg-error/40 text-error text-sm font-bold uppercase transition-all cursor-pointer"
                    >
                      Discard
                    </button>
                  </div>
                  {sandbox.lastVerdict !== "pass" && (
                    <div className="text-xs text-on-surface-variant">
                      Promote unlocks after a passing review. Approve override records YOUR passing review on the ticket, then Promote merges.
                    </div>
                  )}

                  {viewDiff && diff === "" && (
                    <div className="p-4 bg-background/80 text-on-surface-variant italic border border-white/10 rounded-lg text-sm text-center">
                      No sandbox / no changes yet
                    </div>
                  )}

                  {viewDiff && diff && diff !== "" && (
                    <div className="flex flex-col border border-white/10 rounded-lg overflow-hidden bg-background/50">
                      <div className="flex items-center gap-1 border-b border-white/10 bg-surface-container-highest p-1">
                        <button onClick={() => setDiffMode("sbs")} className={`px-3 py-1.5 text-xs font-bold uppercase rounded ${diffMode === "sbs" ? "bg-primary text-on-primary" : "text-on-surface hover:bg-white/5"}`}>Side-by-side</button>
                        <button onClick={() => setDiffMode("unified")} className={`px-3 py-1.5 text-xs font-bold uppercase rounded ${diffMode === "unified" ? "bg-primary text-on-primary" : "text-on-surface hover:bg-white/5"}`}>Unified</button>
                        <button onClick={() => { setDiffMode("explain"); if (!diffExplain && !explaining) fetchExplain(); }} className={`px-3 py-1.5 text-xs font-bold uppercase rounded ${diffMode === "explain" ? "bg-primary text-on-primary" : "text-on-surface hover:bg-white/5"}`}>Explain</button>
                      </div>

                      {diffMode === "explain" && (
                        <div className="p-4 flex flex-col gap-4">
                          <div className="flex items-center justify-between">
                            <h4 className="font-headline-sm font-bold text-on-surface">Plain-English Summary</h4>
                            <button onClick={() => fetchExplain(true)} disabled={explaining} className="px-3 py-1 rounded bg-surface-container hover:bg-white/10 text-xs font-bold uppercase disabled:opacity-50">Regenerate</button>
                          </div>
                          {explaining && !diffExplain ? (
                            <div className="text-sm text-on-surface-variant italic animate-pulse">Generating summary...</div>
                          ) : diffExplain ? (
                            <div className="text-sm text-on-surface whitespace-pre-wrap">{diffExplain}</div>
                          ) : (
                            <div className="text-sm text-error">Failed to load summary.</div>
                          )}
                        </div>
                      )}

                      {diffMode === "unified" && (
                        <pre className="p-4 text-code-sm text-on-surface font-mono whitespace-pre-wrap overflow-x-auto">
                          {diff}
                        </pre>
                      )}

                      {diffMode === "sbs" && (
                        <div className="flex flex-col md:flex-row h-[600px] overflow-hidden">
                          <div className="w-full md:w-64 border-r border-white/10 overflow-y-auto bg-surface-container-lowest">
                            {diffParsed.map(f => (
                              <button
                                key={f.path}
                                onClick={() => setSelectedDiffFile(f)}
                                className={`w-full text-left p-2 text-xs font-mono border-b border-white/5 truncate flex items-center justify-between ${selectedDiffFile?.path === f.path ? "bg-primary/20 text-primary" : "text-on-surface hover:bg-white/5"}`}
                              >
                                <span className="truncate" title={f.path}>{f.path.split("/").pop()}</span>
                                <span className="flex-shrink-0 flex gap-1 ml-2">
                                  {f.additions > 0 && <span className="text-green-400">+{f.additions}</span>}
                                  {f.deletions > 0 && <span className="text-red-400">-{f.deletions}</span>}
                                </span>
                              </button>
                            ))}
                          </div>
                          <div className="flex-1 overflow-y-auto bg-background p-2 font-mono text-code-sm">
                            {selectedDiffFile ? (
                              <div className="space-y-4">
                                <div className="text-xs text-on-surface-variant pb-2 border-b border-white/10">{selectedDiffFile.path}</div>
                                {selectedDiffFile.binary ? (
                                  <div className="text-on-surface-variant italic text-center p-8">Binary file differs</div>
                                ) : selectedDiffFile.hunks.length === 0 ? (
                                  <div className="text-on-surface-variant italic text-center p-8">Empty file or no hunks</div>
                                ) : (
                                  selectedDiffFile.hunks.map((h, i) => (
                                    <div key={i} className="mb-4">
                                      <div className="text-blue-400 bg-blue-900/20 px-2 py-1 select-none">{h.header}</div>
                                      <div className="grid grid-cols-[30px_30px_1fr_1fr] md:grid-cols-[40px_40px_1fr_1fr] bg-surface-container-lowest border border-white/5">
                                        {h.rows.map((r, j) => (
                                          <div key={j} className={`contents ${r.type === "add" ? "bg-green-500/10 text-green-300" : r.type === "del" ? "bg-red-500/10 text-red-300" : "text-on-surface hover:bg-white/5"}`}>
                                            <div className="text-right pr-2 select-none border-r border-white/10 opacity-50">{r.left || ""}</div>
                                            <div className="text-right pr-2 select-none border-r border-white/10 opacity-50">{r.right || ""}</div>
                                            <div className="col-span-2 px-2 whitespace-pre overflow-x-auto">{r.text}</div>
                                          </div>
                                        ))}
                                      </div>
                                    </div>
                                  ))
                                )}
                              </div>
                            ) : (
                              <div className="flex h-full items-center justify-center text-on-surface-variant italic">Select a file to view</div>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ) : (
                <div className="p-8 text-center text-on-surface-variant border border-white/10 rounded-lg bg-surface-container-highest/50 border-dashed">
                  Sandbox not created yet. Run the pipeline to generate code.
                </div>
              )}
            </div>

            {ticketRuns.length > 0 && (
              <div className="glass-card rounded-xl border border-white/10 p-6 flex flex-col gap-4">
                <h3 className="font-headline-sm text-on-surface font-bold border-b border-white/5 pb-2">Run History</h3>
                <div className="space-y-2">
                  {ticketRuns.map(run => (
                    <div key={run.id} className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 border border-white/5 bg-surface-container-lowest rounded-lg p-3">
                      <div className="flex flex-col gap-1">
                        <div className="flex items-center gap-2">
                          <span className="font-code-sm text-sm text-on-surface">Run {run.id.substring(0, 8)}</span>
                          <span className={`px-2 py-0.5 rounded text-[10px] font-code-label uppercase ${run.status === 'passed' ? 'bg-green-500/20 text-green-400' : run.status === 'failed' ? 'bg-red-500/20 text-red-400' : 'bg-surface-container text-on-surface-variant'}`}>
                            {run.status}
                          </span>
                        </div>
                        <span className="text-xs text-on-surface-variant/70 font-code-sm">
                          {new Date(run.startedAt).toLocaleString()}
                        </span>
                      </div>
                      <div className="flex flex-wrap items-center gap-2 text-right">
                        <span className="text-xs text-on-surface-variant">
                          Plan: {run.agents?.plan || 'auto'} | Work: {run.agents?.work || 'auto'} | Review: {run.agents?.review || 'auto'}
                        </span>
                        {run.modelVerified === false ? (
                          <span className="px-2 py-0.5 border border-amber-500/30 bg-amber-500/10 text-amber-500 text-[10px] rounded font-code-label uppercase" title="Executed model did not match requested tier">
                            Mismatch
                          </span>
                        ) : run.modelVerified === true ? (
                          <span className="px-2 py-0.5 border border-green-500/30 bg-green-500/10 text-green-400 text-[10px] rounded font-code-label uppercase">
                            Verified
                          </span>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : tickets.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
            <span className="material-symbols-outlined text-6xl text-on-surface-variant/30 mb-6">construction</span>
            <div className="text-on-surface-variant max-w-md">
              <p className="mb-6 text-lg">The Forge is where autonomous agents write and review code for your tickets.</p>
              <button onClick={() => document.querySelector('textarea')?.focus()} className="bg-primary text-on-primary px-6 py-2 rounded font-bold uppercase tracking-widest cursor-pointer hover:brightness-110">Create a task to start</button>
            </div>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center text-on-surface-variant/50">Select a ticket to enter the Forge</div>
        )}
      </div>
    </div>
  );
}
