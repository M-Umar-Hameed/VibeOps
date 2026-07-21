import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api.js";

interface ProviderCardProps {
  settingKey: string;
  name: string;
  subtitle: string;
  icon: React.ReactNode;
  placeholder: string;
  borderColorClass: string;
  note?: string;
  extra?: React.ReactNode;
}

export function ProviderCard({ settingKey, name, subtitle, icon, placeholder, borderColorClass, note, extra }: ProviderCardProps) {
  const queryClient = useQueryClient();
  const [value, setValue] = useState("");
  const [isEditing, setIsEditing] = useState(false);
  const [showSaved, setShowSaved] = useState(false);

  const { data: setting, isLoading } = useQuery({
    queryKey: ["settings", settingKey],
    queryFn: async () => {
      const res = await api.get(`/settings/${settingKey}`);
      return res.value || "";
    },
  });

  useEffect(() => {
    if (setting !== undefined && !isEditing) {
      setValue(setting);
    }
  }, [setting, isEditing]);

  const saveMutation = useMutation({
    mutationFn: async (newValue: string) => {
      await api.patch(`/settings/${settingKey}`, { value: newValue });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings", settingKey] });
      setIsEditing(false);
      setShowSaved(true);
      setTimeout(() => setShowSaved(false), 2000);
    },
  });

  const hasValue = Boolean(setting);
  
  return (
    <div className={`glass-card rounded-xl overflow-hidden border border-white/10 flex flex-col md:flex-row md:items-center gap-6 p-6 group hover:border-${borderColorClass} transition-all duration-300`}>
      <div className="flex items-center gap-4 md:w-[260px] md:shrink-0">
        {icon}
        <div className="min-w-0">
          <h3 className="font-headline-sm text-on-surface font-bold">{name}</h3>
          <p className="text-xs text-on-surface-variant">{subtitle}</p>
          {note && <p className="text-[11px] text-on-surface-variant/60 mt-1">{note}</p>}
          {extra}
        </div>
      </div>
      
      <div className="flex-1 flex flex-col md:flex-row gap-4 items-end">
        <div className="flex-1 w-full">
          <label className="text-xs font-code-sm text-on-surface-variant/70 mb-1 block">API Key</label>
          
          {!isEditing && hasValue ? (
            <div className="w-full bg-surface-container-lowest/30 border border-white/5 rounded px-3 py-2 flex justify-between items-center h-[38px]">
              <span className="text-sm font-code-sm text-on-surface-variant flex items-center gap-2 min-w-0">
                <span className="w-2 h-2 rounded-full bg-green-500/80 shrink-0"></span>
                <span className="whitespace-nowrap truncate">Connected (•••• {setting?.slice(-4) || ""})</span>
              </span>
              <button 
                onClick={() => setIsEditing(true)}
                className="text-xs text-primary hover:underline shrink-0 ml-2 whitespace-nowrap"
              >
                Change
              </button>
            </div>
          ) : (
            <input 
              type="password" 
              className="w-full bg-surface-container-lowest/50 border border-white/10 rounded px-3 py-2 text-sm text-on-surface focus:border-primary outline-none transition-colors h-[38px]"
              placeholder={placeholder}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              disabled={isLoading || saveMutation.isPending}
            />
          )}
        </div>
        
        {(!hasValue || isEditing) && (
          <button 
            onClick={() => saveMutation.mutate(value)}
            disabled={saveMutation.isPending || isLoading}
            className="px-6 py-2 rounded bg-white/5 hover:bg-primary hover:text-on-primary text-on-surface text-sm font-medium transition-all h-[38px] flex items-center gap-2 min-w-[90px] justify-center"
          >
            {saveMutation.isPending ? (
              <span className="material-symbols-outlined text-sm animate-spin">progress_activity</span>
            ) : showSaved ? (
              <>
                <span className="material-symbols-outlined text-sm text-green-400">check</span>
                Saved
              </>
            ) : (
              "Save"
            )}
          </button>
        )}
      </div>
    </div>
  );
}
