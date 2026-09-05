import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api.js";

type DoctorStatus = {
  name: string; binary: string;
  probe: { ok: boolean; error?: string };
  auth: { known: boolean; connected: boolean | null };
  mcp?: { registered: boolean; addCommand: string };
  lastChecked: string;
};

const CONNECT_COPY: Record<string, { label: string; command?: string; note: string }> = {
  claude: {
    label: "Claude Code",
    command: "claude login",
    note: "Signs in with your claude.ai account/subscription. Run this once in a terminal on this machine.",
  },
  codex: {
    label: "Codex",
    command: "codex login",
    note: "Signs in with your ChatGPT/OpenAI account. Run this once in a terminal on this machine.",
  },
  agy: {
    label: "Antigravity",
    note: "Sign in through the Antigravity CLI/app's own sign-in flow (no single flag — see Antigravity's docs). VibeOps only invokes agy once it's authenticated.",
  },
};

const GENERIC_CONNECT = {
  note: "Authenticate this CLI in your terminal the way its provider expects. VibeOps only invokes the binary — it never sees or stores the credentials.",
};

function dotColor(s: DoctorStatus): string {
  if (!s.probe.ok || s.mcp?.registered === false) return "bg-red-500";
  return "bg-green-500";
}

function authLabel(s: DoctorStatus): string {
  if (!s.auth.known) return "auth: unknown";
  return s.auth.connected ? "auth: connected" : "auth: not connected";
}

export function AgentDoctorCard() {
  const queryClient = useQueryClient();

  const { data, isFetching } = useQuery({
    queryKey: ["forge", "doctor"],
    queryFn: () => api.get("/forge/doctor") as Promise<DoctorStatus[]>,
  });

  const runChecks = async () => {
    const fresh = await api.get("/forge/doctor?fresh=true") as DoctorStatus[];
    queryClient.setQueryData(["forge", "doctor"], fresh);
  };

  const statuses = Array.isArray(data) ? data : [];

  return (
    <div className="glass-card rounded-xl border border-white/10 p-6 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-headline-sm text-on-surface font-bold flex items-center gap-2">
            <span className="material-symbols-outlined text-primary text-xl">monitor_heart</span>
            AI Accounts
          </h3>
          <p className="text-xs text-on-surface-variant mt-1">
            VibeOps never stores your AI provider accounts or passwords. Each agent below is a CLI you authenticate once on this machine — Claude Code, Antigravity, Codex, or any other. Usage and billing stay on your existing subscription; VibeOps only invokes the binary.<br /><br />
            Note: the Actors card (Settings &gt; Local Node) issues keys for agents calling INTO VibeOps — a different thing from the AI provider CLIs listed here.
          </p>
        </div>
        <button
          onClick={runChecks}
          disabled={isFetching}
          className="px-4 py-2 rounded bg-surface-container-highest hover:bg-white/10 text-on-surface text-xs font-bold uppercase tracking-widest transition-all disabled:opacity-50 cursor-pointer"
        >
          Run checks
        </button>
      </div>

      <div className="space-y-2">
        {statuses.length === 0 ? (
          <div className="text-on-surface-variant font-code-sm text-sm">No relay agents configured.</div>
        ) : (
          statuses.map(s => {
            const copy = CONNECT_COPY[s.binary] ?? GENERIC_CONNECT;
            return (
              <div key={s.name} className="flex flex-col border border-white/5 rounded-lg px-4 py-3">
                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full ${dotColor(s)}`} />
                    <span className="text-sm font-medium text-on-surface">{s.name}</span>
                    <span className="text-xs text-on-surface-variant">({s.binary})</span>
                  </div>
                  <div className="text-right text-xs text-on-surface-variant">
                    <div>{authLabel(s)}</div>
                    {!s.probe.ok && <div className="text-error">{s.probe.error}</div>}
                    {s.mcp?.registered === false && <div className="text-error">MCP not registered</div>}
                  </div>
                </div>
                <details className="mt-2 text-xs">
                  <summary className="cursor-pointer text-primary">How to connect</summary>
                  <div className="mt-1 text-on-surface-variant">
                    {copy.command && <code className="block bg-background rounded px-2 py-1 mb-1">{copy.command}</code>}
                    <p>{copy.note}</p>
                    {s.mcp?.registered === false && (
                      <>
                        <p className="mt-1">This lane declares mcp:true but no vibeops MCP server is registered. Register it:</p>
                        <code className="block bg-background rounded px-2 py-1 mt-1">{s.mcp.addCommand}</code>
                      </>
                    )}
                  </div>
                </details>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
