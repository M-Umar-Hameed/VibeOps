import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api.js";

type AgentModel = { name: string; tier: string; quality: number };
type AgentConfig = { name: string; roles: string[]; models: AgentModel[] };

export function AgentsConfigCard() {
  const queryClient = useQueryClient();

  const { data: agents, isFetching } = useQuery({
    queryKey: ["forge", "agents"],
    queryFn: () => api.get("/forge/agents") as Promise<AgentConfig[]>,
  });

  return (
    <div className="glass-card rounded-xl border border-white/10 p-6 flex flex-col gap-4">
      <div>
        <h3 className="font-headline-sm text-on-surface font-bold flex items-center gap-2">
          <span className="material-symbols-outlined text-primary text-xl">smart_toy</span>
          Agents
        </h3>
        <p className="text-xs text-on-surface-variant mt-1">
          Configure agent roles and models. To add a new agent or edit the command template (cmd), you must manually edit the configuration file at <code>~/.vibeops/relay.json</code>.
        </p>
      </div>

      <div className="space-y-4">
        {agents?.map(agent => (
          <AgentEditor key={agent.name} agent={agent} queryClient={queryClient} />
        ))}
        {(!agents || agents.length === 0) && !isFetching && (
          <div className="text-on-surface-variant text-sm">No agents found in ~/.vibeops/relay.json.</div>
        )}
      </div>
    </div>
  );
}

function AgentEditor({ agent, queryClient }: { agent: AgentConfig; queryClient: any }) {
  const [roles, setRoles] = useState(new Set(agent.roles));
  const [models, setModels] = useState<AgentModel[]>(agent.models ?? []);
  const [isDirty, setIsDirty] = useState(false);

  useEffect(() => {
    setRoles(new Set(agent.roles));
    setModels(agent.models ?? []);
    setIsDirty(false);
  }, [agent]);

  const patchMutation = useMutation({
    mutationFn: (payload: { roles?: string[]; models?: AgentModel[] }) => 
      api.patch(`/relay/agents/${agent.name}`, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["forge", "agents"] });
      setIsDirty(false);
    },
  });

  const toggleRole = (r: string) => {
    const next = new Set(roles);
    if (next.has(r)) next.delete(r); else next.add(r);
    setRoles(next);
    setIsDirty(true);
  };

  const updateModel = (idx: number, field: keyof AgentModel, value: any) => {
    const next = [...models];
    next[idx] = { ...next[idx], [field]: value };
    setModels(next);
    setIsDirty(true);
  };

  const removeModel = (idx: number) => {
    const next = [...models];
    next.splice(idx, 1);
    setModels(next);
    setIsDirty(true);
  };

  const addModel = () => {
    setModels([...models, { name: "", tier: "cheap", quality: 3 }]);
    setIsDirty(true);
  };

  const handleSave = () => {
    patchMutation.mutate({ roles: Array.from(roles), models });
  };

  return (
    <div className="flex flex-col border border-white/5 bg-surface-container-lowest/30 rounded-lg p-4">
      <div className="flex items-center justify-between mb-4">
        <h4 className="text-sm font-bold text-on-surface">{agent.name}</h4>
        <button 
          onClick={handleSave} 
          disabled={!isDirty || patchMutation.isPending || roles.size === 0}
          className="px-3 py-1 bg-primary text-on-primary text-xs rounded disabled:opacity-50"
        >
          {patchMutation.isPending ? "Saving..." : "Save"}
        </button>
      </div>

      <div className="mb-4">
        <label className="text-xs text-on-surface-variant font-bold mb-2 block">Roles</label>
        <div className="flex gap-4">
          {["plan", "work", "review"].map(r => (
            <label key={r} className="flex items-center gap-2 cursor-pointer text-sm text-on-surface">
              <input 
                type="checkbox" 
                checked={roles.has(r)} 
                onChange={() => toggleRole(r)}
                className="rounded border-white/20 bg-surface-container-highest"
              />
              {r}
            </label>
          ))}
        </div>
      </div>

      <div>
        <label className="text-xs text-on-surface-variant font-bold mb-2 block">Models</label>
        {models.length > 0 ? (
          <div className="space-y-2 mb-2">
            {models.map((m, idx) => (
              <div key={idx} className="flex gap-2 items-center">
                <input 
                  type="text" 
                  value={m.name} 
                  onChange={e => updateModel(idx, "name", e.target.value)}
                  placeholder="Model name"
                  className="flex-1 bg-surface-container-highest border border-white/10 rounded px-2 py-1 text-sm text-on-surface focus:outline-none focus:border-primary"
                />
                <select 
                  value={m.tier} 
                  onChange={e => updateModel(idx, "tier", e.target.value)}
                  className="bg-surface-container-highest border border-white/10 rounded px-2 py-1 text-sm text-on-surface focus:outline-none focus:border-primary"
                >
                  <option value="free">free</option>
                  <option value="cheap">cheap</option>
                  <option value="expensive">expensive</option>
                </select>
                <select 
                  value={m.quality} 
                  onChange={e => updateModel(idx, "quality", parseInt(e.target.value))}
                  className="bg-surface-container-highest border border-white/10 rounded px-2 py-1 text-sm text-on-surface focus:outline-none focus:border-primary"
                >
                  {[1, 2, 3, 4, 5].map(q => <option key={q} value={q}>Q{q}</option>)}
                </select>
                <button 
                  onClick={() => removeModel(idx)}
                  className="text-on-surface-variant hover:text-error px-1"
                >
                  <span className="material-symbols-outlined text-[18px]">close</span>
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-xs text-on-surface-variant mb-2">No models configured.</div>
        )}
        <button 
          onClick={addModel}
          className="text-xs text-primary hover:underline flex items-center gap-1"
        >
          <span className="material-symbols-outlined text-[14px]">add</span> Add model
        </button>
      </div>
    </div>
  );
}
