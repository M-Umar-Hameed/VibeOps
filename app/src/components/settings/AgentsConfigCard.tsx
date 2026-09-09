import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api.js";
import { modelOptionsForRole } from "../WorkOrderComposer.js";
import { getKnownModelsForAgent } from "../../lib/knownModels.js";

type AgentModel = { name: string; tier: string; quality: number };
type AgentConfig = { name: string; roles: string[]; models: AgentModel[]; type?: "cli" | "sdk" | "http" };

export function AgentsConfigCard() {
  const queryClient = useQueryClient();

  const { data: agents, isFetching, error } = useQuery({
    queryKey: ["forge", "agents"],
    // Guard non-array responses (error bodies) - .map on them crashes the tab.
    queryFn: async () => {
      const res = await api.get("/forge/agents");
      return (Array.isArray(res) ? res : []) as AgentConfig[];
    },
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

      {error && (
        <div className="border border-error/50 bg-error-container/20 rounded-lg px-4 py-3 text-error font-code-sm text-sm flex items-center justify-between gap-4">
          <span>{(error as Error).message}</span>
          <button
            onClick={async () => {
              try {
                await api.post("/relay/bootstrap");
                queryClient.invalidateQueries({ queryKey: ["forge", "agents"] });
              } catch (e: any) {
                // ignore
              }
            }}
            className="px-3 py-1 bg-error/20 hover:bg-error/30 text-error rounded text-xs font-bold shrink-0 cursor-pointer"
          >
            Auto-Repair Config
          </button>
        </div>
      )}

      <div className="space-y-4">
        {agents?.map(agent => (
          <AgentEditor key={agent.name} agent={agent} queryClient={queryClient} />
        ))}
        {(!agents || agents.length === 0) && !isFetching && !error && (
          <div className="text-on-surface-variant text-sm">No agents found in ~/.vibeops/relay.json.</div>
        )}
      </div>
      <RoleDefaults agents={agents ?? []} />
    </div>
  );
}

function AgentEditor({ agent, queryClient }: { agent: AgentConfig; queryClient: any }) {
  const chatOnly = agent.type === "http";
  // Phase 1 sdk lanes are work-only. loadRelayConfig rejects anything else on
  // read, so offering plan/review here writes a relay.json that no longer
  // loads and takes every relay route down with it.
  const workOnly = agent.type === "sdk";
  const roleChoices = chatOnly ? ["plan", "review"] : workOnly ? ["work"] : ["plan", "work", "review"];
  const sanitizeRoles = (r: string[]) => {
    if (workOnly) return ["work"];
    return (r || []).filter(choice => roleChoices.includes(choice));
  };
  const [roles, setRoles] = useState(new Set(sanitizeRoles(agent.roles)));
  const [models, setModels] = useState<AgentModel[]>(agent.models ?? []);
  const [isDirty, setIsDirty] = useState(false);

  useEffect(() => {
    setRoles(new Set(sanitizeRoles(agent.roles)));
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
  const saveError = patchMutation.error ? (patchMutation.error as Error).message : "";

  // Chat-only lanes (e.g. OpenRouter): models here become the picker's choices
  // in chat, not the pipeline's. Fetched once per agent, cached by react-query.
  const catalogQuery = useQuery({
    queryKey: ["relay", "catalog", agent.name],
    queryFn: () => api.get(`/relay/agents/${agent.name}/catalog`),
    enabled: chatOnly,
  });

  const known = getKnownModelsForAgent(agent.name);
  const catalogModels = chatOnly
    ? (catalogQuery.data?.models ?? [])
    : known.map(k => ({ id: k.id, name: k.name, tier: k.tier, quality: k.quality }));

  const toggleRole = (r: string) => {
    const next = new Set(roles);
    if (next.has(r)) next.delete(r); else next.add(r);
    setRoles(next);
    setIsDirty(true);
  };

  const handleModelNameChange = (idx: number, val: string) => {
    const next = [...models];
    const match = catalogModels.find((m: any) => (m.id || m.name) === val || m.name === val);
    if (match && match.tier && match.quality) {
      next[idx] = { ...next[idx], name: val, tier: match.tier, quality: match.quality };
    } else {
      next[idx] = { ...next[idx], name: val };
    }
    setModels(next);
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

  const addRecommendedModels = () => {
    const toAdd = known.slice(0, 4).map(k => ({ name: k.id, tier: k.tier, quality: k.quality }));
    setModels(toAdd);
    setIsDirty(true);
  };

  const handleSave = () => {
    const safeRoles = workOnly ? ["work"] : Array.from(roles);
    patchMutation.mutate({ roles: safeRoles, models });
  };

  return (
    <div className="flex flex-col border border-white/5 bg-surface-container-lowest/30 rounded-lg p-4">
      <div className="flex items-center justify-between mb-4">
        <h4 className="text-sm font-bold text-on-surface">{agent.name}</h4>
        <button
          onClick={handleSave}
          disabled={!isDirty || patchMutation.isPending || (!chatOnly && roles.size === 0)}
          className="px-3 py-1 bg-primary text-on-primary text-xs rounded disabled:opacity-50"
        >
          {patchMutation.isPending ? "Saving..." : "Save"}
        </button>
      </div>

      {saveError && (
        <div className="mb-4 text-error font-code-sm text-xs">{saveError}</div>
      )}

      <div className="mb-4">
        {chatOnly && (
          <div className="text-xs text-on-surface-variant mb-2">
            Chat and text-only pipeline stages (plan, review). The work stage needs an execution harness, so it stays off for this lane.
          </div>
        )}
        {workOnly && (
          <div className="text-xs text-on-surface-variant mb-2">
            The SDK lane runs the work stage in-process. Plan and review stay on the CLI lanes.
          </div>
        )}
        <label className="text-xs text-on-surface-variant font-bold mb-2 block">Roles</label>
        <div className="flex gap-4">
          {roleChoices.map(r => (
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
        {!chatOnly && roles.size === 0 && (
          <div className="text-xs text-on-surface-variant mt-2">Pick at least one role to save.</div>
        )}
      </div>

      <div>
        <label className="text-xs text-on-surface-variant font-bold mb-2 block">Models</label>
        <datalist id={`catalog-${agent.name}`}>
          {catalogModels.map((m: any) => (
            <option key={m.id || m.name} value={m.id || m.name}>
              {m.name && m.name !== m.id ? `${m.name} (${m.id})` : (m.id || m.name)}
            </option>
          ))}
        </datalist>
        {models.length > 0 ? (
          <div className="space-y-2 mb-2">
            {models.map((m, idx) => (
              <div key={idx} className="flex gap-2 items-center">
                <input
                  type="text"
                  value={m.name}
                  onChange={e => handleModelNameChange(idx, e.target.value)}
                  placeholder={chatOnly ? "Type to search the catalog, or enter any model id" : "Type to search known models, or enter model name"}
                  list={`catalog-${agent.name}`}
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
        <div className="flex items-center gap-3">
          <button
            onClick={addModel}
            className="text-xs text-primary hover:underline flex items-center gap-1"
          >
            <span className="material-symbols-outlined text-[14px]">add</span> Add model
          </button>
          {!chatOnly && models.length === 0 && known.length > 0 && (
            <button
              onClick={addRecommendedModels}
              className="text-xs text-primary/80 hover:text-primary flex items-center gap-1 cursor-pointer"
            >
              <span className="material-symbols-outlined text-[14px]">playlist_add</span> Add recommended models
            </button>
          )}
        </div>
        {chatOnly && catalogQuery.data?.reason && (
          <div className="text-xs text-on-surface-variant mt-1">{catalogQuery.data.reason}</div>
        )}
      </div>
    </div>
  );
}

function RoleDefaults({ agents }: { agents: AgentConfig[] }) {
  return (
    <div className="border-t border-white/10 pt-4">
      <label className="text-xs text-on-surface-variant font-bold mb-1 block">Default model per role</label>
      <p className="text-xs text-on-surface-variant mb-3">
        Applied to auto runs unless a run picks quick/max effort or an explicit model. Auto follows the routing strategy.
      </p>
      <div className="space-y-2">
        {(["plan", "work", "review"] as const).map(role => (
          <RoleDefaultSelect key={role} role={role} agents={agents} />
        ))}
      </div>
    </div>
  );
}

function RoleDefaultSelect({ role, agents }: { role: "plan" | "work" | "review"; agents: AgentConfig[] }) {
  const queryClient = useQueryClient();
  const key = `forge.defaultModel.${role}`;
  const { data } = useQuery({
    queryKey: ["settings", key],
    queryFn: async () => (await api.get(`/settings/${key}`)).value || "",
  });
  const save = useMutation({
    mutationFn: (value: string) => api.patch(`/settings/${key}`, { value }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["settings", key] }),
  });
  const options = modelOptionsForRole(agents, role);
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-on-surface w-16 capitalize">{role}</span>
      <select
        aria-label={`Default model for ${role}`}
        value={data ?? ""}
        onChange={e => save.mutate(e.target.value)}
        className="flex-1 bg-surface-container-highest border border-white/10 rounded px-2 py-1 text-sm text-on-surface focus:outline-none focus:border-primary"
      >
        <option value="">Auto (routing strategy)</option>
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}
