import { useState, useEffect } from "react";
import { api } from "../../lib/api.js";
import type { DiffFile } from "../../lib/diff-parse.js";

type SandboxDiffViewerProps = {
  ticketId: string;
  diff: string;
  diffParsed: DiffFile[];
  selectedActivityFile: string | null;
  onActivityFileConsumed: () => void;
  onError: (msg: string) => void;
};

export function SandboxDiffViewer({
  ticketId,
  diff,
  diffParsed,
  selectedActivityFile,
  onActivityFileConsumed,
  onError,
}: SandboxDiffViewerProps) {
  const [diffMode, setDiffMode] = useState<"sbs" | "unified" | "explain">("sbs");
  const [diffExplain, setDiffExplain] = useState<string | null>(null);
  const [explaining, setExplaining] = useState(false);
  const [selectedDiffFile, setSelectedDiffFile] = useState<DiffFile | null>(() => diffParsed[0] || null);

  useEffect(() => {
    setDiffExplain(null);
    setDiffMode("sbs");
  }, [ticketId]);

  useEffect(() => {
    setSelectedDiffFile(diffParsed[0] || null);
  }, [diffParsed]);

  useEffect(() => {
    if (selectedActivityFile && diffParsed.length > 0) {
      const match = diffParsed.find(f => f.path === selectedActivityFile);
      if (match) setSelectedDiffFile(match);
      onActivityFileConsumed();
    }
  }, [selectedActivityFile, diffParsed, onActivityFileConsumed]);

  const fetchExplain = async (fresh = false) => {
    setExplaining(true);
    onError("");
    try {
      const res = await api.post(`/forge/tickets/${ticketId}/explain-diff${fresh ? "?fresh=true" : ""}`);
      setDiffExplain((res as any).summary);
    } catch (e: any) {
      onError(e.message || "Failed to explain diff");
    } finally {
      setExplaining(false);
    }
  };

  return (
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
  );
}
