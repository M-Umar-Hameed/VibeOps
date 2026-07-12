import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { tickets } from "../api/tickets.js";
import { projects } from "../api/projects.js";
import { actors } from "../api/actors.js";
import { system } from "../api/system.js";
import { Avatar } from "../components/Avatar.js";
import { StatusBadge } from "../components/StatusBadge.js";

export function ListScreen() {
  const [projectId, setProjectId] = useState<string>("");
  const [status, setStatus] = useState<string>("");
  const [q, setQ] = useState("");
  
  const projQ = useQuery({ queryKey: ["projects"], queryFn: projects.list });
  const actQ = useQuery({ queryKey: ["actors"], queryFn: actors.list });
  const listQ = useQuery({
    queryKey: ["tickets", { projectId, status, q }],
    queryFn: () => q ? tickets.search(q) : tickets.list({ projectId: projectId || undefined, status: status || undefined }),
  });
  
  const actorName = (id: string | null) => actQ.data?.find((a) => a.id === id)?.name ?? "Unassigned";

  const metricsQ = useQuery({ queryKey: ["systemMetrics"], queryFn: system.getMetrics, refetchInterval: 10000 });
  const logsQ = useQuery({ queryKey: ["systemLogs"], queryFn: system.getLogs, refetchInterval: 5000 });
  const topoQ = useQuery({ queryKey: ["systemTopology"], queryFn: system.getTopology, refetchInterval: 15000 });

  return (
    <>
      {/* Filters */}
      <div className="flex gap-4 mb-4">
        <div className="relative">
          <select className="bg-surface-container-highest border border-white/10 rounded px-3 py-1.5 pr-8 text-xs text-on-surface appearance-none outline-none cursor-pointer focus:border-primary-fixed-dim" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">All Projects</option>
            {projQ.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <span className="absolute right-2 top-1/2 -translate-y-1/2 material-symbols-outlined text-sm opacity-50 pointer-events-none">expand_more</span>
        </div>
        <div className="relative">
          <select className="bg-surface-container-highest border border-white/10 rounded px-3 py-1.5 pr-8 text-xs text-on-surface appearance-none outline-none cursor-pointer focus:border-primary-fixed-dim" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Any Status</option><option value="open">Open</option><option value="in_progress">In Progress</option><option value="closed">Closed</option>
          </select>
          <span className="absolute right-2 top-1/2 -translate-y-1/2 material-symbols-outlined text-sm opacity-50 pointer-events-none">expand_more</span>
        </div>
        <input 
          className="bg-surface-container-highest border border-white/10 rounded px-3 py-1.5 text-xs text-on-surface placeholder-on-surface-variant/50 flex-1 max-w-xs" 
          placeholder="Filter active tickets..." 
          value={q} 
          onChange={(e) => setQ(e.target.value)} 
        />
      </div>

      <section className="grid grid-cols-1 md:grid-cols-3 gap-gutter mb-gutter">
        <div className="glass-card p-6 flex flex-col justify-between group hover:border-primary-fixed-dim/30 transition-all glow-blue">
          <div className="flex justify-between items-start mb-4">
            <span className="text-on-surface-variant font-code-label text-xs uppercase tracking-widest">Active Tickets</span>
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

      <section className="glass-card overflow-hidden mb-gutter">
        <div className="px-6 py-4 border-b border-white/5 flex justify-between items-center">
          <h3 className="font-headline-md text-headline-md text-primary">Active Deployment Tickets</h3>
          <Link to="/create" className="bg-primary-fixed-dim text-on-primary-fixed px-4 py-2 font-code-label text-code-label rounded-lg flex items-center gap-2 hover:brightness-110 active:scale-95 transition-all shadow-lg shadow-primary-fixed-dim/20 cursor-pointer inline-flex">
            <span className="material-symbols-outlined text-sm">add</span>
            NEW_TICKET
          </Link>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left font-body-sm text-on-surface-variant">
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
                <tr><td colSpan={6} className="px-6 py-8 text-center text-error">Failed to load tickets</td></tr>
              )}
              {listQ.isLoading && (
                <tr><td colSpan={6} className="px-6 py-8 text-center text-primary-fixed-dim neon-pulse">Loading vectors...</td></tr>
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

      <section className="grid grid-cols-1 lg:grid-cols-3 gap-gutter pb-margin-desktop">
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
            {logsQ.data?.map((log, i) => (
              <div key={i} className="flex gap-4">
                <span className="text-on-surface-variant/40">[{log.time}]</span>
                <span className={log.level === 'DEBUG' ? "text-on-surface-variant" : "text-primary-fixed-dim"}>{log.level}:</span>
                <span className="text-on-surface/80">{log.msg}</span>
              </div>
            ))}
            <div className="flex gap-4 animate-pulse mt-2">
              <span className="text-on-surface-variant/40">[_CURSOR_]</span>
              <span className="text-primary-fixed-dim inline-block w-1 h-3 bg-primary-fixed-dim ml-[-12px]"></span>
            </div>
          </div>
        </div>
        
        <div className="glass-card p-6 flex flex-col space-y-6">
          <h4 className="font-code-label text-xs uppercase tracking-widest text-on-surface-variant">Network Topology</h4>
          <div className="relative flex-1 rounded bg-black/40 border border-white/5 overflow-hidden flex items-center justify-center group">
            <div className="relative z-10 flex flex-col items-center text-center p-4">
              <span className="material-symbols-outlined text-primary-fixed-dim text-4xl mb-2">hub</span>
              <span className="text-xs font-code-label text-on-surface">{topoQ.data?.nodes ?? "--"} ACTIVE NODES</span>
              <span className="text-[10px] text-primary-fixed-dim/60">{topoQ.data?.regions.join(", ") ?? "--"}</span>
            </div>
          </div>
          <div className="space-y-3">
            <div className="flex justify-between items-center text-xs">
              <span className="text-on-surface-variant">Cluster Health</span>
              <span className="text-primary-fixed-dim">{metricsQ.data?.clusterHealth ?? "--"}%</span>
            </div>
            <div className="w-full h-1 bg-surface-container-highest rounded-full overflow-hidden">
              <div className="h-full bg-primary-fixed-dim shadow-[0_0_8px_rgba(0,219,233,0.5)] transition-all duration-1000" style={{ width: `${metricsQ.data?.clusterHealth ?? 0}%` }}></div>
            </div>
            <div className="flex justify-between items-center text-xs">
              <span className="text-on-surface-variant">CPU Load</span>
              <span className="text-secondary">{metricsQ.data?.cpuLoad ?? "--"}%</span>
            </div>
            <div className="w-full h-1 bg-surface-container-highest rounded-full overflow-hidden">
              <div className="h-full bg-secondary shadow-[0_0_8px_rgba(207,92,255,0.5)] transition-all duration-1000" style={{ width: `${metricsQ.data?.cpuLoad ?? 0}%` }}></div>
            </div>
          </div>
        </div>
      </section>

      <button className="fixed bottom-8 right-8 w-14 h-14 bg-primary-container text-on-primary-container rounded-full flex items-center justify-center shadow-2xl hover:scale-110 active:scale-95 transition-all z-50 group cursor-pointer">
        <span className="material-symbols-outlined group-hover:rotate-90 transition-transform">terminal</span>
        <div className="absolute right-full mr-4 bg-surface-container px-3 py-1.5 rounded-lg border border-white/10 opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity whitespace-nowrap text-xs font-code-label">
            OPEN_CONSOLE
        </div>
      </button>
    </>
  );
}
