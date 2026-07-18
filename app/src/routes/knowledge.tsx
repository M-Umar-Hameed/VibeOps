import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { knowledge } from "../api/knowledge.js";
import { notes } from "../api/notes.js";
import { apiFetch } from "../api/client.js";
import { NotesPanel } from "../components/NotesPanel.js";

function hashString(str: string) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = Math.imul(31, hash) + str.charCodeAt(i) | 0;
  }
  return hash;
}

export function KnowledgeScreen() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [activeSource, setActiveSource] = useState<{kind: string, ref: string, citation: string} | null>(null);
  const [tab, setTab] = useState<"Search" | "Sessions" | "Graph">("Search");
  const [sessionFilter, setSessionFilter] = useState("");
  
  const sq = useQuery({ queryKey: ["knowledge", submitted], queryFn: () => knowledge.search(submitted), enabled: !!submitted });
  const sessionsQuery = useQuery({ queryKey: ["sessions"], queryFn: () => apiFetch("/knowledge/sessions") as Promise<{ref: string, chunkCount: number, created_at: string, excerpt: string}[]>, enabled: tab === "Sessions" });
  const graphQuery = useQuery({ queryKey: ["graph"], queryFn: () => apiFetch("/knowledge/graph") as Promise<{nodes: any[], edges: any[]}>, enabled: tab === "Graph" });
  
  const sourceQuery = useQuery({
    queryKey: ["source", activeSource?.kind, activeSource?.ref],
    queryFn: () => knowledge.getSource(activeSource!.kind, activeSource!.ref),
    enabled: !!activeSource
  });

  const [body, setBody] = useState("");
  const [scope, setScope] = useState("global");
  const [refId, setRefId] = useState("");
  const [saved, setSaved] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);

  const save = useMutation({
    mutationFn: () => notes.save({ body, scope, refId: scope === "global" ? undefined : refId }),
    onSuccess: () => { setSaved(true); setBody(""); setTimeout(() => setSaved(false), 3000); qc.invalidateQueries({ queryKey: ["notes"] }); },
  });

  const [syncResult, setSyncResult] = useState<string | null>(null);
  const sync = useMutation({
    mutationFn: () =>
      apiFetch("/ingest/sessions", { method: "POST", body: {} }) as Promise<Record<string, { indexed: number; skipped: number; failed: number }>>,
    onSuccess: (summary) => setSyncResult(Object.entries(summary).map(([source, r]) => `${source} ${r.indexed}`).join(" · ")),
  });

  return (
    <div className="relative min-h-[calc(100vh-64px)] flex flex-col">
      {/* Command Center Search */}
      <section className="flex-1 flex flex-col items-center pt-16 px-gutter max-w-5xl mx-auto w-full">
        <div className="w-full max-w-3xl space-y-6">
          <div className="text-center space-y-2 mb-8">
            <h2 className="font-headline-lg text-headline-lg text-on-surface">Universal Knowledge Index</h2>
            <p className="font-code-sm text-on-surface-variant/70 uppercase tracking-widest">Accessing local vault: //{typeof window !== 'undefined' ? window.location.host : 'sys'}/obsidian_core</p>
            <div className="flex justify-center gap-8 mt-4 border-b border-white/10 w-full max-w-sm mx-auto">
              <button 
                className={`font-code-label text-sm uppercase tracking-widest pb-2 border-b-2 transition-colors cursor-pointer ${tab === "Search" ? "border-primary text-primary" : "border-transparent text-on-surface-variant hover:text-on-surface"}`}
                onClick={() => setTab("Search")}
              >Search</button>
              <button 
                className={`font-code-label text-sm uppercase tracking-widest pb-2 border-b-2 transition-colors cursor-pointer ${tab === "Sessions" ? "border-primary text-primary" : "border-transparent text-on-surface-variant hover:text-on-surface"}`}
                onClick={() => setTab("Sessions")}
              >Sessions</button>
              <button 
                className={`font-code-label text-sm uppercase tracking-widest pb-2 border-b-2 transition-colors cursor-pointer ${tab === "Graph" ? "border-primary text-primary" : "border-transparent text-on-surface-variant hover:text-on-surface"}`}
                onClick={() => setTab("Graph")}
              >Graph</button>
            </div>
            <div className="flex items-center justify-center gap-3 pt-4">
              <button
                className="flex items-center gap-2 px-3 py-1.5 bg-surface-container-lowest border border-white/10 rounded font-code-label text-[10px] uppercase tracking-widest text-on-surface-variant hover:text-primary hover:border-primary/30 transition-colors cursor-pointer disabled:opacity-50"
                disabled={sync.isPending}
                onClick={() => sync.mutate()}
              >
                {sync.isPending && <span className="material-symbols-outlined animate-spin text-sm">sync</span>}
                Sync sessions
              </button>
              {syncResult && <span className="font-code-sm text-[10px] text-on-surface-variant/70">{syncResult}</span>}
            </div>
          </div>
          
          {tab === "Graph" ? (
            <div className="w-full mt-12 bg-surface-container-lowest border border-white/10 rounded-lg p-4 relative overflow-hidden" style={{ height: "600px" }}>
              {graphQuery.isPending && <div className="text-center mt-8 text-primary-fixed-dim neon-pulse font-code-sm uppercase tracking-widest">Loading graph...</div>}
              {graphQuery.data && (
                <>
                  <svg width="100%" height="100%" viewBox="-400 -400 800 800" className="w-full h-full">
                    <g className="edges">
                      {graphQuery.data.edges.map((e, i) => {
                        const nA = graphQuery.data.nodes.find(n => n.id === e.a);
                        const nB = graphQuery.data.nodes.find(n => n.id === e.b);
                        if (!nA || !nB) return null;
                        const getPos = (n: any) => {
                          const r = n.kind === 'vault' ? 140 : n.kind === 'note' ? 220 : n.kind === 'session' ? 300 : 380;
                          const angle = (Math.abs(hashString(n.id)) % 10000 / 10000) * 2 * Math.PI;
                          return { x: Math.cos(angle) * r, y: Math.sin(angle) * r };
                        };
                        const posA = getPos(nA);
                        const posB = getPos(nB);
                        const opacity = Math.min(Math.max((e.w - 0.4) * 1.5, 0.1), 0.9);
                        return <line key={i} x1={posA.x} y1={posA.y} x2={posB.x} y2={posB.y} stroke="currentColor" className="text-primary" strokeOpacity={opacity} strokeWidth={1.5} />;
                      })}
                    </g>
                    <g className="nodes">
                      {graphQuery.data.nodes.map((n, i) => {
                        const r = n.kind === 'vault' ? 140 : n.kind === 'note' ? 220 : n.kind === 'session' ? 300 : 380;
                        const angle = (Math.abs(hashString(n.id)) % 10000 / 10000) * 2 * Math.PI;
                        const x = Math.cos(angle) * r;
                        const y = Math.sin(angle) * r;
                        const colorClass = n.kind === 'vault' ? 'fill-primary' : n.kind === 'note' ? 'fill-secondary' : n.kind === 'session' ? 'fill-amber-500' : 'fill-on-surface';
                        return (
                          <circle 
                            key={i} cx={x} cy={y} r={6} 
                            className={`${colorClass} hover:stroke-white stroke-[2px] cursor-pointer transition-all`} 
                            onClick={() => setActiveSource({ kind: n.kind, ref: n.id, citation: n.id })}
                          >
                            <title>{n.id}</title>
                          </circle>
                        );
                      })}
                    </g>
                  </svg>
                  <div className="absolute bottom-4 left-4 flex gap-4 font-code-label text-[10px] uppercase text-on-surface-variant bg-surface-container-high/80 p-2 rounded backdrop-blur border border-white/5">
                    <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-primary"></span> Vault</span>
                    <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-secondary"></span> Note</span>
                    <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-amber-500"></span> Session</span>
                  </div>
                </>
              )}
            </div>
          ) : tab === "Search" ? (
            <>
              {/* Large Search Bar */}
              <div className="relative group w-full">
                <div className="absolute -inset-1 bg-gradient-to-r from-primary-fixed-dim to-secondary rounded-lg blur opacity-20 group-focus-within:opacity-40 transition duration-500"></div>
                <div className="relative flex items-center bg-surface-container-lowest border border-white/10 glow-border-primary px-4 md:px-6 py-3 md:py-5 rounded">
                  <span className="material-symbols-outlined text-primary-fixed-dim text-2xl md:text-3xl mr-2 md:mr-4">manage_search</span>
                  <input 
                    className="bg-transparent border-none text-headline-sm md:text-headline-md font-headline-sm md:font-headline-md w-full focus:ring-0 placeholder:text-outline/40 text-on-surface outline-none" 
                    placeholder="Search Obsidian Vault..." 
                    type="text"
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") setSubmitted(q);
                    }}
                  />
                  <button 
                    className="bg-primary-fixed-dim text-on-primary font-code-label px-3 md:px-4 py-2 rounded-sm uppercase tracking-widest hover:brightness-110 active:scale-95 transition-all cursor-pointer shadow-[0_0_15px_rgba(0,219,233,0.3)] ml-2 md:ml-4 text-xs md:text-sm"
                    onClick={() => setSubmitted(q)}
                  >
                    Scan
                  </button>
                </div>
              </div>

              {sq.isLoading && <div className="text-center mt-12 text-primary-fixed-dim neon-pulse font-code-sm uppercase tracking-widest">Scanning vector space...</div>}

              {/* Rich Knowledge Cards Grid */}
              {sq.data && sq.data.length > 0 && (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-2 gap-6 mt-12 w-full">
                  {sq.data.map((h, i) => (
                    <div 
                      key={i} 
                      className="glass-card group relative p-6 hover:shadow-[0_0_20px_rgba(0,219,233,0.1)] transition-all duration-300 overflow-hidden cursor-pointer rounded-lg"
                      onClick={() => {
                        if (h.sourceKind === "ticket") {
                          nav({ to: "/tickets/$id", params: { id: h.sourceRef } });
                        } else {
                          setActiveSource({ kind: h.sourceKind, ref: h.sourceRef, citation: h.citation });
                        }
                      }}
                    >
                      <div className="absolute top-0 right-0 p-2 opacity-30 group-hover:opacity-100 transition-opacity">
                        <span className="material-symbols-outlined text-primary-fixed-dim text-sm">open_in_new</span>
                      </div>
                      <h3 className="font-headline-md text-headline-md text-primary mb-3 leading-tight">{h.citation}</h3>
                      <p className="text-on-surface-variant text-sm line-clamp-4 mb-4 leading-relaxed font-body-md whitespace-pre-wrap">
                        {h.content}
                      </p>
                      <div className="pt-4 border-t border-white/5 flex justify-between items-center text-outline">
                        <span className="font-code-sm text-[10px] text-primary-fixed-dim/60">INDEX_MATCH</span>
                        <span className="material-symbols-outlined text-sm" style={{ fontVariationSettings: "'FILL' 1" }}>star</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {sq.data && sq.data.length === 0 && (
                <div className="text-center mt-12 text-on-surface-variant font-code-sm uppercase tracking-widest opacity-50">0 matches found</div>
              )}
              {!sq.data && !sq.isLoading && (
                <div className="text-center mt-24 flex flex-col items-center">
                  <span className="material-symbols-outlined text-6xl text-on-surface-variant/30 mb-6">analytics</span>
                  <div className="text-on-surface-variant max-w-md">
                    <p className="mb-6 text-lg">Knowledge is your centralized graph of code context and agent sessions.</p>
                    <button onClick={() => setTerminalOpen(true)} className="bg-primary text-on-primary px-6 py-2 rounded font-bold uppercase tracking-widest cursor-pointer hover:brightness-110">Write a note</button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="w-full space-y-6 mt-12">
              <div className="relative flex items-center bg-surface-container-lowest border border-white/10 px-4 py-3 rounded">
                <span className="material-symbols-outlined text-outline text-xl mr-3">filter_list</span>
                <input
                  className="bg-transparent border-none text-body-lg w-full focus:ring-0 placeholder:text-outline/40 text-on-surface outline-none"
                  placeholder="Filter by session ref..."
                  value={sessionFilter}
                  onChange={(e) => setSessionFilter(e.target.value)}
                />
              </div>
              
              {sessionsQuery.isPending && <div className="text-center mt-8 text-primary-fixed-dim neon-pulse font-code-sm uppercase tracking-widest">Loading sessions...</div>}
              {sessionsQuery.isError && <div className="text-error bg-error/10 p-4 rounded text-center">Error loading sessions</div>}
              
              {sessionsQuery.data && (
                <div className="flex flex-col gap-4 mt-8">
                  {sessionsQuery.data.filter((s: { ref: string; chunkCount: number; created_at: string; excerpt: string; }) => s.ref.includes(sessionFilter)).map((s: { ref: string; chunkCount: number; created_at: string; excerpt: string; }, i: number) => (
                    <div 
                      key={i}
                      className="glass-card p-4 hover:bg-white/5 transition-colors cursor-pointer rounded flex flex-col gap-2"
                      onClick={() => setActiveSource({ kind: "session", ref: s.ref, citation: s.ref })}
                    >
                      <div className="flex justify-between items-center">
                        <span className="font-code-sm text-primary max-w-[60%] truncate" title={s.ref}>
                          {s.ref.length > 40 ? s.ref.slice(0, 20) + "..." + s.ref.slice(-20) : s.ref}
                        </span>
                        <div className="flex items-center gap-3">
                          <span className="text-[10px] uppercase font-code-sm text-on-surface-variant/70">{new Date(s.created_at).toLocaleString()}</span>
                          <span className="bg-surface-container-highest text-on-surface text-[10px] px-2 py-0.5 rounded-full font-code-label">
                            {s.chunkCount} {s.chunkCount === 1 ? "chunk" : "chunks"}
                          </span>
                        </div>
                      </div>
                      <div className="text-sm text-on-surface-variant/60 truncate" title={s.excerpt}>{s.excerpt}</div>
                    </div>
                  ))}
                  {sessionsQuery.data.filter((s: { ref: string; chunkCount: number; created_at: string; excerpt: string; }) => s.ref.includes(sessionFilter)).length === 0 && (
                    <div className="text-center mt-8 text-on-surface-variant font-code-sm uppercase tracking-widest opacity-50">No sessions match filter</div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="w-full max-w-3xl mt-16">
          <NotesPanel />
        </div>
      </section>

      {/* Terminal AI Side Panel for Creating Notes */}
      <div 
        className={`fixed right-4 md:right-6 bottom-20 md:bottom-24 w-[calc(100vw-32px)] md:w-[380px] glass-card flex flex-col border border-white/10 shadow-2xl z-50 rounded-lg overflow-hidden transition-transform duration-500 ease-in-out ${terminalOpen ? 'translate-x-0' : 'translate-x-[calc(100vw+32px)] md:translate-x-[420px]'}`}
      >
        <div className="p-4 bg-surface-container-high flex items-center justify-between border-b border-white/10">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-secondary animate-pulse"></span>
            <span className="font-code-label text-code-label text-on-surface uppercase tracking-widest">Save Knowledge Node</span>
          </div>
          <button className="text-outline hover:text-on-surface cursor-pointer" onClick={() => setTerminalOpen(false)}>
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>
        
        <div className="p-4 space-y-4 font-code-sm">
          {saved && (
            <div className="bg-primary-fixed-dim/20 text-primary-fixed-dim border border-primary-fixed-dim p-2 rounded text-center">Node synchronized to Vault</div>
          )}
          <div className="space-y-1">
            <label className="text-on-surface-variant uppercase text-[10px]">Scope</label>
            <div className="relative">
              <select 
                className="w-full bg-surface-container-lowest border border-white/5 px-3 py-2 pr-8 rounded text-on-surface appearance-none outline-none cursor-pointer"
                value={scope} 
                onChange={(e) => setScope(e.target.value)}
              >
                <option className="bg-surface" value="global">Global Space</option>
                <option className="bg-surface" value="project">Project Local</option>
                <option className="bg-surface" value="ticket">Ticket Context</option>
              </select>
              <span className="absolute right-3 top-1/2 -translate-y-1/2 material-symbols-outlined text-sm opacity-50 pointer-events-none">expand_more</span>
            </div>
          </div>
          
          {scope !== "global" && (
            <div className="space-y-1">
              <label className="text-on-surface-variant uppercase text-[10px]">Reference ID</label>
              <input 
                className="w-full bg-surface-container-lowest border border-white/5 px-3 py-2 rounded text-on-surface outline-none"
                value={refId} 
                onChange={(e) => setRefId(e.target.value)} 
                placeholder={`Enter ${scope} ID`} 
              />
            </div>
          )}
          
          <div className="space-y-1">
            <label className="text-on-surface-variant uppercase text-[10px]">Node Content</label>
            <textarea 
              className="w-full bg-surface-container-lowest border border-white/5 px-3 py-2 rounded text-on-surface outline-none min-h-[100px] resize-y"
              value={body} 
              onChange={(e) => setBody(e.target.value)} 
              placeholder="Enter markdown note..." 
            />
          </div>
          
          <button 
            className="w-full bg-secondary/20 hover:bg-secondary/40 text-secondary border border-secondary/50 py-2 rounded font-code-label uppercase tracking-widest transition-colors cursor-pointer disabled:opacity-50"
            disabled={!body || save.isPending} 
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Syncing..." : "Write to Vault"}
          </button>
        </div>
      </div>

      {/* Terminal Toggle FAB */}
      <button 
        className="fixed right-4 bottom-4 md:right-6 md:bottom-8 w-12 h-12 md:w-14 md:h-14 flex items-center justify-center bg-secondary text-on-secondary rounded-full shadow-[0_0_20px_rgba(207,92,255,0.4)] hover:scale-105 active:scale-95 transition-all z-40 cursor-pointer" 
        onClick={() => setTerminalOpen(!terminalOpen)}
        title="Save Note"
      >
        <span className="material-symbols-outlined text-2xl md:text-3xl">edit_note</span>
      </button>
      {/* Markdown Viewer Panel */}
      <div 
        className={`fixed inset-0 z-50 transition-all duration-300 flex justify-end ${activeSource ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'}`}
      >
        <div className={`absolute inset-0 bg-background/80 backdrop-blur-sm transition-opacity duration-300 ${activeSource ? 'opacity-100' : 'opacity-0'}`} onClick={() => setActiveSource(null)} />
        
        <div className={`relative w-full max-w-3xl bg-surface-container border-l border-white/10 h-full shadow-2xl transform transition-transform duration-300 flex flex-col ${activeSource ? 'translate-x-0' : 'translate-x-full'}`}>
          <div className="flex items-center justify-between p-6 border-b border-white/10">
            <div>
              <h2 className="font-headline-md text-headline-md font-bold text-primary">{activeSource?.citation}</h2>
              <p className="font-code-sm text-xs text-on-surface-variant uppercase mt-1">
                {activeSource?.kind === 'vault' ? 'READ_ONLY_VAULT_NODE' : 'DATABASE_NOTE'}
              </p>
            </div>
            <button className="p-2 text-on-surface-variant hover:text-on-surface hover:bg-white/5 rounded-full transition-colors cursor-pointer" onClick={() => setActiveSource(null)}>
              <span className="material-symbols-outlined">close</span>
            </button>
          </div>
          
          <div className="flex-1 overflow-y-auto p-8 custom-scrollbar">
            {sourceQuery.isPending && activeSource ? (
              <div className="flex flex-col items-center justify-center h-40 opacity-50">
                <span className="material-symbols-outlined animate-spin text-3xl text-primary-fixed-dim mb-4">sync</span>
                <p className="font-code-label text-code-label uppercase tracking-widest text-primary-fixed-dim">Fetching Node Source...</p>
              </div>
            ) : sourceQuery.isError ? (
              <div className="text-error bg-error/10 p-4 rounded font-code-sm border border-error/20 whitespace-pre-wrap">
                Failed to load source node.
                {sourceQuery.error && ` Error: ${(sourceQuery.error as Error).message}`}
              </div>
            ) : (
              <pre className="font-code-body text-code-body text-on-surface whitespace-pre-wrap font-mono">
                {sourceQuery.data?.text}
              </pre>
            )}
          </div>
        </div>
      </div>

    </div>
  );
}
