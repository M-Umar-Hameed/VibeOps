import { useState, useEffect } from "react";
import { Link, useLocation } from "@tanstack/react-router";
import { useProject } from "../../context/project.js";
import { projects as projectsApi } from "../../api/projects.js";
import { api } from "../../lib/api.js";
import { pickFolder, dialogAvailable } from "../../lib/native-dialog.js";

export function Sidebar({ isOpen = false, setIsOpen = (_v: boolean) => {} }) {
  const location = useLocation();
  const path = location.pathname;
  const { projects, activeProjectId, setActiveProject, refreshProjects } = useProject();

  const isActive = (route: string) => path === route;

  const [isAdding, setIsAdding] = useState(false);
  const [addName, setAddName] = useState("");
  const [addKey, setAddKey] = useState("");
  const [keyTouched, setKeyTouched] = useState(false);
  const [addPath, setAddPath] = useState("");
  const [addError, setAddError] = useState("");
  const [needsGitInitFor, setNeedsGitInitFor] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [canBrowse, setCanBrowse] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);

  useEffect(() => {
    dialogAvailable().then(setCanBrowse);
  }, []);

  const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    setAddName(v);
    if (!keyTouched) {
      setAddKey(v.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""));
    }
  };

  const resetForm = () => {
    setAddName("");
    setAddKey("");
    setAddPath("");
    setKeyTouched(false);
    setAddError("");
    setNeedsGitInitFor(null);
    setIsAdding(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAddError("");
    setIsSubmitting(true);
    try {
      const newProject = await projectsApi.create({
        name: addName,
        key: addKey || addName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""),
      });
      let isGit = newProject.isGit;
      if (addPath) {
        const patched = await api.patch(`/projects/${newProject.id}`, { repoPath: addPath }) as any;
        isGit = patched.isGit;
      }
      await refreshProjects();
      setActiveProject(newProject.id);

      if (addPath && isGit === false) {
        setNeedsGitInitFor(newProject.id);
      } else {
        resetForm();
      }
    } catch (err: any) {
      setAddError(err.message || "Failed to create project");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleInitGit = async () => {
    if (!needsGitInitFor) return;
    setAddError("");
    setIsSubmitting(true);
    try {
      await api.post(`/projects/${needsGitInitFor}/git-init`);
      await refreshProjects();
      resetForm();
    } catch (err: any) {
      setAddError(err.message || "Failed to initialize git");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <aside className={`fixed left-0 top-0 h-full w-[280px] bg-surface-container/95 md:bg-surface-container/60 backdrop-blur-xl border-r border-white/10 flex flex-col py-6 z-50 transform transition-transform duration-300 md:translate-x-0 ${isOpen ? "translate-x-0" : "-translate-x-full"}`}>
      <div className="px-6 mb-10 shrink-0">
        <h1 className="font-headline-md text-headline-md font-bold text-primary tracking-tighter">VibeOps</h1>
        <p className="font-code-label text-code-label text-on-surface-variant opacity-60">Terminal Access</p>
      </div>
      
      <div className="flex-1 overflow-y-auto overflow-x-hidden flex flex-col">
        <nav className="space-y-1 mb-8">
          <Link
            to="/"
            onClick={() => setIsOpen(false)}
            className={`flex items-center gap-3 px-4 py-3 transition-all duration-200 active:scale-[0.98] ${
              isActive("/")
                ? "border-l-2 border-primary-fixed-dim bg-primary-fixed-dim/5 text-primary-fixed-dim"
                : "text-on-surface-variant hover:bg-white/5 hover:text-on-surface"
            }`}
          >
            <span className="material-symbols-outlined" style={{ fontVariationSettings: isActive("/") ? "'FILL' 1" : "" }}>dashboard</span>
            <span className="font-body-md">Board</span>
          </Link>
          <Link
            to="/forge"
            onClick={() => setIsOpen(false)}
            className={`flex items-center gap-3 px-4 py-3 transition-all duration-200 active:scale-[0.98] ${
              isActive("/forge")
                ? "border-l-2 border-primary-fixed-dim bg-primary-fixed-dim/5 text-primary-fixed-dim"
                : "text-on-surface-variant hover:bg-white/5 hover:text-on-surface"
            }`}
          >
            <span className="material-symbols-outlined" style={{ fontVariationSettings: isActive("/forge") ? "'FILL' 1" : "" }}>construction</span>
            <span className="font-body-md">Forge</span>
          </Link>
          <Link
            to="/settings"
            search={{ tab: "ai" }}
            onClick={() => setIsOpen(false)}
            className={`flex items-center gap-3 px-4 py-3 transition-all duration-200 active:scale-[0.98] ${
              isActive("/settings")
                ? "border-l-2 border-primary-fixed-dim bg-primary-fixed-dim/5 text-primary-fixed-dim"
                : "text-on-surface-variant hover:bg-white/5 hover:text-on-surface"
            }`}
          >
            <span className="material-symbols-outlined" style={{ fontVariationSettings: isActive("/settings") ? "'FILL' 1" : "" }}>insights</span>
            <span className="font-body-md">Usage</span>
          </Link>
          <Link
            to="/settings"
            onClick={() => setIsOpen(false)}
            className={`flex items-center gap-3 px-4 py-3 transition-all duration-200 active:scale-[0.98] ${
              isActive("/settings")
                ? "border-l-2 border-primary-fixed-dim bg-primary-fixed-dim/5 text-primary-fixed-dim"
                : "text-on-surface-variant hover:bg-white/5 hover:text-on-surface"
            }`}
          >
            <span className="material-symbols-outlined" style={{ fontVariationSettings: isActive("/settings") ? "'FILL' 1" : "" }}>settings</span>
            <span className="font-body-md">Settings</span>
          </Link>
        </nav>

        <button
          onClick={() => setLibraryOpen(!libraryOpen)}
          className="w-full px-4 mb-2 flex items-center justify-between text-on-surface-variant hover:text-on-surface transition-colors"
        >
          <span className="text-xs font-bold uppercase tracking-wider pl-2">Library</span>
          <span className={`material-symbols-outlined text-sm transition-transform duration-200 ${libraryOpen ? "rotate-180" : ""}`}>expand_more</span>
        </button>
        {libraryOpen && (
          <nav className="space-y-1 mb-8">
            <Link
              to="/knowledge"
              onClick={() => setIsOpen(false)}
              className={`flex items-center gap-3 px-4 py-3 transition-all duration-200 active:scale-[0.98] ${
                isActive("/knowledge")
                  ? "border-l-2 border-primary-fixed-dim bg-primary-fixed-dim/5 text-primary-fixed-dim"
                  : "text-on-surface-variant hover:bg-white/5 hover:text-on-surface"
              }`}
            >
              <span className="material-symbols-outlined" style={{ fontVariationSettings: isActive("/knowledge") ? "'FILL' 1" : "" }}>analytics</span>
              <span className="font-body-md">Knowledge</span>
            </Link>
            <Link
              to="/create"
              onClick={() => setIsOpen(false)}
              className={`flex items-center gap-3 px-4 py-3 transition-all duration-200 active:scale-[0.98] ${
                isActive("/create")
                  ? "border-l-2 border-primary-fixed-dim bg-primary-fixed-dim/5 text-primary-fixed-dim"
                  : "text-on-surface-variant hover:bg-white/5 hover:text-on-surface"
              }`}
            >
              <span className="material-symbols-outlined" style={{ fontVariationSettings: isActive("/create") ? "'FILL' 1" : "" }}>confirmation_number</span>
              <span className="font-body-md">New Work Order</span>
            </Link>
          </nav>
        )}

        <div className="px-4 mb-2">
          <h2 className="text-xs font-bold text-on-surface-variant uppercase tracking-wider pl-2">Projects</h2>
        </div>
        <div className="space-y-1">
          <button
            onClick={() => { setActiveProject(null); setIsOpen(false); }}
            className={`w-full flex items-center gap-3 px-4 py-3 transition-all duration-200 active:scale-[0.98] ${
              activeProjectId === null
                ? "border-l-2 border-primary-fixed-dim bg-primary-fixed-dim/5 text-primary-fixed-dim"
                : "text-on-surface-variant hover:bg-white/5 hover:text-on-surface"
            }`}
          >
            <span className="material-symbols-outlined" style={{ fontVariationSettings: activeProjectId === null ? "'FILL' 1" : "" }}>all_inclusive</span>
            <span className="font-body-md">All projects</span>
          </button>
          
          {projects.map(p => (
            <button
              key={p.id}
              onClick={() => { setActiveProject(p.id); setIsOpen(false); }}
              className={`w-full flex items-center gap-3 px-4 py-3 transition-all duration-200 active:scale-[0.98] ${
                activeProjectId === p.id
                  ? "border-l-2 border-primary-fixed-dim bg-primary-fixed-dim/5 text-primary-fixed-dim"
                  : "text-on-surface-variant hover:bg-white/5 hover:text-on-surface"
              }`}
            >
              <span className="material-symbols-outlined text-lg" style={{ fontVariationSettings: activeProjectId === p.id ? "'FILL' 1" : "" }}>folder</span>
              <div className="flex flex-col items-start truncate">
                <span className="font-body-md truncate">{p.name}</span>
                {p.repoPath && (
                  <span className="text-xs text-on-surface-variant/60 truncate">
                    {p.repoPath.split(/[\\/]/).pop()}
                  </span>
                )}
              </div>
            </button>
          ))}

          <div className="pt-2 px-2">
            {!isAdding ? (
              <button
                onClick={() => setIsAdding(true)}
                className="w-full flex items-center gap-2 px-4 py-2 text-sm text-on-surface-variant hover:text-primary hover:bg-primary/10 rounded transition-all"
              >
                <span className="material-symbols-outlined text-sm">add</span>
                Add project
              </button>
            ) : (
              <form onSubmit={handleSubmit} className="p-3 bg-white/5 rounded border border-white/10 flex flex-col gap-3">
                <input
                  type="text"
                  placeholder="Project name"
                  value={addName}
                  onChange={handleNameChange}
                  disabled={isSubmitting || !!needsGitInitFor}
                  required
                  className="w-full bg-surface-container-lowest/50 border border-white/10 rounded px-2 py-1.5 text-sm text-on-surface focus:border-primary outline-none"
                />
                <input
                  type="text"
                  placeholder="Project key"
                  value={addKey}
                  onChange={(e) => { setAddKey(e.target.value); setKeyTouched(true); }}
                  disabled={isSubmitting || !!needsGitInitFor}
                  required
                  className="w-full bg-surface-container-lowest/50 border border-white/10 rounded px-2 py-1.5 text-sm text-on-surface focus:border-primary outline-none font-code-sm"
                />
                <div className="flex gap-2">
                  <input
                    type="text"
                    placeholder="Choose a folder... (optional)"
                    value={addPath}
                    onChange={(e) => setAddPath(e.target.value)}
                    disabled={isSubmitting || !!needsGitInitFor}
                    className="flex-1 min-w-0 bg-surface-container-lowest/50 border border-white/10 rounded px-2 py-1.5 text-sm text-on-surface focus:border-primary outline-none"
                  />
                  {canBrowse && (
                    <button
                      type="button"
                      onClick={async () => {
                        const dir = await pickFolder();
                        if (dir) setAddPath(dir);
                      }}
                      disabled={isSubmitting || !!needsGitInitFor}
                      className="shrink-0 px-3 py-1.5 rounded bg-primary text-on-primary hover:opacity-90 text-sm font-medium disabled:opacity-50"
                    >
                      Browse
                    </button>
                  )}
                </div>
                
                {addError && <div className="text-xs text-error font-code-sm">{addError}</div>}
                
                {needsGitInitFor ? (
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={handleInitGit}
                      disabled={isSubmitting}
                      className="flex-1 py-1.5 rounded bg-primary text-on-primary text-sm font-medium hover:opacity-90 disabled:opacity-50"
                    >
                      Initialize git
                    </button>
                    <button
                      type="button"
                      onClick={resetForm}
                      disabled={isSubmitting}
                      className="px-3 py-1.5 rounded bg-white/10 hover:bg-white/20 text-sm text-on-surface"
                    >
                      Skip
                    </button>
                  </div>
                ) : (
                  <div className="flex gap-2">
                    <button
                      type="submit"
                      disabled={isSubmitting || !addName || !addKey}
                      className="flex-1 py-1.5 rounded bg-white/10 hover:bg-primary hover:text-on-primary text-sm font-medium transition-colors disabled:opacity-50"
                    >
                      Add
                    </button>
                    <button
                      type="button"
                      onClick={resetForm}
                      disabled={isSubmitting}
                      className="px-3 py-1.5 rounded hover:bg-white/5 text-sm text-on-surface-variant transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </form>
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}
