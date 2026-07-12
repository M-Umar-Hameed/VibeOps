import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api.js";

export function ObsidianIntegrationCard() {
  const queryClient = useQueryClient();
  const [vaultPath, setVaultPath] = useState("");
  const [editingPath, setEditingPath] = useState(false);

  const { data: status, isLoading } = useQuery({
    queryKey: ["obsidian-status"],
    queryFn: async () => {
      return await api.get("/knowledge/obsidian");
    },
    refetchInterval: 5000,
  });

  const startWatcher = useMutation({
    mutationFn: async (path: string) => {
      await api.post("/knowledge/obsidian/start", { vaultPath: path });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["obsidian-status"] });
    },
  });

  const stopWatcher = useMutation({
    mutationFn: async () => {
      await api.post("/knowledge/obsidian/stop");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["obsidian-status"] });
    },
  });

  const handleSavePath = async () => {
    await api.patch("/settings/obsidian.vault_path", { value: vaultPath });
    setEditingPath(false);
    // Re-point the watcher at the new path and refresh status.
    await api.post("/knowledge/obsidian/stop").catch(() => {});
    await api.post("/knowledge/obsidian/start", { vaultPath }).catch(() => {});
    queryClient.invalidateQueries({ queryKey: ["obsidian-status"] });
  };

  return (
    <div className="glass-card rounded-xl overflow-hidden border border-white/10 flex flex-col group hover:border-[#7A52B3]/30 transition-all duration-300">
      <div className="p-6 border-b border-white/5 bg-surface-container/30 flex items-center gap-4">
        <div className="w-10 h-10 bg-[#7A52B3]/20 rounded-full flex items-center justify-center">
          <span className="material-symbols-outlined text-[#7A52B3]">edit_document</span>
        </div>
        <div>
          <h3 className="font-headline-sm text-on-surface font-bold">Knowledge Vault</h3>
          <p className="text-xs text-on-surface-variant">Auto-indexed markdown &middot; Obsidian optional</p>
        </div>
      </div>
      
      <div className="p-6 flex-1 flex flex-col gap-4">
        {isLoading ? (
          <div className="flex-1 flex items-center justify-center">
            <span className="material-symbols-outlined animate-spin text-on-surface-variant/30">progress_activity</span>
          </div>
        ) : (
          <>
            <div>
              <label className="text-xs font-code-sm text-on-surface-variant/70 mb-1 block">Vault Path</label>
              {!editingPath && status?.vaultPath ? (
                <div className="flex items-center gap-2">
                  <span className="text-sm font-code-sm text-on-surface">{status.vaultPath}</span>
                  <button 
                    onClick={() => { setVaultPath(status.vaultPath || ""); setEditingPath(true); }}
                    className="text-xs text-primary hover:underline ml-auto"
                  >
                    Edit
                  </button>
                </div>
              ) : (
                <div className="flex gap-2">
                  <input 
                    type="text" 
                    className="flex-1 bg-surface-container-lowest/50 border border-white/10 rounded px-3 py-2 text-sm text-on-surface focus:border-primary outline-none transition-colors"
                    placeholder="Leave blank for the default ~/.vibeops/vault"
                    value={vaultPath}
                    onChange={(e) => setVaultPath(e.target.value)}
                  />
                  {editingPath && (
                    <button 
                      onClick={handleSavePath}
                      className="px-3 py-1 bg-primary/20 text-primary rounded hover:bg-primary/30"
                    >
                      Save
                    </button>
                  )}
                </div>
              )}
            </div>

            <div className="flex flex-col gap-2 p-3 bg-surface-container-lowest/30 rounded border border-white/5">
              <div className="flex justify-between items-center">
                <span className="text-xs text-on-surface-variant">Status</span>
                <span className={`text-xs font-bold ${status?.isRunning ? "text-green-400" : "text-on-surface-variant"}`}>
                  {status?.isRunning ? "Indexing (Active)" : "Disconnected"}
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-xs text-on-surface-variant">Indexed Files</span>
                <span className="text-xs text-on-surface">{status?.indexedCount ?? 0}</span>
              </div>
              {status?.lastSync && (
                <div className="flex justify-between items-center">
                  <span className="text-xs text-on-surface-variant">Last Sync</span>
                  <span className="text-xs text-on-surface">{new Date(status.lastSync).toLocaleString()}</span>
                </div>
              )}
              {status?.error && (
                <div className="mt-2 text-xs text-red-400 bg-red-400/10 p-2 rounded">
                  {status.error}
                </div>
              )}
            </div>
            
            <button 
              onClick={() => status?.isRunning ? stopWatcher.mutate() : startWatcher.mutate(status?.vaultPath || vaultPath)}
              disabled={startWatcher.isPending || stopWatcher.isPending || (!status?.vaultPath && !vaultPath)}
              className={`mt-auto w-full py-2.5 rounded text-sm font-medium transition-all flex items-center justify-center gap-2 ${
                status?.isRunning 
                  ? "bg-red-500/20 text-red-400 hover:bg-red-500/30" 
                  : "bg-white/5 hover:bg-[#7A52B3] hover:text-white text-on-surface"
              }`}
            >
              <span className="material-symbols-outlined text-sm">
                {status?.isRunning ? "stop_circle" : "play_circle"}
              </span>
              {status?.isRunning ? "Stop Watcher" : "Connect Vault"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
