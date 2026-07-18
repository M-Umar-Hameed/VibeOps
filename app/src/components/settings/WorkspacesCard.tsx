import { useState, useEffect, type FormEvent } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api.js";
import type { Project } from "../../api/types.js";

export function WorkspacesCard() {
  const queryClient = useQueryClient();
  const [editBuffers, setEditBuffers] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  const { data: projects = [], isLoading, error: fetchError } = useQuery<Project[]>({
    queryKey: ["projects"],
    queryFn: async () => await api.get("/projects"),
  });

  useEffect(() => {
    if (projects.length > 0) {
      setEditBuffers((prev) => {
        const next = { ...prev };
        let changed = false;
        projects.forEach((p) => {
          if (next[p.id] === undefined) {
            next[p.id] = p.repoPath || "";
            changed = true;
          }
        });
        return changed ? next : prev;
      });
    }
  }, [projects]);

  const savePath = useMutation({
    mutationFn: async ({ id, repoPath }: { id: string; repoPath: string }) => {
      await api.patch(`/projects/${id}`, { repoPath });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
  });

  const initGit = useMutation({
    mutationFn: async (id: string) => {
      await api.post(`/projects/${id}/git-init`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
  });

  const handleSave = (e: FormEvent, p: Project) => {
    e.preventDefault();
    setErrors((prev) => ({ ...prev, [p.id]: "" }));
    savePath.mutate(
      { id: p.id, repoPath: editBuffers[p.id] || "" },
      {
        onError: (err: any) => {
          setErrors((prev) => ({
            ...prev,
            [p.id]: err instanceof Error ? err.message : "Failed to save path",
          }));
        },
      }
    );
  };

  const handleInitGit = (p: Project) => {
    setErrors((prev) => ({ ...prev, [p.id]: "" }));
    initGit.mutate(p.id, {
      onError: (err: any) => {
        setErrors((prev) => ({
          ...prev,
          [p.id]: err instanceof Error ? err.message : "Failed to initialize git",
        }));
      },
    });
  };

  return (
    <div className="glass-card rounded-xl overflow-hidden border border-white/10 flex flex-col group hover:border-primary/30 transition-all duration-300">
      <div className="p-6 border-b border-white/5 bg-surface-container/30 flex items-center gap-4">
        <div className="w-10 h-10 bg-primary/20 rounded-full flex items-center justify-center">
          <span className="material-symbols-outlined text-primary">folder</span>
        </div>
        <div>
          <h3 className="font-headline-sm text-on-surface font-bold">Workspaces</h3>
          <p className="text-xs text-on-surface-variant">Local repositories for projects</p>
        </div>
      </div>

      <div className="p-6 flex-1 flex flex-col gap-4">
        {fetchError && (
          <div className="bg-error-container/20 border border-error p-4 rounded text-error text-sm font-code-sm">
            {fetchError instanceof Error ? fetchError.message : "Failed to load projects"}
          </div>
        )}

        {isLoading ? (
          <div className="flex-1 flex items-center justify-center py-8">
            <span className="material-symbols-outlined animate-spin text-on-surface-variant/30">progress_activity</span>
          </div>
        ) : (
          <div className="flex flex-col gap-6">
            {projects.map((p) => {
              const editValue = editBuffers[p.id] ?? p.repoPath ?? "";
              const originalValue = p.repoPath ?? "";
              const isDirty = editValue !== originalValue;

              return (
                <div key={p.id} className="flex flex-col gap-2 pb-6 border-b border-white/5 last:border-0 last:pb-0">
                  <div className="flex items-center gap-3">
                    <span className="text-sm text-on-surface font-medium">{p.name}</span>
                    <span className="text-xs px-2 py-1 rounded bg-white/5 text-on-surface-variant">{p.key}</span>
                  </div>

                  <form onSubmit={(e) => handleSave(e, p)} className="flex gap-2">
                    <input
                      type="text"
                      className="flex-1 min-w-0 bg-surface-container-lowest/50 border border-white/10 rounded px-3 py-2 text-sm text-on-surface focus:border-primary outline-none transition-colors"
                      placeholder="Absolute folder path"
                      value={editValue}
                      onChange={(e) => setEditBuffers((prev) => ({ ...prev, [p.id]: e.target.value }))}
                    />
                    <button
                      type="submit"
                      disabled={!isDirty || savePath.isPending}
                      className="shrink-0 px-4 py-2 rounded bg-white/5 hover:bg-primary hover:text-on-primary text-on-surface text-sm font-medium transition-all disabled:opacity-50"
                    >
                      Save
                    </button>
                  </form>

                  <div className="flex items-center gap-3 mt-1">
                    {p.isGit ? (
                      <span className="text-xs px-2 py-1 rounded bg-green-500/20 text-green-400 font-medium">git</span>
                    ) : p.repoPath ? (
                      <>
                        <span className="text-xs px-2 py-1 rounded bg-amber-500/20 text-amber-400 font-medium">not git</span>
                        <button
                          type="button"
                          onClick={() => handleInitGit(p)}
                          disabled={initGit.isPending}
                          className="text-xs px-3 py-1 rounded bg-white/5 hover:bg-primary hover:text-on-primary text-on-surface font-medium transition-all disabled:opacity-50"
                        >
                          Initialize git
                        </button>
                      </>
                    ) : (
                      <span className="text-xs px-2 py-1 rounded bg-white/5 text-on-surface-variant font-medium">default workdir</span>
                    )}
                  </div>

                  {errors[p.id] && (
                    <div className="text-xs text-error font-code-sm">{errors[p.id]}</div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
