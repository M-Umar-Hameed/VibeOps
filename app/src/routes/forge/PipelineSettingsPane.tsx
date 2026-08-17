import { PromptComposer } from "./PromptComposer.js";
import type { Agent, Skill, DoctorStatus, Ticket, ModelOption } from "./types.js";

type PipelineSettingsPaneProps = {
  agents: Agent[];
  skills: Skill[];
  doctorStatuses: Record<string, DoctorStatus>;
  runsData: unknown;
  tickets: Ticket[];
  planAgent: string;
  setPlanAgent: (v: string) => void;
  workAgent: string;
  setWorkAgent: (v: string) => void;
  reviewAgent: string;
  setReviewAgent: (v: string) => void;
  extraPrompt: string;
  onExtraPromptChange: (v: string) => void;
  activeRunId: string | null;
  isSubmitting: boolean;
  interruptedRun: boolean;
  runStage: string;
  runStatus: string;
  runError: string;
  onRun: (force?: boolean) => void;
  onStop: () => void;
  onResume: () => void;
};

export function PipelineSettingsPane({
  agents,
  skills,
  doctorStatuses,
  runsData,
  tickets,
  planAgent,
  setPlanAgent,
  workAgent,
  setWorkAgent,
  reviewAgent,
  setReviewAgent,
  extraPrompt,
  onExtraPromptChange,
  activeRunId,
  isSubmitting,
  interruptedRun,
  runStage,
  runStatus,
  runError,
  onRun,
  onStop,
  onResume,
}: PipelineSettingsPaneProps) {
  const planAgents = agents.filter(a => a.roles.includes("plan"));
  const workAgents = agents.filter(a => a.roles.includes("work"));
  const reviewAgents = agents.filter(a => a.roles.includes("review"));

  function dotColor(name: string): string {
    const s = doctorStatuses[name];
    if (!s) return "bg-white/20";
    return s.probe.ok ? "bg-green-500" : "bg-red-500";
  }

  function roleOptions(list: Agent[]): ModelOption[] {
    return list.flatMap(a =>
      a.models && a.models.length > 0
        ? a.models.map(m => ({ agent: a.name, model: m.name, label: `${a.name} - ${m.name}` }))
        : [{ agent: a.name, model: "", label: a.name }]
    );
  }

  const allRuns = Array.isArray(runsData) ? runsData : [];
  const running = allRuns.filter((r: any) => r.status === "running");
  const ticketTitle = (id: string) => tickets.find((t) => t.id === id)?.title ?? id;

  return (
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

      <PromptComposer
        extraPrompt={extraPrompt}
        onExtraPromptChange={onExtraPromptChange}
        skills={skills}
      />

      {running.length > 0 && (
        <div className="p-3 rounded-lg bg-surface-container border border-white/10 text-sm text-on-surface-variant mb-2">
          <div className="flex items-center gap-2 mb-1">
            <span className="w-2 h-2 rounded-full bg-secondary animate-pulse" />
            <span className="font-bold text-on-surface">{running.length} run{running.length > 1 ? "s" : ""} in flight</span>
          </div>
          <ul className="text-xs space-y-0.5">
            {running.map((r: any) => (
              <li key={r.id}>{ticketTitle(r.ticketId)} <span className="text-on-surface-variant/70">({r.stage})</span></li>
            ))}
          </ul>
          <p className="mt-2 text-[11px] text-on-surface-variant/70">Note: Concurrent runs multiply token spend and can hit provider rate limits.</p>
        </div>
      )}

      <div className="flex items-center flex-wrap gap-4 gap-y-2 pt-2">
        <button
          onClick={() => onRun()}
          disabled={!!activeRunId || isSubmitting || !planAgent || !workAgent || !reviewAgent}
          className="px-6 py-2 rounded bg-primary hover:brightness-110 text-on-primary text-sm font-bold uppercase tracking-widest transition-all disabled:opacity-50 cursor-pointer"
        >
          Run pipeline
        </button>
        {runStatus === "error" && runError.includes("token cap exceeded") && (
          <button
            onClick={() => onRun(true)}
            disabled={isSubmitting}
            className="px-4 py-2 rounded bg-amber-500/20 hover:bg-amber-500/40 text-amber-400 text-sm font-bold uppercase tracking-widest transition-all cursor-pointer"
          >
            Run anyway (force)
          </button>
        )}
        {activeRunId && (
          <button
            onClick={onStop}
            className="px-4 py-2 rounded bg-error/20 hover:bg-error/40 text-error text-sm font-bold uppercase tracking-widest transition-all cursor-pointer"
          >
            Stop
          </button>
        )}
        {interruptedRun && !activeRunId && (
          <div className="flex items-center gap-3">
            <span className="text-amber-400 text-sm font-medium">Run interrupted (app restarted)</span>
            <button
              onClick={onResume}
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
  );
}
