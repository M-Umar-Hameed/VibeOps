import { useState, useEffect, type FormEvent } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api.js";

export interface ProjectBindingsCardProps {
  id: string; // connector slug for callers/keys; not used internally
  projectId: string;
  // e.g. "github"
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  borderColorClass: string;
  bindingKey: string;
  label: string;
  placeholder?: string;
  globalCredentialKey: string;
}

export function ProjectBindingsCard({
  projectId,
  title,
  subtitle,
  icon,
  borderColorClass,
  bindingKey,
  label,
  placeholder,
  globalCredentialKey,
}: ProjectBindingsCardProps) {
  const queryClient = useQueryClient();
  const [value, setValue] = useState("");
  const [isEditing, setIsEditing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  const { data: projectSettings } = useQuery({
    queryKey: ["projects", projectId, "settings"],
    queryFn: async () => {
      return await api.get(`/projects/${projectId}/settings`);
    },
  });

  const { data: globalSetting } = useQuery({
    queryKey: ["settings", globalCredentialKey],
    queryFn: async () => {
      return await api.get(`/settings/${globalCredentialKey}`);
    },
  });

  useEffect(() => {
    if (projectSettings && !isEditing) {
      setValue(projectSettings[bindingKey] || "");
    }
  }, [projectSettings, isEditing, bindingKey]);

  const saveMutation = useMutation({
    mutationFn: async (newValue: string) => {
      await api.put(`/projects/${projectId}/settings/${bindingKey}`, { value: newValue });
    },
    onSuccess: (_data, newValue) => {
      queryClient.invalidateQueries({ queryKey: ["projects", projectId, "settings"] });
      setIsEditing(false);
      if (newValue) triggerSync();
    },
  });

  const syncMutation = useMutation({
    mutationFn: async () => await api.post(`/sync/${projectId}`) as {
      created: number; updated: number; skipped: number; commentsAdded: number; failed: number; bindings: number;
    },
    onSuccess: (r) => {
      setSyncMsg(r.bindings === 0
        ? "Nothing bound to sync yet."
        : `Synced: ${r.created} created, ${r.updated} updated${r.failed ? `, ${r.failed} failed` : ""}.`);
      queryClient.invalidateQueries({ queryKey: ["tickets"] });
    },
    onError: (e: any) => setSyncMsg(`Sync failed: ${e?.message ?? "error"}`),
  });

  const triggerSync = () => {
    if (!globalSetting?.value) { setSyncMsg(`Set your ${title} token in Integrations to sync.`); return; }
    setSyncMsg(null);
    syncMutation.mutate();
  };

  const handleSave = (e: FormEvent) => {
    e.preventDefault();
    saveMutation.mutate(value);
  };

  const handleClear = () => {
    setValue("");
    saveMutation.mutate("");
  };

  const isBound = !!projectSettings?.[bindingKey] && !isEditing;
  const hasGlobalCredential = !!globalSetting?.value;

  return (
    <div className={`glass-card rounded-xl overflow-hidden border border-white/10 flex flex-col group hover:border-${borderColorClass} transition-all duration-300`}>
      <div className="p-6 border-b border-white/5 bg-surface-container/30 flex items-center gap-4">
        {icon}
        <div className="flex-1">
          <h3 className="font-headline-sm text-on-surface font-bold flex items-center gap-2">
            {title}
            {hasGlobalCredential && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-500/20 text-green-400 font-medium tracking-wide">
                CONFIGURED
              </span>
            )}
          </h3>
          <p className="text-xs text-on-surface-variant">{subtitle}</p>
        </div>
      </div>
      
      <div className="p-6 flex-1 flex flex-col gap-4">
        {isBound ? (
          <div className="flex-1 flex flex-col gap-4 justify-center">
            <div className="flex flex-col gap-1">
              <span className="text-xs font-code-sm text-on-surface-variant/70">{label}</span>
              <span className="text-sm text-on-surface font-medium truncate">{projectSettings[bindingKey]}</span>
            </div>
            <button
              onClick={triggerSync}
              disabled={syncMutation.isPending}
              className="w-full py-2.5 rounded bg-white/5 hover:bg-white/10 text-on-surface text-sm font-medium transition-all disabled:opacity-50 cursor-pointer"
            >
              {syncMutation.isPending ? "Syncing..." : "Sync now"}
            </button>
            <button 
              onClick={() => setIsEditing(true)}
              className="mt-auto w-full py-2.5 rounded bg-white/5 hover:bg-white/10 text-on-surface text-sm font-medium transition-all cursor-pointer"
            >
              Edit Binding
            </button>
            {syncMsg && <p className="text-xs text-on-surface-variant">{syncMsg}</p>}
          </div>
        ) : (
          <form onSubmit={handleSave} className="flex flex-col flex-1 gap-4">
            <div>
              <label className="text-xs font-code-sm text-on-surface-variant/70 mb-1 block">
                {label}
              </label>
              <input 
                type="text" 
                className="w-full bg-surface-container-lowest/50 border border-white/10 rounded px-3 py-2 text-sm text-on-surface focus:border-primary outline-none transition-colors"
                placeholder={placeholder}
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            </div>
            
            <p className="text-[10px] text-on-surface-variant/60 italic mt-auto">
              Credentials are global — set them in All projects
            </p>
            
            <div className="flex gap-2">
              <button 
                type="submit"
                disabled={saveMutation.isPending || (!value && !projectSettings?.[bindingKey])}
                className="flex-1 py-2.5 rounded bg-white/5 hover:bg-primary hover:text-on-primary text-on-surface text-sm font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
              >
                {saveMutation.isPending ? 'Saving...' : 'Save'}
              </button>
              {projectSettings?.[bindingKey] && (
                <button
                  type="button"
                  onClick={handleClear}
                  disabled={saveMutation.isPending}
                  className="px-4 py-2.5 rounded bg-error/10 hover:bg-error/20 text-error text-sm font-medium transition-all disabled:opacity-50"
                >
                  Clear
                </button>
              )}
            </div>
            {syncMsg && <p className="text-xs text-on-surface-variant">{syncMsg}</p>}
          </form>
        )}
      </div>
    </div>
  );
}
