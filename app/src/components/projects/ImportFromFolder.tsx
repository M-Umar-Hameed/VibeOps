import { useState, useEffect, type FormEvent } from "react";
import { api } from "../../lib/api.js";
import { pickFolder, dialogAvailable } from "../../lib/native-dialog.js";
import { useProject } from "../../context/project.js";

type ScanEntry = { name: string; path: string; isGit: boolean; alreadyProject: boolean };

export function ImportFromFolder() {
  const { refreshProjects } = useProject();
  const [open, setOpen] = useState(false);
  const [canBrowse, setCanBrowse] = useState(false);
  const [folderPath, setFolderPath] = useState("");
  const [entries, setEntries] = useState<ScanEntry[] | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => { dialogAvailable().then(setCanBrowse); }, []);

  const scan = async (path: string) => {
    setError("");
    setBusy(true);
    try {
      const result = (await api.post("/projects/scan", { path })) as ScanEntry[];
      setEntries(result);
      setChecked(new Set(result.filter((e) => e.isGit && !e.alreadyProject).map((e) => e.path)));
    } catch (err: any) {
      setError(err.message || "Failed to scan folder");
      setEntries(null);
    } finally {
      setBusy(false);
    }
  };

  const handleBrowse = async () => {
    const dir = await pickFolder();
    if (dir) { setFolderPath(dir); await scan(dir); }
  };

  const handleScanSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (folderPath) await scan(folderPath);
  };

  const toggle = (path: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  };

  const reset = () => {
    setOpen(false);
    setFolderPath("");
    setEntries(null);
    setChecked(new Set());
    setError("");
  };

  const handleImport = async () => {
    if (!entries) return;
    setError("");
    setBusy(true);
    try {
      const items = entries.filter((e) => checked.has(e.path)).map((e) => ({ name: e.name, path: e.path }));
      await api.post("/projects/import", { items });
      await refreshProjects();
      reset();
    } catch (err: any) {
      setError(err.message || "Failed to import");
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full flex items-center gap-2 px-4 py-2 text-sm text-on-surface-variant hover:text-primary hover:bg-primary/10 rounded transition-all"
      >
        <span className="material-symbols-outlined text-sm">folder_open</span>
        Import from folder...
      </button>
    );
  }

  return (
    <div className="p-3 bg-white/5 rounded border border-white/10 flex flex-col gap-3">
      <form onSubmit={handleScanSubmit} className="flex gap-2">
        <input
          type="text"
          placeholder="Folder path..."
          value={folderPath}
          onChange={(e) => setFolderPath(e.target.value)}
          disabled={busy}
          className="flex-1 min-w-0 bg-surface-container-lowest/50 border border-white/10 rounded px-2 py-1.5 text-sm text-on-surface focus:border-primary outline-none"
        />
        {canBrowse ? (
          <button type="button" onClick={handleBrowse} disabled={busy} className="shrink-0 px-3 py-1.5 rounded bg-primary text-on-primary hover:opacity-90 text-sm font-medium disabled:opacity-50">
            Browse
          </button>
        ) : (
          <button type="submit" disabled={!folderPath || busy} className="shrink-0 px-3 py-1.5 rounded bg-primary text-on-primary hover:opacity-90 text-sm font-medium disabled:opacity-50">
            Scan
          </button>
        )}
      </form>

      {error && <div className="text-xs text-error font-code-sm">{error}</div>}

      {entries && (
        <div className="flex flex-col gap-2">
          {entries.length === 0 && (
            <div className="text-xs text-on-surface-variant">No subdirectories found.</div>
          )}
          {entries.map((e) => (
            <label key={e.path} className="flex items-center gap-2 text-sm text-on-surface">
              <input
                type="checkbox"
                checked={checked.has(e.path)}
                disabled={e.alreadyProject}
                onChange={() => toggle(e.path)}
              />
              <span className="truncate flex-1">{e.name}</span>
              <span className="text-xs text-on-surface-variant">
                {e.alreadyProject ? "already imported" : e.isGit ? "git" : "not git"}
              </span>
            </label>
          ))}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleImport}
              disabled={busy || checked.size === 0}
              className="flex-1 py-1.5 rounded bg-white/10 hover:bg-primary hover:text-on-primary text-sm font-medium transition-colors disabled:opacity-50"
            >
              Import ({checked.size})
            </button>
            <button type="button" onClick={reset} disabled={busy} className="px-3 py-1.5 rounded hover:bg-white/5 text-sm text-on-surface-variant transition-colors">
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
