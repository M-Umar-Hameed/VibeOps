import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { knowledge } from "../api/knowledge.js";
import { notes } from "../api/notes.js";

export function KnowledgeScreen() {
  const nav = useNavigate();
  const [q, setQ] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [activeSource, setActiveSource] = useState<{kind: string, ref: string, citation: string} | null>(null);
  
  const sq = useQuery({ queryKey: ["knowledge", submitted], queryFn: () => knowledge.search(submitted), enabled: !!submitted });
  
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
    onSuccess: () => { setSaved(true); setBody(""); setTimeout(() => setSaved(false), 3000); },
  });

  return (
    <div className="relative min-h-[calc(100vh-64px)] flex flex-col">
      {/* Command Center Search */}
      <section className="flex-1 flex flex-col items-center pt-16 px-gutter max-w-5xl mx-auto w-full">
        <div className="w-full max-w-3xl space-y-6">
          <div className="text-center space-y-2 mb-8">
            <h2 className="font-headline-lg text-headline-lg text-on-surface">Universal Knowledge Index</h2>
            <p className="font-code-sm text-on-surface-variant/70 uppercase tracking-widest">Accessing local vault: //{typeof window !== 'undefined' ? window.location.host : 'sys'}/obsidian_core</p>
          </div>
          
          {/* Large Search Bar */}
          <div className="relative group w-full">
            <div className="absolute -inset-1 bg-gradient-to-r from-primary-fixed-dim to-secondary rounded-lg blur opacity-20 group-focus-within:opacity-40 transition duration-500"></div>
            <div className="relative flex items-center bg-surface-container-lowest border border-white/10 glow-border-primary px-6 py-5 rounded">
              <span className="material-symbols-outlined text-primary-fixed-dim text-3xl mr-4">manage_search</span>
              <input 
                className="bg-transparent border-none text-headline-md font-headline-md w-full focus:ring-0 placeholder:text-outline/40 text-on-surface outline-none" 
                placeholder="Search Obsidian Vault..." 
                type="text"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") setSubmitted(q);
                }}
              />
              <button 
                className="bg-primary-fixed-dim text-on-primary font-code-label px-4 py-2 rounded-sm uppercase tracking-widest hover:brightness-110 active:scale-95 transition-all cursor-pointer shadow-[0_0_15px_rgba(0,219,233,0.3)] ml-4"
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
        </div>
      </section>

      {/* Terminal AI Side Panel for Creating Notes */}
      <div 
        className={`fixed right-6 bottom-24 w-[380px] glass-card flex flex-col border border-white/10 shadow-2xl z-50 rounded-lg overflow-hidden transition-transform duration-500 ease-in-out ${terminalOpen ? 'translate-x-0' : 'translate-x-[420px]'}`}
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
        className="fixed right-6 bottom-8 w-14 h-14 flex items-center justify-center bg-secondary text-on-secondary rounded-full shadow-[0_0_20px_rgba(207,92,255,0.4)] hover:scale-105 active:scale-95 transition-all z-40 cursor-pointer" 
        onClick={() => setTerminalOpen(!terminalOpen)}
        title="Save Note"
      >
        <span className="material-symbols-outlined text-3xl">edit_note</span>
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
