import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api.js";

export interface IntegrationField {
  key: string;
  label: string;
  placeholder?: string;
  type?: "text" | "password";
  link?: { text: string; url: string };
}

export interface PlatformIntegrationCardProps {
  id: string; // e.g. "github"
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  borderColorClass: string;
  fields: IntegrationField[];
}

export function PlatformIntegrationCard({ id, title, subtitle, icon, borderColorClass, fields }: PlatformIntegrationCardProps) {
  const queryClient = useQueryClient();
  const [values, setValues] = useState<Record<string, string>>({});
  const [isEditing, setIsEditing] = useState(false);

  const { data: settingsData } = useQuery({
    queryKey: ["settings", id],
    queryFn: async () => {
      const results: Record<string, string> = {};
      for (const field of fields) {
        const res = await api.get(`/settings/${field.key}`);
        results[field.key] = res.value || "";
      }
      return results;
    }
  });

  useEffect(() => {
    if (settingsData && !isEditing) {
      setValues(settingsData);
    }
  }, [settingsData, isEditing]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      for (const field of fields) {
        if (values[field.key]) {
          await api.patch(`/settings/${field.key}`, { value: values[field.key] });
        }
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings", id] });
      setIsEditing(false);
    }
  });

  const isConnected = fields.every(f => !!settingsData?.[f.key]) && !isEditing;

  return (
    <div className={`glass-card rounded-xl overflow-hidden border border-white/10 flex flex-col group hover:border-${borderColorClass} transition-all duration-300`}>
      <div className="p-6 border-b border-white/5 bg-surface-container/30 flex items-center gap-4">
        {icon}
        <div>
          <h3 className="font-headline-sm text-on-surface font-bold">{title}</h3>
          <p className="text-xs text-on-surface-variant">{subtitle}</p>
        </div>
      </div>
      
      <div className="p-6 flex-1 flex flex-col gap-4">
        {isConnected ? (
          <div className="flex-1 flex flex-col gap-4 justify-center">
            <div className="flex items-center gap-2 text-green-400 font-code-sm text-sm">
              <span className="material-symbols-outlined">check_circle</span>
              Connected
            </div>
            <button 
              onClick={() => setIsEditing(true)}
              className="mt-auto w-full py-2.5 rounded bg-white/5 hover:bg-white/10 text-on-surface text-sm font-medium transition-all cursor-pointer"
            >
              Configure
            </button>
          </div>
        ) : (
          <>
            {fields.map(field => (
              <div key={field.key}>
                <label className="text-xs font-code-sm text-on-surface-variant/70 mb-1 block flex justify-between">
                  <span>{field.label}</span>
                  {field.link && (
                    <a href={field.link.url} target="_blank" rel="noreferrer" className="text-primary hover:underline text-[10px]">
                      {field.link.text} &rarr;
                    </a>
                  )}
                </label>
                <input 
                  type={field.type || "text"} 
                  className="w-full bg-surface-container-lowest/50 border border-white/10 rounded px-3 py-2 text-sm text-on-surface focus:border-primary outline-none transition-colors"
                  placeholder={field.placeholder}
                  value={values[field.key] || ""}
                  onChange={(e) => setValues(prev => ({ ...prev, [field.key]: e.target.value }))}
                />
              </div>
            ))}
            
            <button 
              onClick={() => saveMutation.mutate()}
              disabled={saveMutation.isPending || !fields.every(f => !!values[f.key])}
              className="mt-auto w-full py-2.5 rounded bg-white/5 hover:bg-primary hover:text-on-primary text-on-surface text-sm font-medium transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
            >
              <span className="material-symbols-outlined text-sm">{saveMutation.isPending ? 'sync' : 'link'}</span>
              {saveMutation.isPending ? 'Connecting...' : `Connect ${title}`}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
