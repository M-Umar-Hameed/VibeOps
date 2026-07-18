import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { tickets } from "../api/tickets.js";
import { projects } from "../api/projects.js";
import { actors } from "../api/actors.js";
import { system } from "../api/system.js";
import { Avatar } from "../components/Avatar.js";
import { StatusBadge } from "../components/StatusBadge.js";
import { useProject } from "../context/project.js";

export function ListScreen() {
  const { activeProjectId } = useProject();
  const [projectId, setProjectId] = useState<string>("");
  const [status, setStatus] = useState<string>("");
  const [q, setQ] = useState("");
  
  const projQ = useQuery({ queryKey: ["projects"], queryFn: projects.list });
  const actQ = useQuery({ queryKey: ["actors"], queryFn: actors.list });
  
  const effectiveProjectId = activeProjectId ?? (projectId || undefined);
  
  const listQ = useQuery({
    queryKey: ["tickets", { activeProjectId, projectId, status, q }],
    queryFn: () => q ? tickets.search(q) : tickets.list({ projectId: effectiveProjectId, status: status || undefined }),
  });
  
  const actorName = (id: string | null) => actQ.data?.find((a) => a.id === id)?.name ?? "Unassigned";

  const metricsQ = useQuery({ queryKey: ["systemMetrics"], queryFn: system.getMetrics, refetchInterval: 10000 });
  const logsQ = useQuery({ queryKey: ["systemLogs"], queryFn: system.getLogs, refetchInterval: 5000 });
  const statusQ = useQuery({ queryKey: ["systemStatus"], queryFn: system.getStatus });

  return (
    <>
      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-4 mb-4">
        <div className="relative w-full sm:w-auto">
          <select 
            className="w-full bg-surface-container-highest border border-white/10 rounded px-3 py-1.5 pr-8 text-xs text-on-surface appearance-none outline-none cursor-pointer focus:border-primary-fixed-dim disabled:opacity-50 disabled:cursor-not-allowed" 
            value={activeProjectId ?? projectId} 
            onChange={(e) => setProjectId(e.target.value)}
            disabled={!!activeProjectId}
          >
            <option value="">All Projects</option>
            {projQ.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <span className="absolute right-2 top-1/2 -translate-y-1/2 material-symbols-outlined text-sm opacity-50 pointer-events-none">expand_more</span>
        </div>
        <div className="relative w-full sm:w-auto">
          <select className="w-full bg-surface-container-highest border border-white/10 rounded px-3 py-1.5 pr-8 text-xs text-on-surface appearance-none outline-none cursor-pointer focus:border-primary-fixed-dim" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Any Status</option><option value="open">Open</option><option value="in_progress">In Progress</option><option value="closed">Closed</option>
          </select>
          <span className="absolute right-2 top-1/2 -translate-y-1/2 material-symbols-outlined text-sm opacity-50 pointer-events-none">expand_more</span>
        </div>
        <input 
          className="bg-surface-container-highest border border-white/10 rounded px-3 py-1.5 text-xs text-on-surface placeholder-on-surface-variant/50 w-full sm:flex-1 sm:max-w-xs" 
          placeholder="Filter active work orders..." 
          value={q} 
          onChange={(e) => setQ(e.target.value)} 
        />
      </div>

      <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 md:gap-gutter mb-4 md:mb-gutter">
        <div className="glass-card p-6 flex flex-col justify-between group hover:border-primary-fixed-dim/30 transition-all glow-blue">
          <div className="flex justify-between items-start mb-4">
            <span className="text-on-surface-variant font-code-label text-xs uppercase tracking-widest">Active Work Orders</span>
            <span className="material-symbols-outlined text-primary-fixed-dim">confirmation_number</span>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-4xl font-headline-lg text-primary-fixed-dim font-bold tabular-nums">{listQ.data?.length ?? "--"}</span>
            <span className="text-xs text-on-surface-variant/60 font-code-sm">Matching filter</span>
          </div>
        </div>

        <div className="glass-card p-6 flex flex-col justify-between group hover:border-secondary-container/30 transition-all glow-purple">
          <div className="flex justify-between items-start mb-4">
            <span className="text-on-surface-variant font-code-label text-xs uppercase tracking-widest">System Uptime</span>
            <span className="material-symbols-outlined text-secondary">cloud_done</span>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-4xl font-headline-lg text-secondary font-bold tabular-nums">{metricsQ.data?.uptime ?? "--"}%</span>
            <span className="text-xs text-on-surface-variant/60 font-code-sm">Stable node cluster</span>
          </div>
        </div>

        <div className="glass-card p-6 flex flex-col justify-between group hover:border-primary-fixed-dim/30 transition-all glow-blue">
          <div className="flex justify-between items-start mb-4">
            <span className="text-on-surface-variant font-code-label text-xs uppercase tracking-widest">Avg. Ping</span>
            <span className="material-symbols-outlined text-primary">speed</span>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-4xl font-headline-lg text-primary font-bold tabular-nums">{metricsQ.data?.ping ?? "--"}ms</span>
            <span className="text-xs text-on-surface-variant/60 font-code-sm">LHR-1 Gateway</span>
          </div>
        </div>
      </section>

      <section className="glass-card overflow-hidden mb-4 md:mb-gutter">
        <div className="px-4 md:px-6 py-4 border-b border-white/5">
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
            <div>
              <h3 className="font-headline-sm md:font-headline-md text-headline-sm md:text-headline-md text-primary">Active Work Orders</h3>
              <p className="text-sm text-on-surface-variant/70 mt-1">Track work orders from open through promoted.</p>
            </div>
            <Link to="/create" className="bg-primary-fixed-dim text-on-primary-fixed px-4 py-2 font-code-label text-code-label rounded-lg flex items-center gap-2 hover:brightness-110 active:scale-95 transition-all shadow-lg shadow-primary-fixed-dim/20 cursor-pointer inline-flex w-full sm:w-auto justify-center">
              <span className="material-symbols-outlined text-sm">add</span>
              NEW_WORK_ORDER
            </Link>
          </div>
        </div>
        <div className="overflow-x-auto w-full">
          <table className="w-full text-left font-body-sm text-on-surface-variant min-w-[800px]">
            <thead className="bg-white/[0.02] font-code-label text-xs uppercase tracking-widest">
              <tr>
                <th className="px-6 py-4 font-medium">ID</th>
                <th className="px-6 py-4 font-medium">Subject</th>
                <th className="px-6 py-4 font-medium">Priority</th>
                <th className="px-6 py-4 font-medium">Status</th>
                <th className="px-6 py-4 font-medium">Assignee</th>
                <th className="px-6 py-4 font-medium"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {listQ.isError && (
                <tr><td colSpan={6} className="px-6 py-8 text-center text-error">Failed to load work orders</td></tr>
              )}
              {listQ.isLoading && (
                <tr><td colSpan={6} className="px-6 py-8 text-center text-primary-fixed-dim neon-pulse">Loading vectors...</td></tr>
              )}
              {listQ.data?.length === 0 && (
                <tr><td colSpan={6} className="px-6 py-16 text-center">
                  <div className="flex flex-col items-center gap-4">
                    <span className="material-symbols-outlined text-5xl text-on-surface-variant/30">task</span>
                    <div className="text-on-surface-variant max-w-md">
                      <p className="mb-6 text-lg">The Board tracks tasks from planned to promoted.</p>
                      <Link to="/create" className="bg-primary text-on-primary px-6 py-2 rounded font-bold uppercase tracking-widest">Create a work order for the forge</Link>
                    </div>
                  </div>
                </td></tr>
              )}
              {listQ.data?.map((t) => (
                <tr key={t.id} className="hover:bg-white/[0.03] transition-colors group">
                  <td className="px-6 py-4 font-code-sm text-primary/80">#{t.id.substring(0,8)}</td>
                  <td className="px-6 py-4">
                    <div className="flex flex-col">
                      <Link to="/tickets/$id" params={{ id: t.id }} className="text-on-surface font-medium hover:text-primary transition-colors">
                        {t.title}
                      </Link>
                    </div>
                  </td>
                  <td className="px-6 py-4">
                    <span className="px-2 py-0.5 rounded text-[10px] font-code-label border border-primary-fixed-dim/50 bg-primary-fixed-dim/10 text-primary-fixed-dim uppercase">
                      {t.priority}
                    </span>
                  </td>
                  <td className="px-6 py-4">
                    <StatusBadge status={t.status} />
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-2">
                      <Avatar actorId={t.assigneeId} size="sm" />
                      <span className="text-xs">{t.assigneeId ? actorName(t.assigneeId) : "Unassigned"}</span>
                    </div>
                  </td>
                  <td className="px-6 py-4 text-right">
                    <Link to="/tickets/$id" params={{ id: t.id }} className="material-symbols-outlined opacity-0 group-hover:opacity-100 transition-opacity hover:text-primary">
                      chevron_right
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="grid grid-cols-1 lg:grid-cols-3 gap-4 md:gap-gutter pb-24 md:pb-margin-desktop">
        <div className="lg:col-span-2 glass-card flex flex-col min-h-[300px]">
          <div className="px-4 py-2 bg-surface-container-highest/30 border-b border-white/5 flex items-center justify-between">
            <div className="flex gap-1.5">
              <div className="w-2 h-2 rounded-full bg-error/40"></div>
              <div className="w-2 h-2 rounded-full bg-secondary/40"></div>
              <div className="w-2 h-2 rounded-full bg-primary-fixed-dim/40"></div>
            </div>
            <span className="font-code-label text-[10px] uppercase text-on-surface-variant/60">System_Log_v2.0.4</span>
          </div>
          <div className="p-4 font-code-sm text-xs space-y-2 overflow-y-auto terminal-scroll max-h-[250px] flex-1">
            {/* boot entry guarantees at least one row, so no empty-state branch */}
            {logsQ.data?.map((log, i) => (
                <div key={i} className="flex gap-4">
                  <span className="text-on-surface-variant/40">[{log.at}]</span>
                  <span className={log.level === 'info' ? "text-on-surface-variant" : "text-primary-fixed-dim"}>{log.level}:</span>
                  <span className="text-on-surface/80">{log.message}</span>
                </div>
              ))}
            {logsQ.data && logsQ.data.length > 0 && (
              <div className="flex gap-4 animate-pulse mt-2">
                <span className="text-on-surface-variant/40">[_CURSOR_]</span>
                <span className="text-primary-fixed-dim inline-block w-1 h-3 bg-primary-fixed-dim ml-[-12px]"></span>
              </div>
            )}
          </div>
        </div>
        
        <div className="glass-card p-6 flex flex-col space-y-6">
          <div className="flex items-center justify-between">
            <h4 className="font-code-label text-xs uppercase tracking-widest text-on-surface-variant">System Status</h4>
            <button
              onClick={() => statusQ.refetch()}
              className="text-on-surface-variant/60 hover:text-on-surface"
              aria-label="Refresh system status"
            >
              <span className="material-symbols-outlined text-sm">refresh</span>
            </button>
          </div>
          <div className="flex-1 space-y-2 overflow-y-auto max-h-[260px]">
            {statusQ.data && (
              <>
                <div className="flex items-center justify-between text-xs gap-2">
                  <span className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full ${statusQ.data.db === "ok" ? "bg-green-500/80" : "bg-red-500/80"}`}></span>
                    <span className="text-on-surface">database</span>
                  </span>
                  <span className="text-on-surface-variant/60 text-right truncate max-w-[140px]">{statusQ.data.db}</span>
                </div>
                <div className="flex items-center justify-between text-xs gap-2">
                  <span className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-green-500/80"></span>
                    <span className="text-on-surface">embedder</span>
                  </span>
                  <span className="text-on-surface-variant/60 text-right truncate max-w-[140px]">{statusQ.data.embedder}</span>
                </div>
                <div className="flex items-center justify-between text-xs gap-2">
                  <span className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full ${statusQ.data.watcher?.status === "running" ? "bg-green-500/80" : "bg-white/20"}`}></span>
                    <span className="text-on-surface">watcher</span>
                  </span>
                  <span className="text-on-surface-variant/60 text-right truncate max-w-[140px]">{statusQ.data.watcher?.status} ({statusQ.data.watcher?.indexed} indexed)</span>
                </div>
                <div className="flex items-center justify-between text-xs gap-2">
                  <span className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-green-500/80"></span>
                    <span className="text-on-surface">forge</span>
                  </span>
                  <span className="text-on-surface-variant/60 text-right truncate max-w-[140px]">{statusQ.data.activeRuns} active runs</span>
                </div>

                <div className="flex items-center justify-between text-xs gap-2">
                  <span className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-green-500/80"></span>
                    <span className="text-on-surface">uptime</span>
                  </span>
                  <span className="text-on-surface-variant/60 text-right truncate max-w-[140px]">{Math.floor(statusQ.data.uptimeMs / 1000)}s</span>
                </div>
              </>
            )}
          </div>
        </div>
      </section>
    </>
  );
}
