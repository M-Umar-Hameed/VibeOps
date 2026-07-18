import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { api } from "../../lib/api.js";

type AgentTokens = {
  inputTokens: number; outputTokens: number; totalTokens: number; sessions: number;
  freshTokens?: number; cacheReadTokens?: number;
};
type AgentInfo = {
  agent: string;
  connected: boolean;
  account: string | null;
  plan?: string | null;
  authMode: string;
  note?: string;
  tokens: AgentTokens | null;
};

const AGENT_META: Record<string, { label: string; icon: React.ReactNode }> = {
  claude: { label: "Claude Code", icon: <span className="font-serif italic text-xl text-[#D97757]">C</span> },
  antigravity: { label: "Antigravity", icon: <span className="material-symbols-outlined text-xl text-[#4285F4]">memory</span> },
  codex: { label: "Codex", icon: <span className="material-symbols-outlined text-xl text-white">psychology</span> },
};

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function AIUsageTab() {
  const { data: realUsageData, isLoading } = useQuery({
    queryKey: ["ai-usage"],
    // api.get returns the parsed JSON body directly (no axios-style .data).
    queryFn: () => api.get("/system/ai-usage"),
  });

  const { data: agentsData, isLoading: agentsLoading } = useQuery({
    queryKey: ["agents"],
    queryFn: () => api.get("/system/agents"),
  });
  const agents: AgentInfo[] = agentsData?.agents ?? [];
  const sinceDays = agentsData?.sinceDays ?? 7;

  const usageLogs = realUsageData?.usage ?? [];
  const observedTotal = agents.reduce((s, a) => s + (a.tokens?.totalTokens ?? 0), 0);

  const agentSessions = realUsageData?.agents ?? [];
  const agentData = agentSessions.length
    ? {
        activeSessions: agentSessions.find((a: any) => a.status === 'active')?.count || 0,
        totalSessions7d: agentSessions.reduce((acc: number, a: any) => acc + Number(a.count), 0),
        autonomouslyResolved: agentSessions.find((a: any) => a.status === 'resolved')?.count || 0,
        humanHandoffs: agentSessions.find((a: any) => a.status === 'handoff')?.count || 0,
      }
    : null;

  if (isLoading) {
    return <div className="text-on-surface-variant font-code-sm">Loading usage data...</div>;
  }

  return (
    <div className="space-y-6 max-w-4xl animate-in fade-in duration-300">
      
      {/* Overview Stats — real sum of observed coding-agent tokens, no fake cost/strategy cards */}
      <div className="grid grid-cols-1 gap-4 mb-8 max-w-xs">
        <div className="glass-card rounded-lg p-5 border border-white/5 flex flex-col gap-1">
          <span className="text-xs text-on-surface-variant uppercase tracking-wider font-code-sm">Tokens observed ({sinceDays}d)</span>
          <span className="text-2xl font-bold text-on-surface">{formatTokens(observedTotal)}</span>
        </div>
      </div>

      {/* Autonomous Coding Agents Usage — from ai_usage_logs agent_sessions; no mock fallback */}
      <h3 className="font-code-sm uppercase tracking-widest text-on-surface-variant/70 text-xs mb-4 ml-1 mt-8">Autonomous Agents Usage</h3>
      {agentData ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
          <div className="glass-card rounded-xl p-6 border border-white/5 flex flex-col gap-4">
            <div className="flex justify-between items-center">
              <h4 className="font-headline-sm font-bold text-on-surface flex items-center gap-2">
                <span className="material-symbols-outlined text-secondary">smart_toy</span>
                Agent Sessions (7d)
              </h4>
              <span className="bg-secondary/20 text-secondary text-xs font-bold px-2 py-1 rounded animate-pulse">
                {agentData.activeSessions} Active Now
              </span>
            </div>
            <div className="flex justify-between items-end mt-2">
              <div>
                <div className="text-3xl font-bold text-on-surface">{agentData.totalSessions7d}</div>
                <div className="text-xs text-on-surface-variant mt-1">Total tasks delegated</div>
              </div>
              <div className="text-right">
                <div className="text-sm font-bold text-green-400">{agentData.autonomouslyResolved} Resolved</div>
                <div className="text-sm font-bold text-yellow-400">{agentData.humanHandoffs} Handoffs</div>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="glass-card rounded-xl p-6 border border-white/5 text-on-surface-variant font-code-sm text-center mb-8">
          No agent sessions recorded yet — VibeOps logs these once agent lifecycle tracking is enabled
        </div>
      )}

      <h3 className="font-code-sm uppercase tracking-widest text-on-surface-variant/70 text-xs mb-4 ml-1">Coding Agents</h3>

      {/* Coding Agents — real accounts + observed tokens from /system/agents */}
      <div className="space-y-3">
        {agentsLoading ? (
          <div className="text-on-surface-variant font-code-sm">Loading agents...</div>
        ) : agents.length === 0 ? (
          <div className="glass-card rounded-xl p-6 border border-white/5 text-on-surface-variant font-code-sm text-center">
            No coding agents detected
          </div>
        ) : (
          agents.map((agent) => {
            const meta = AGENT_META[agent.agent] ?? {
              label: agent.agent,
              icon: <span className="material-symbols-outlined text-xl text-on-surface-variant">smart_toy</span>,
            };
            const accountLine = !agent.connected ? "Not connected" : agent.account || agent.note || "Signed in";
            return (
              <div key={agent.agent} className="glass-card rounded-xl p-5 border border-white/5 flex items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-surface-container-highest flex items-center justify-center border border-white/5">
                    {meta.icon}
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <h4 className="font-headline-sm font-bold text-on-surface">{meta.label}</h4>
                      {agent.plan && (
                        <span className="text-[10px] uppercase tracking-wide bg-white/10 text-on-surface-variant px-1.5 py-0.5 rounded">
                          {agent.plan}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-on-surface-variant">{accountLine}</p>
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-sm font-bold text-on-surface font-code-sm">
                    {agent.tokens ? formatTokens(agent.tokens.totalTokens) : "—"}
                  </div>
                  {agent.tokens && agent.tokens.freshTokens !== undefined && agent.tokens.cacheReadTokens !== undefined ? (
                    <div className="text-[11px] text-on-surface-variant/70 font-code-sm mt-0.5">
                      {formatTokens(agent.tokens.freshTokens)} fresh / {formatTokens(agent.tokens.cacheReadTokens)} cache
                    </div>
                  ) : agent.tokens ? (
                    <div className="text-[11px] text-on-surface-variant/70 font-code-sm mt-0.5">
                      {formatTokens(agent.tokens.inputTokens)} in / {formatTokens(agent.tokens.outputTokens)} out
                    </div>
                  ) : (
                    <div className="text-[11px] text-on-surface-variant/70 font-code-sm mt-0.5">last {sinceDays}d</div>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      <p className="text-xs text-on-surface-variant/60 italic mt-3 ml-1">
        Usage observed by VibeOps from local session logs, across ALL projects (per-work-order now available). Provider quotas and reset limits live with each provider and aren't visible here.
      </p>

      <h3 className="font-code-sm uppercase tracking-widest text-on-surface-variant/70 text-xs mb-4 ml-1 mt-8">Logged AI Usage</h3>

      {realUsageData?.perTicket && realUsageData.perTicket.length > 0 && (
        <div className="mb-6">
          <h4 className="font-code-sm uppercase tracking-widest text-on-surface-variant/70 text-[10px] mb-2 ml-1">By Work Order</h4>
          <div className="space-y-2">
            {realUsageData.perTicket.map((row: any) => (
              <div key={row.ticketId} className="glass-card rounded-lg p-4 border border-white/5 flex justify-between items-center text-sm">
                <div className="flex flex-col truncate pr-4">
                  <span className="text-on-surface truncate">{row.title}</span>
                  <span className="text-xs text-on-surface-variant/60">{row.calls} calls</span>
                </div>
                <span className="font-code-sm text-on-surface-variant shrink-0">{formatTokens(Number(row.tokens) || 0)} tokens</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="space-y-2">
        {usageLogs.length === 0 ? (
          <div className="glass-card rounded-xl p-12 border border-white/5 flex flex-col items-center text-center">
             <span className="material-symbols-outlined text-6xl text-on-surface-variant/30 mb-6">monitoring</span>
             <div className="text-on-surface-variant max-w-md">
               <p className="mb-6 text-lg">Usage tracks tokens and costs across all your agent pipelines.</p>
               <Link to="/forge" className="bg-primary text-on-primary px-6 py-2 rounded font-bold uppercase tracking-widest inline-block hover:brightness-110">Run a pipeline in Forge</Link>
             </div>
          </div>
        ) : (
          usageLogs.map((row: any, i: number) => (
            <div key={`${row.provider}-${row.model}-${i}`} className="glass-card rounded-lg p-4 border border-white/5 flex justify-between items-center text-sm">
              <span className="text-on-surface">{row.provider} • {row.model}</span>
              <span className="font-code-sm text-on-surface-variant">{formatTokens(Number(row.tokens) || 0)} tokens</span>
            </div>
          ))
        )}
      </div>

    </div>
  );
}
