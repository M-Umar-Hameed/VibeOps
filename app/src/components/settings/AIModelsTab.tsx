import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api.js";
import { ProviderCard } from "./ProviderCard.js";
import { AIUsageTab } from "./AIUsageTab.js";
import { AgentDoctorCard } from "./AgentDoctorCard.js";
import { AgentsConfigCard } from "./AgentsConfigCard.js";

type SubTab = "providers" | "usage";
type Strategy = "cost" | "max";
type CommProfile = "off" | "auto" | "caveman" | "humanizer";

const VOYAGE_MODELS = ["voyage-3", "voyage-3-lite", "voyage-3.5", "voyage-3.5-lite", "voyage-code-3"];

function VoyageModelSelect() {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: ["settings", "voyage.model"],
    queryFn: async () => (await api.get("/settings/voyage.model")).value || "voyage-3",
  });
  const save = useMutation({
    mutationFn: async (value: string) => { await api.patch("/settings/voyage.model", { value }); },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["settings", "voyage.model"] }),
  });
  return (
    <div className="mt-2 flex items-center gap-2">
      <label className="text-[11px] text-on-surface-variant/70 font-code-sm">Model</label>
      <select
        value={data ?? "voyage-3"}
        onChange={(e) => save.mutate(e.target.value)}
        className="bg-surface-container-lowest/50 border border-white/10 rounded px-2 py-1 text-xs text-on-surface outline-none"
      >
        {VOYAGE_MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
      </select>
    </div>
  );
}

