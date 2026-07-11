import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { tickets } from "../api/tickets.js";
import { comments } from "../api/comments.js";
import { history } from "../api/history.js";
import { actors } from "../api/actors.js";
import { StaleVersionError } from "../api/errors.js";
import { system } from "../api/system.js";
import { Avatar } from "../components/Avatar.js";

export function DetailScreen({ id }: { id: string }) {
  const qc = useQueryClient();
  const tq = useQuery({ queryKey: ["ticket", id], queryFn: () => tickets.get(id) });
  const hq = useQuery({ queryKey: ["history", id], queryFn: () => history.get(id) });
  const cq = useQuery({ queryKey: ["comments", id], queryFn: () => comments.list(id) });
  const aq = useQuery({ queryKey: ["actors"], queryFn: actors.list });
  const metricsQ = useQuery({ queryKey: ["systemMetrics"], queryFn: system.getMetrics });
  
  const actorName = (aid: string) => aq.data?.find((a) => a.id === aid)?.name ?? aid;

  const [status, setStatus] = useState<string | undefined>();
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<string | undefined>();
  useEffect(() => { setStatus(undefined); }, [id]);
  useEffect(() => { if (tq.data && status === undefined) setStatus(tq.data.status); }, [tq.data]);

  const save = useMutation({
    mutationFn: () => tickets.update(id, tq.data!.version, { status }),
    onSuccess: () => { setConflict(false); setError(undefined); qc.invalidateQueries({ queryKey: ["ticket", id] }); qc.invalidateQueries({ queryKey: ["history", id] }); },
    onError: (e) => {
      if (e instanceof StaleVersionError) { setConflict(true); qc.invalidateQueries({ queryKey: ["ticket", id] }); }
      else { setError(e instanceof Error ? e.message : "Failed to save ticket"); }
    },
  });

  const [comment, setComment] = useState("");
  const addComment = useMutation({
    mutationFn: () => comments.add(id, comment),
    onSuccess: () => { setComment(""); qc.invalidateQueries({ queryKey: ["comments", id] }); qc.invalidateQueries({ queryKey: ["history", id] }); },
  });

  if (tq.isLoading) return <div className="p-8 text-primary-fixed-dim neon-pulse font-code-sm">Loading ticket data...</div>;
  if (tq.isError && !tq.data) return <div className="p-8 text-error font-code-sm" role="alert">Failed to load ticket</div>;
  const t = tq.data!;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-gutter">
      {/* Center Content Area */}
      <div className="col-span-1 lg:col-span-8 space-y-gutter border-r border-white/5 pr-4 lg:pr-8">
        {conflict && <div className="bg-error-container/20 border border-error p-4 rounded text-error text-sm font-code-sm">This ticket changed elsewhere — reloaded; please redo your edit and save again.</div>}
        {error && <div className="bg-error-container/20 border border-error p-4 rounded text-error text-sm font-code-sm">{error}</div>}

        {/* Header Section */}
        <section className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <span className="font-code-label text-primary-fixed-dim tracking-widest">#{t.id.substring(0,8)}</span>
            <div className="flex gap-2 items-center">
              <span className={`px-2 py-0.5 rounded border font-code-sm text-[10px] uppercase tracking-wider ${t.priority === 'high' ? 'border-error/30 bg-error/10 text-error shadow-[0_0_8px_rgba(255,180,171,0.2)]' : 'border-secondary/30 bg-secondary/10 text-secondary'}`}>
                {t.priority}
              </span>
              <select 
                className="bg-transparent text-primary-fixed-dim text-xs font-code-label uppercase outline-none cursor-pointer hover:bg-white/5 rounded px-2 py-1"
                value={status ?? t.status} 
                onChange={(e) => {
                  setStatus(e.target.value);
                  // We simulate auto-save on select for smooth UX
                  setTimeout(() => save.mutate(), 0);
                }}
              >
                <option className="bg-surface text-on-surface" value="open">OPEN</option>
                <option className="bg-surface text-on-surface" value="in_progress">IN_PROGRESS</option>
                <option className="bg-surface text-on-surface" value="closed">CLOSED</option>
              </select>
            </div>
          </div>
          <h2 className="font-headline-lg text-headline-lg text-primary leading-tight">{t.title}</h2>
          
          {/* Metadata Bar */}
          <div className="flex flex-wrap items-center gap-6 py-4 border-y border-white/5">
            <div className="flex items-center gap-2">
              <Avatar actorId={t.assigneeId} size="md" />
              <div className="flex flex-col ml-2">
                <span className="font-code-sm text-[11px] text-on-surface-variant uppercase opacity-50">Assignee</span>
                <span className="font-body-sm text-on-surface">{t.assigneeId ? actorName(t.assigneeId) : "Unassigned"}</span>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-on-surface-variant text-base">category</span>
              <div className="flex flex-col">
                <span className="font-code-sm text-[11px] text-on-surface-variant uppercase opacity-50">Project</span>
                <span className="font-body-sm text-on-surface">{t.projectId}</span>
              </div>
            </div>
          </div>
        </section>

        {/* Description */}
        <section className="glass-card p-6 rounded-xl space-y-4">
          <div className="flex items-center gap-2 text-primary-fixed-dim">
            <span className="material-symbols-outlined text-base">description</span>
            <h3 className="font-headline-md text-headline-md">Description</h3>
          </div>
          <div className="space-y-4 text-on-surface-variant leading-relaxed font-body-sm whitespace-pre-wrap">
            {t.body || <span className="opacity-50 italic">No description provided.</span>}
          </div>
        </section>

        {/* Audit Timeline */}
        <section className="space-y-6 pt-6 border-t border-white/5">
          <div className="flex items-center gap-2 text-primary-fixed-dim">
            <span className="material-symbols-outlined text-base">history</span>
            <h3 className="font-headline-md text-headline-md">Audit Timeline</h3>
          </div>
          <div className="relative ml-4 space-y-8 before:absolute before:left-0 before:top-2 before:h-[calc(100%-8px)] before:w-[1px] before:bg-white/10">
            {hq.data?.map((event, idx) => (
              <div key={idx} className="relative pl-8">
                <div className={`absolute left-[-4px] top-1.5 w-2 h-2 rounded-full ${idx === 0 ? 'bg-primary shadow-[0_0_8px_rgba(0,219,233,0.8)]' : 'bg-white/20'}`}></div>
                <div className="flex flex-col sm:flex-row justify-between items-start gap-2">
                  <div>
                    <p className="font-body-sm font-semibold text-on-surface">
                      {event.action}
                    </p>
                    <div className="text-on-surface-variant text-xs space-y-1 mt-1">
                      {event.changes && Object.entries(event.changes).map(([k, v]) => (
                        <p key={k}>{k}: {String(v.from)} {"->"} {String(v.to)}</p>
                      ))}
                    </div>
                    <p className="text-on-surface-variant text-[10px] mt-1 font-code-sm opacity-60">
                      By {actorName(event.actorId)}
                    </p>
                  </div>
                  <span className="font-code-sm text-[11px] opacity-40 shrink-0">
                    {new Date(event.at).toLocaleString()}
                  </span>
                </div>
              </div>
            ))}
            {(!hq.data || hq.data.length === 0) && (
              <p className="pl-8 text-on-surface-variant text-xs opacity-50 italic">No history available</p>
            )}
          </div>
        </section>

        {/* Comments Section */}
        <section className="space-y-6 pt-6 border-t border-white/5 pb-8">
          <div className="flex items-center gap-2 text-primary-fixed-dim">
            <span className="material-symbols-outlined text-base">forum</span>
            <h3 className="font-headline-md text-headline-md">Comments</h3>
          </div>
          <div className="space-y-4">
            {cq.data?.map(c => (
              <div key={c.id} className="flex gap-4">
                <Avatar actorId={c.authorId} size="lg" />
                <div className="flex-1 glass-card p-4 rounded-xl space-y-2">
                  <div className="flex justify-between items-center gap-4">
                    <span className="font-body-sm font-bold text-primary">{actorName(c.authorId)}</span>
                    <span className="font-code-sm text-[11px] opacity-40 shrink-0">
                      {new Date(c.createdAt).toLocaleString()}
                    </span>
                  </div>
                  <p className="text-sm text-on-surface-variant whitespace-pre-wrap">{c.body}</p>
                </div>
              </div>
            ))}
            {(!cq.data || cq.data.length === 0) && (
              <p className="text-on-surface-variant text-xs opacity-50 italic text-center py-4">No comments yet</p>
            )}
          </div>
          
          {/* Input area */}
          <div className="relative mt-8">
            <textarea 
              className="w-full bg-surface-container-lowest border border-white/10 rounded-xl p-4 text-sm text-on-surface focus:border-primary-fixed-dim focus:ring-1 focus:ring-primary-fixed-dim/30 outline-none transition-all min-h-[100px] resize-y" 
              placeholder="Type your comment..."
              value={comment}
              onChange={(e) => setComment(e.target.value)}
            ></textarea>
            <div className="absolute bottom-3 right-3 flex gap-2">
              <button 
                className="px-4 py-2 bg-primary text-on-primary font-bold text-sm rounded transition-transform active:scale-95 shadow-[0_0_15px_rgba(0,219,233,0.3)] disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                disabled={!comment.trim() || addComment.isPending}
                onClick={() => addComment.mutate()}
              >
                Post Update
              </button>
            </div>
          </div>
        </section>
      </div>

      {/* Right Sidebar (Insights Panel) */}
      <aside className="col-span-1 lg:col-span-4 space-y-gutter lg:sticky lg:top-0 lg:max-h-screen">
        <div className="glass-card rounded-xl p-6 space-y-6">
          <div className="flex items-center justify-between">
            <h3 className="font-headline-md text-headline-md text-primary-fixed-dim flex items-center gap-2">
              <span className="material-symbols-outlined">psychology</span>
              RAG Insights
            </h3>
            <span className="material-symbols-outlined text-on-surface-variant text-sm cursor-pointer hover:text-primary transition-colors">refresh</span>
          </div>

          {/* Visual Knowledge Graph */}
          <div className="w-full h-48 bg-black/40 rounded-lg relative overflow-hidden border border-white/5 group">
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="text-center">
                <p className="font-code-label text-[10px] uppercase text-primary-fixed-dim animate-pulse">Analyzing Nodes...</p>
              </div>
            </div>
            {/* Nodes overlay */}
            <div className="absolute inset-0 p-4 flex flex-wrap gap-2 content-start opacity-0 group-hover:opacity-100 transition-opacity duration-500">
              <span className="bg-primary/10 border border-primary/20 text-[9px] px-2 py-0.5 rounded-full text-primary">ticket_{t.id.substring(0,4)}</span>
              <span className="bg-secondary/10 border border-secondary/20 text-[9px] px-2 py-0.5 rounded-full text-secondary">proj_{t.projectId}</span>
            </div>
          </div>

          <div className="space-y-4">
            <p className="font-code-sm text-[11px] text-on-surface-variant uppercase opacity-50 tracking-wider">Suggested Solutions</p>
            <div className="space-y-2">
              <div className="p-3 bg-white/5 border-l-2 border-primary rounded-r hover:bg-white/10 transition-colors cursor-pointer">
                <p className="text-sm font-semibold text-primary">Automated Response</p>
                <p className="text-[11px] text-on-surface-variant leading-relaxed">System has indexed previous related issues. Confidence 84%</p>
              </div>
            </div>
          </div>

          {/* System Health Snapshot Panel */}
          <div className="glass-card rounded-xl p-4 space-y-4 mt-6">
            <p className="font-code-sm text-[11px] text-on-surface-variant uppercase opacity-50 flex items-center gap-2">
              <span className="material-symbols-outlined text-xs">storage</span>
              System Health Snapshot
            </p>
            <div className="space-y-3">
              <div className="space-y-1">
                <div className="flex justify-between text-[10px] font-code-label">
                  <span>CPU LOAD</span>
                  <span className="text-primary-fixed-dim">{metricsQ.data?.cpuLoad ?? "--"}%</span>
                </div>
                <div className="h-1 bg-white/5 rounded-full overflow-hidden">
                  <div className="h-full bg-primary-fixed-dim transition-all duration-1000" style={{ width: `${metricsQ.data?.cpuLoad ?? 0}%` }}></div>
                </div>
              </div>
              <div className="space-y-1">
                <div className="flex justify-between text-[10px] font-code-label">
                  <span>MEMORY</span>
                  <span className="text-secondary">{metricsQ.data?.memoryUsed ?? "--"}%</span>
                </div>
                <div className="h-1 bg-white/5 rounded-full overflow-hidden">
                  <div className="h-full bg-secondary shadow-[0_0_8px_rgba(207,92,255,0.4)] transition-all duration-1000" style={{ width: `${metricsQ.data?.memoryUsed ?? 0}%` }}></div>
                </div>
              </div>
              <div className="space-y-1">
                <div className="flex justify-between text-[10px] font-code-label">
                  <span>I/O WAIT</span>
                  <span className="text-error">{metricsQ.data?.ioWait ?? "--"}ms</span>
                </div>
                <div className="h-1 bg-white/5 rounded-full overflow-hidden">
                  <div className="h-full bg-error transition-all duration-1000" style={{ width: `${Math.min(100, (metricsQ.data?.ioWait ?? 0) / 10)}%` }}></div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </aside>
    </div>
  );
}
