import { useEffect } from "react";
import type { ReactNode } from "react";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Project } from "../../api/types.js";
import { api } from "../../lib/api.js";
import { useProject } from "../../context/project.js";
import { openRepoFolder } from "../../lib/native-dialog.js";

const MENU_W = 240;
const MENU_H = 260;

function MenuItem({ children, onClick, disabled, danger }: {
  children: ReactNode; onClick?: () => void; disabled?: boolean; danger?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      className={`w-full text-left px-3 py-2 text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
        danger ? "text-error hover:bg-error/10" : "text-on-surface hover:bg-white/5"
      }`}
    >
      {children}
    </button>
  );
}

function ConfirmView({ kind, project, pending, error, onCancel, onConfirm }: {
  kind: "clear" | "delete"; project: Project; pending: boolean; error: string;
  onCancel: () => void; onConfirm: () => void;
}) {
  const title = kind === "delete" ? "Delete project" : "Clear knowledge";
  const message = kind === "delete"
    ? `Delete "${project.name}"? Removes the project and all its tickets, comments, notes, and indexed knowledge from VibeOps. Files on disk are NOT touched.`
    : `Clear knowledge for "${project.name}"? Removes all indexed chunks so the project can be re-indexed. Tickets and notes are kept.`;
  return (
    <div className="px-3 py-2 flex flex-col gap-2">
      <div className="text-xs font-medium text-error">{title}</div>
      <div className="text-xs text-on-surface-variant leading-snug">{message}</div>
      {error && <div className="text-xs text-error font-code-sm">{error}</div>}
      <div className="flex gap-2 pt-1">
        <button
          type="button"
          onClick={onConfirm}
          disabled={pending}
          className="flex-1 px-2 py-1 rounded bg-error/10 hover:bg-error/20 text-error border border-error/30 text-xs font-medium disabled:opacity-50"
        >
          {kind === "delete" ? "Delete" : "Clear"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={pending}
          className="px-3 py-1 rounded bg-white/10 hover:bg-white/20 text-xs text-on-surface disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

export function ProjectContextMenu({ project, x, y, onClose }: {
  project: Project; x: number; y: number; onClose: () => void;
}) {
  const { setActiveProject, refreshProjects } = useProject();
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState<null | "clear" | "delete">(null);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const left = Math.max(0, Math.min(x, window.innerWidth - MENU_W));
  const top = Math.max(0, Math.min(y, window.innerHeight - MENU_H));

  const run = async (fn: () => Promise<void>) => {
    setPending(true);
    setError("");
    try {
      await fn();
    } catch (e: any) {
      setError(e instanceof Error ? e.message : "Action failed");
    } finally {
      setPending(false);
    }
  };

  const handleSetActive = () => { setActiveProject(project.id); onClose(); };

  const handleOpenFolder = () => {
    if (!project.repoPath) return;
    void openRepoFolder(project.repoPath);
    onClose();
  };

  const handleIndex = () => run(async () => {
    const r: any = await api.post(`/projects/${project.id}/index-repo`);
    setNotice(`indexed ${r.indexed}, skipped ${r.skipped}, removed ${r.removed}`);
  });

  const handleClear = () => run(async () => {
    const r: any = await api.del(`/projects/${project.id}/knowledge`);
    setConfirm(null);
    setNotice(`removed ${r.removed} chunk(s)`);
  });

  const handleDelete = () => run(async () => {
    await api.del(`/projects/${project.id}`);
    await refreshProjects();
    queryClient.invalidateQueries({ queryKey: ["projects"] });
    onClose();
  });

  return (
    <>
      <div className="fixed inset-0 z-[60]" onClick={onClose} data-testid="context-menu-backdrop" />
      <div
        role="menu"
        aria-label={`Actions for ${project.name}`}
        className="fixed z-[61] w-[240px] bg-surface-container border border-white/10 rounded-lg shadow-xl py-1"
        style={{ left, top }}
      >
        {confirm === null ? (
          <>
            <MenuItem onClick={handleSetActive}>Set as active</MenuItem>
            <MenuItem onClick={handleIndex} disabled={!project.repoPath || pending}>Index docs</MenuItem>
            <MenuItem onClick={handleOpenFolder} disabled={!project.repoPath}>Open repo folder</MenuItem>
            <div className="my-1 border-t border-white/5" />
            <MenuItem danger onClick={() => setConfirm("clear")}>Clear knowledge</MenuItem>
            <MenuItem danger onClick={() => setConfirm("delete")}>Delete project</MenuItem>
            {notice && <div role="status" className="px-3 py-1.5 text-xs text-on-surface-variant font-code-sm">{notice}</div>}
            {error && <div className="px-3 py-1.5 text-xs text-error font-code-sm">{error}</div>}
          </>
        ) : (
          <ConfirmView
            kind={confirm}
            project={project}
            pending={pending}
            error={error}
            onCancel={() => { setConfirm(null); setError(""); }}
            onConfirm={confirm === "clear" ? handleClear : handleDelete}
          />
        )}
      </div>
    </>
  );
}