export function AIModelsTab() {

  const [activeTab, setActiveTab] = useState<SubTab>("providers");
  const queryClient = useQueryClient();

  const { data: strategy } = useQuery({
    queryKey: ["settings", "ai.routing_strategy"],
    queryFn: async () => {
      const res = await api.get("/settings/ai.routing_strategy");
      return (res.value as Strategy) || "cost";
    },
  });

  const setStrategy = useMutation({
    mutationFn: (value: Strategy) => api.patch("/settings/ai.routing_strategy", { value }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["settings", "ai.routing_strategy"] }),
  });

  const { data: commProfile } = useQuery({
    queryKey: ["settings", "agents.commProfile"],
    queryFn: async () => {
      const res = await api.get("/settings/agents.commProfile");
      return (res.value as CommProfile) || "off";
    },
  });

  const setCommProfile = useMutation({
    mutationFn: (value: CommProfile) => api.patch("/settings/agents.commProfile", { value }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["settings", "agents.commProfile"] }),
  });

  const { data: selfImprove } = useQuery({
    queryKey: ["settings", "prompts.selfImprove"],
    queryFn: async () => {
      const res = await api.get("/settings/prompts.selfImprove");
      return (res.value as string) || "";
    },
  });

  const setSelfImprove = useMutation({
    mutationFn: (value: string) => api.patch("/settings/prompts.selfImprove", { value }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["settings", "prompts.selfImprove"] }),
  });

  const { data: perTicketTokens } = useQuery({
    queryKey: ["settings", "ai.budget.perTicketTokens"],
    queryFn: async () => {
      const res = await api.get("/settings/ai.budget.perTicketTokens");
      return (res.value as string) || "";
    },
  });

  const setPerTicketTokens = useMutation({
    mutationFn: (value: string) => api.patch("/settings/ai.budget.perTicketTokens", { value }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["settings", "ai.budget.perTicketTokens"] }),
  });

  const { data: perDayTokens } = useQuery({
    queryKey: ["settings", "ai.budget.perDayTokens"],
    queryFn: async () => {
      const res = await api.get("/settings/ai.budget.perDayTokens");
      return (res.value as string) || "";
    },
  });

  const setPerDayTokens = useMutation({
    mutationFn: (value: string) => api.patch("/settings/ai.budget.perDayTokens", { value }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["settings", "ai.budget.perDayTokens"] }),
  });

  return (
    <div className="animate-in fade-in slide-in-from-bottom-2 duration-500">
      <div className="mb-8 border-b border-white/10 pb-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h2 className="font-headline-md text-headline-md text-on-surface mb-2">AI Settings</h2>
            <p className="text-on-surface-variant text-sm max-w-2xl">
              Configure AI models, auto-routing strategies, and monitor your API usage limits.
            </p>
          </div>
          
          <div className="flex bg-surface-container-lowest/50 p-1 rounded-lg border border-white/5">
            <button
              onClick={() => setActiveTab("providers")}
              className={`px-4 py-1.5 text-sm font-medium rounded-md transition-all ${activeTab === "providers" ? "bg-primary/20 text-primary" : "text-on-surface-variant hover:text-on-surface"}`}
            >
              Providers & Routing
            </button>
            <button
              onClick={() => setActiveTab("usage")}
              className={`px-4 py-1.5 text-sm font-medium rounded-md transition-all ${activeTab === "usage" ? "bg-primary/20 text-primary" : "text-on-surface-variant hover:text-on-surface"}`}
            >
              Token Usage
            </button>
          </div>
        </div>
      </div>

      {activeTab === "providers" ? (
        <div className="space-y-8 max-w-6xl">
          <AgentDoctorCard />
          <AgentsConfigCard />

          {/* Routing Strategy Card */}
          <div className="glass-card rounded-xl border border-white/10 p-6 flex flex-col gap-4 relative overflow-hidden">
            <div className="absolute top-0 right-0 w-32 h-32 bg-primary/10 rounded-full blur-3xl -mr-10 -mt-10 pointer-events-none"></div>
            
            <div>
              <h3 className="font-headline-sm text-on-surface font-bold flex items-center gap-2">
                <span className="material-symbols-outlined text-primary text-xl">route</span>
                Smart Routing Strategy
              </h3>
              <p className="text-xs text-on-surface-variant mt-1">Automatically utilize whichever provider is available and control costs.</p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-2">
              <label className="flex items-start gap-3 cursor-pointer group">
                <div className="mt-0.5 relative flex items-center justify-center">
                  <input
                    type="radio"
                    name="strategy"
                    className="peer appearance-none w-4 h-4 rounded-full border border-white/20 checked:border-primary transition-all"
                    checked={(strategy ?? "cost") === "cost"}
                    onChange={() => setStrategy.mutate("cost")}
                  />
                  <div className="absolute w-2 h-2 rounded-full bg-primary opacity-0 peer-checked:opacity-100 transition-opacity"></div>
                </div>
                <div>
                  <div className="text-sm font-medium text-on-surface group-hover:text-primary transition-colors">Cost-Optimized Fallback</div>
                  <div className="text-xs text-on-surface-variant mt-0.5">Prefers local/cheaper models first, falls back to premium if unavailable or for complex tasks.</div>
                </div>
              </label>

              <label className="flex items-start gap-3 cursor-pointer group">
                <div className="mt-0.5 relative flex items-center justify-center">
                  <input
                    type="radio"
                    name="strategy"
                    className="peer appearance-none w-4 h-4 rounded-full border border-white/20 checked:border-primary transition-all"
                    checked={strategy === "max"}
                    onChange={() => setStrategy.mutate("max")}
                  />
                  <div className="absolute w-2 h-2 rounded-full bg-primary opacity-0 peer-checked:opacity-100 transition-opacity"></div>
                </div>
                <div>
                  <div className="text-sm font-medium text-on-surface group-hover:text-primary transition-colors">Maximum Intelligence</div>
                  <div className="text-xs text-on-surface-variant mt-0.5">Always routes to the most capable model configured (e.g. Claude 3.5 or GPT-4) regardless of cost.</div>
                </div>
              </label>
            </div>
            <p className="text-[11px] text-on-surface-variant/60 mt-1">Enforced with verification for supported CLIs; stored preference elsewhere.</p>
          </div>

          {/* Budget Caps */}
          <div className="glass-card rounded-xl border border-white/10 p-6 flex flex-col gap-4">
            <div>
              <h3 className="font-headline-sm text-on-surface font-bold flex items-center gap-2">
                <span className="material-symbols-outlined text-primary text-xl">account_balance_wallet</span>
                Router Cost Caps
              </h3>
              <p className="text-xs text-on-surface-variant mt-1">
                Estimates from logged usage; pipelines refuse to start past a cap (force overrides via API). Empty means no cap.
              </p>
            </div>
            
            <div className="flex gap-4">
              <div className="flex flex-col gap-1 w-1/2">
                <label className="text-sm text-on-surface">Per-work-order token cap</label>
                <input
                  type="number"
                  className="bg-surface-container-highest border border-white/10 rounded-md px-3 py-2 text-sm text-on-surface focus:outline-none focus:border-primary transition-colors"
                  value={perTicketTokens ?? ""}
                  onChange={(e) => setPerTicketTokens.mutate(e.target.value)}
                  placeholder="e.g. 500000"
                />
              </div>
              <div className="flex flex-col gap-1 w-1/2">
                <label className="text-sm text-on-surface">Daily token cap</label>
                <input
                  type="number"
                  className="bg-surface-container-highest border border-white/10 rounded-md px-3 py-2 text-sm text-on-surface focus:outline-none focus:border-primary transition-colors"
                  value={perDayTokens ?? ""}
                  onChange={(e) => setPerDayTokens.mutate(e.target.value)}
                  placeholder="e.g. 2000000"
                />
              </div>
            </div>
          </div>

          {/* Communication Profile Card */}
          <div className="glass-card rounded-xl border border-white/10 p-6 flex flex-col gap-4 relative overflow-hidden">
            <div>
              <h3 className="font-headline-sm text-on-surface font-bold flex items-center gap-2">
                <span className="material-symbols-outlined text-primary text-xl">forum</span>
                Communication Profile
              </h3>
              <p className="text-xs text-on-surface-variant mt-1">Auto: terse internal agent traffic, natural prose for user-facing output, ponytail code discipline on work and review. Off disables all style clauses.</p>
            </div>
            
            <div className="mt-2">
              <select
                className="w-full sm:w-auto bg-surface-container-highest border border-white/10 rounded-md px-3 py-2 text-sm text-on-surface focus:outline-none focus:border-primary transition-colors"
                value={commProfile === "off" ? "off" : "auto"}
                onChange={(e) => setCommProfile.mutate(e.target.value as CommProfile)}
              >
                <option value="auto">Auto (role-based)</option>
                <option value="off">Off</option>
              </select>
            </div>

            <div className="mt-4 flex items-center gap-3">
              <input
                id="self-improve"
                type="checkbox"
                checked={selfImprove === "true"}
                onChange={(e) => setSelfImprove.mutate(e.target.checked ? "true" : "")}
              />
              <label htmlFor="self-improve" className="text-sm text-on-surface cursor-pointer">
                Self-improving prompts
                <span className="block text-xs text-on-surface-variant">
                  After each forge run, a cheap model updates the prompt-lessons note that future prompts include. Editable in Notes.
                </span>
              </label>
            </div>
          </div>
          {activeTab === "providers" && (
            <>
              <div className="space-y-6">
                <h3 className="text-xs font-code-sm uppercase tracking-widest text-on-surface-variant/50 ml-2">Configured Providers</h3>
                <ProviderCard 
                  settingKey="anthropic.api_key"
                  name="Anthropic"
                  subtitle="Claude 3.5 Sonnet"
                  placeholder="sk-ant-..."
                  borderColorClass="[#D97757]/40"
                  icon={
                    <div className="w-12 h-12 bg-[#D97757]/20 rounded-xl flex items-center justify-center">
                      <span className="font-serif italic text-2xl text-[#D97757]">C</span>
                    </div>
                  }
                />
                <ProviderCard 
                  settingKey="openai.api_key"
                  name="OpenAI / Codex"
                  subtitle="GPT-4o & Codex"
                  placeholder="sk-..."
                  borderColorClass="white/20"
                  icon={
                    <div className="w-12 h-12 bg-white/10 rounded-xl flex items-center justify-center">
                      <span className="text-white text-2xl material-symbols-outlined">psychology</span>
                    </div>
                  }
                />
                <ProviderCard 
                  settingKey="google.api_key"
                  name="Google"
                  subtitle="Antigravity & Gemini"
                  placeholder="AIza..."
                  borderColorClass="[#4285F4]/40"
                  icon={
                    <div className="w-12 h-12 bg-[#4285F4]/20 rounded-xl flex items-center justify-center">
                      <span className="material-symbols-outlined text-2xl text-[#4285F4]">memory</span>
                    </div>
                  }
                />
                <ProviderCard
                  settingKey="voyage.api_key"
                  name="Voyage AI"
                  subtitle="Premium Knowledge Embeddings"
                  placeholder="pa-..."
                  borderColorClass="[#8B5CF6]/40"
                  note="Used only for semantic search embeddings over your tickets/knowledge. Optional — VibeOps falls back to a local, zero-key embedder if this is empty."
                  extra={<VoyageModelSelect />}
                  icon={
                    <div className="w-12 h-12 bg-[#8B5CF6]/20 rounded-xl flex items-center justify-center">
                      <span className="material-symbols-outlined text-2xl text-[#8B5CF6]">explore</span>
                    </div>
                  }
                />
                <ProviderCard 
                  settingKey="ollama.url"
                  name="Local Node"
                  subtitle="Ollama / Llama 3 (Free)"
                  placeholder="http://localhost:11434"
                  borderColorClass="secondary/40"
                  icon={
                    <div className="w-12 h-12 bg-surface-container-highest rounded-xl flex items-center justify-center">
                      <img src="https://ollama.com/public/icon-64x64.png" alt="Ollama" className="w-8 h-8" onError={(e) => e.currentTarget.style.display = 'none'} />
                      <span className="material-symbols-outlined text-secondary absolute -z-10">smart_toy</span>
                    </div>
                  }
                />
              </div>
            </>
          )}
        </div>
      ) : (
        <AIUsageTab />
      )}
    </div>
  );
}
