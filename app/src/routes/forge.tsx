import { useState, useEffect, useRef } from "react";
import { api } from "../lib/api.js";

type Ticket = { id: string; title: string; status: string };
type Agent = { name: string; roles: string[] };
type Skill = { name: string };
type SandboxStatus = { exists: boolean; branch?: string; lastVerdict?: string };
type Diff = { diff: string };

export function ForgeScreen() {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [sandboxes, setSandboxes] = useState<Record<string, SandboxStatus>>({});
  const [ticketsError, setTicketsError] = useState("");
  const [selectedTicket, setSelectedTicket] = useState<Ticket | null>(null);

  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentsError, setAgentsError] = useState("");
  
  const [skills, setSkills] = useState<Skill[]>([]);

  const [planAgent, setPlanAgent] = useState("");
  const [workAgent, setWorkAgent] = useState("");
  const [reviewAgent, setReviewAgent] = useState("");
  const [extraPrompt, setExtraPrompt] = useState("");

  const [autocompleteOpen, setAutocompleteOpen] = useState(false);
  const [autocompleteFilter, setAutocompleteFilter] = useState("");
  const [autocompleteCursor, setAutocompleteCursor] = useState(0);

  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [runOutput, setRunOutput] = useState("");
  const [runStage, setRunStage] = useState("");
  const [runStatus, setRunStatus] = useState("");
  const [runError, setRunError] = useState("");
  const nextOffsetRef = useRef<number>(0);
  const outputRef = useRef<HTMLPreElement>(null);

  const [sandbox, setSandbox] = useState<SandboxStatus | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [sandboxError, setSandboxError] = useState("");
  const [viewDiff, setViewDiff] = useState(false);

  const loadTickets = async () => {
    try {
      const t = await api.get("/tickets") as Ticket[];
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
    loadTickets();
    api.get("/forge/agents")
       .then(a => {
         const ags = a as Agent[];
         setAgents(ags);
         const p = ags.find(x => x.roles.includes("plan"));
         if (p) setPlanAgent(p.name);
         const w = ags.find(x => x.roles.includes("work"));
         if (w) setWorkAgent(w.name);
         const r = ags.find(x => x.roles.includes("review"));
         if (r) setReviewAgent(r.name);
       })
       .catch((err: any) => setAgentsError(err.message || "Failed to load agents"));
       
    api.get("/forge/skills").then(s => setSkills(s as Skill[])).catch(() => {});
  }, []);

  const loadSandbox = async (ticketId: string) => {
    setSandboxError("");
    try {
      const s = await api.get(`/forge/tickets/${ticketId}/sandbox`) as SandboxStatus;
      setSandbox(s);
      if (!s.exists) {
        setDiff(null);
        setViewDiff(false);
      }
    } catch (e: any) {
      setSandboxError(e.message || "Failed to load sandbox");
    }
  };

  useEffect(() => {
    if (selectedTicket) {
      loadSandbox(selectedTicket.id);
      setRunOutput("");
      setRunStage("");
      setRunStatus("");
      setRunError("");
      setActiveRunId(null);
      nextOffsetRef.current = 0;
      setViewDiff(false);
    }
  }, [selectedTicket]);

  useEffect(() => {
    if (viewDiff && selectedTicket && !diff) {
      api.get(`/forge/tickets/${selectedTicket.id}/diff`)
         .then(d => setDiff((d as Diff).diff))
         .catch((e: any) => setSandboxError(e.message || "Failed to load diff"));
    }
  }, [viewDiff, selectedTicket, diff]);

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

  const handleRun = async () => {
    if (!selectedTicket) return;
    setRunError("");
    setRunOutput("");
    setRunStage("");
    setRunStatus("running");
    nextOffsetRef.current = 0;
    try {
      const res = await api.post("/forge/pipeline", {
        ticketId: selectedTicket.id,
        planAgent,
        workAgent,
        reviewAgent,
        extraPrompt
      }) as { runId: string };
      setActiveRunId(res.runId);
    } catch (e: any) {
      setRunError(e.message || "Pipeline start failed");
      setRunStatus("error");
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

  const filteredSkills = skills.filter(s => s.name.toLowerCase().includes(autocompleteFilter));

  return (
    <div className="flex h-[calc(100vh-64px)] overflow-hidden">
      <div className="w-80 border-r border-white/10 bg-surface-container/30 overflow-y-auto flex flex-col">
        <div className="p-4 border-b border-white/5">
          <h2 className="font-headline-sm text-on-surface font-bold">Forge Tickets</h2>
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
                    {planAgents.map(a => <option key={a.name} value={a.name}>{a.name}</option>)}
                  </select>
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-xs font-code-sm text-on-surface-variant uppercase">Work Model</label>
                  <select value={workAgent} onChange={e => setWorkAgent(e.target.value)} className="bg-surface-container/50 border border-white/10 rounded px-3 py-2 text-sm text-on-surface outline-none cursor-pointer">
                    {workAgents.map(a => <option key={a.name} value={a.name}>{a.name}</option>)}
                  </select>
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-xs font-code-sm text-on-surface-variant uppercase">Review Model</label>
                  <select value={reviewAgent} onChange={e => setReviewAgent(e.target.value)} className="bg-surface-container/50 border border-white/10 rounded px-3 py-2 text-sm text-on-surface outline-none cursor-pointer">
                    {reviewAgents.map(a => <option key={a.name} value={a.name}>{a.name}</option>)}
                  </select>
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

              <div className="flex items-center gap-4 pt-2">
                <button
                  onClick={handleRun}
                  disabled={!!activeRunId || !planAgent || !workAgent || !reviewAgent}
                  className="px-6 py-2 rounded bg-primary hover:brightness-110 text-on-primary text-sm font-bold uppercase tracking-widest transition-all disabled:opacity-50 cursor-pointer"
                >
                  Run pipeline
                </button>
                {activeRunId && (
                  <button
                    onClick={handleStop}
                    className="px-4 py-2 rounded bg-error/20 hover:bg-error/40 text-error text-sm font-bold uppercase tracking-widest transition-all cursor-pointer"
                  >
                    Stop
                  </button>
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
                      disabled={sandbox.lastVerdict !== "pass"}
                      className="px-4 py-2 rounded bg-green-500/20 hover:bg-green-500/40 text-green-400 text-sm font-bold uppercase transition-all disabled:opacity-50 cursor-pointer"
                    >
                      Promote
                    </button>
                    <button
                      onClick={handleDiscard}
                      className="px-4 py-2 rounded bg-error/20 hover:bg-error/40 text-error text-sm font-bold uppercase transition-all cursor-pointer"
                    >
                      Discard
                    </button>
                  </div>

                  {viewDiff && diff && (
                    <pre className="p-4 bg-background/80 text-code-sm text-on-surface font-mono whitespace-pre-wrap border border-white/10 rounded-lg overflow-x-auto">
                      {diff}
                    </pre>
                  )}
                </div>
              ) : (
                <div className="text-sm text-on-surface-variant italic">No active sandbox.</div>
              )}
            </div>

          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center text-on-surface-variant opacity-50 font-code-sm uppercase tracking-widest">
            Select a ticket to open the Forge
          </div>
        )}
      </div>
    </div>
  );
}
