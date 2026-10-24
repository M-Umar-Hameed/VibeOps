import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api.js";

export type AccountState = { exhaustedUntil?: string; lastError?: string; lastUsed?: string; loginOk?: boolean; loginCheckedAt?: string; limitHits?: number };
type Login = { command: string; then?: string };
export type LaneAccount = { id: string; label: string; configDir: string; priority: number; disabled?: boolean; state: AccountState; runs: number; lastRunAt: string | null; login?: Login };
type RecentRun = { runId: string; role: string; account: string; startedAt: string };
export type AccountLane = { agent: string; kind: string; canCheckLogin: boolean; copiesClaudeSettings: boolean; accounts: LaneAccount[]; recent: RecentRun[] };
export type AccountsData = { runsActive: boolean; lanes: AccountLane[] };

export const ACCOUNTS_KEY = ["relay", "accounts"];
const RUNS_ACTIVE_TITLE = "Wait until runs finish";
const btn = "px-2 py-1 text-xs rounded border border-white/10 hover:border-white/20 text-on-surface disabled:opacity-50 disabled:cursor-not-allowed";
const when = (iso?: string | null) => (iso ? new Date(iso).toLocaleString() : "");

export async function fetchAccounts(): Promise<AccountsData> {
  const res = await api.get("/relay/accounts");
  // Guard error bodies: .map on them crashes the tab.
  return { runsActive: !!res?.runsActive, lanes: Array.isArray(res?.lanes) ? res.lanes : [] };
}

export function AccountsCard() {
  const { data, error } = useQuery({ queryKey: ACCOUNTS_KEY, queryFn: fetchAccounts, refetchInterval: 10_000 });
  const lanes = data?.lanes ?? [];
  const runsActive = data?.runsActive ?? false;
  return (
    <div className="glass-card rounded-xl border border-white/10 p-6 flex flex-col gap-4">
      <div>
        <h3 className="font-headline-sm text-on-surface font-bold flex items-center gap-2">
          <span className="material-symbols-outlined text-primary text-xl">group</span>
          Accounts
        </h3>
        <p className="text-xs text-on-surface-variant/70 mt-1">Subscription logins per lane. Runs use the first account and move to the next one when it hits its usage limit.</p>
      </div>
      {runsActive && <div className="text-xs text-on-surface-variant">Wait until runs finish to change accounts.</div>}
      {error && <div className="text-error text-xs">{(error as Error).message}</div>}
      <div className="space-y-6">
        {lanes.map((lane) => <LaneAccounts key={lane.agent} lane={lane} runsActive={runsActive} />)}
        {lanes.length === 0 && !error && <div className="text-sm text-on-surface-variant italic">No subscription lanes</div>}
      </div>
    </div>
  );
}

function LoginStep({ login }: { login: Login }) {
  return (
    <div className="text-xs text-on-surface-variant">
      Log in: run <code className="font-code-sm text-on-surface">{login.command}</code>{login.then ? `, then ${login.then}` : ""}
    </div>
  );
}

function LaneAccounts({ lane, runsActive }: { lane: AccountLane; runsActive: boolean }) {
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ACCOUNTS_KEY });
  const [label, setLabel] = useState("");
  const [folder, setFolder] = useState("");
  const [copy, setCopy] = useState(true);
  const [added, setAdded] = useState<{ login?: Login; copied: string[] } | null>(null);
  const add = useMutation({
    mutationFn: () => api.post(`/relay/agents/${lane.agent}/accounts`, {
      label: label.trim(),
      ...(folder.trim() ? { configDir: folder.trim() } : {}),
      ...(lane.copiesClaudeSettings ? { copySettings: copy } : {}),
    }),
    onSuccess: (res: any) => { setAdded({ login: res?.login, copied: res?.copied ?? [] }); setLabel(""); setFolder(""); invalidate(); },
  });
  const reorder = useMutation({
    mutationFn: (ids: string[]) => api.put(`/relay/agents/${lane.agent}/accounts/order`, { ids }),
    onSuccess: invalidate,
  });
  const move = (from: number, to: number) => {
    const ids = lane.accounts.map((a) => a.id);
    [ids[from], ids[to]] = [ids[to], ids[from]];
    reorder.mutate(ids);
  };
  const labelOf = (id: string) => lane.accounts.find((a) => a.id === id)?.label ?? id;
  return (
    <div className="space-y-2">
      <h4 className="font-code-label text-code-label uppercase tracking-widest text-on-surface-variant">
        {lane.agent} ({lane.kind}) · {lane.accounts.length}
      </h4>
      {lane.accounts.length === 0 && <div className="text-sm text-on-surface-variant italic">None</div>}
      {lane.accounts.map((a, i) => (
        <AccountRow key={a.id} lane={lane} account={a} index={i} runsActive={runsActive}
          onUp={i > 0 ? () => move(i, i - 1) : undefined}
          onDown={i < lane.accounts.length - 1 ? () => move(i, i + 1) : undefined} />
      ))}
      {reorder.error && <div className="text-error text-xs">{(reorder.error as Error).message}</div>}
      {lane.recent.length > 0 && (
        <div className="text-xs text-on-surface-variant">
          Last runs: {lane.recent.map((r) => `${r.role} on ${labelOf(r.account)} (${when(r.startedAt)})`).join(" · ")}
        </div>
      )}
      <div className="p-3 rounded border border-white/5 space-y-2">
        <div className="flex gap-2 flex-wrap items-center">
          <input aria-label={`New account label for ${lane.agent}`} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label"
            className="bg-surface-container-highest border border-white/10 rounded px-2 py-1 text-sm text-on-surface focus:outline-none focus:border-primary" />
          <input aria-label={`Folder for ${lane.agent}`} value={folder} onChange={(e) => setFolder(e.target.value)} placeholder={`Default: ~/.vibeops/accounts/${lane.agent}/<id>`}
            className="flex-1 bg-surface-container-highest border border-white/10 rounded px-2 py-1 text-sm text-on-surface font-code-sm focus:outline-none focus:border-primary" />
          <button type="button" onClick={() => add.mutate()} disabled={runsActive || !label.trim() || add.isPending}
            title={runsActive ? RUNS_ACTIVE_TITLE : undefined} className={btn}>Add account</button>
        </div>
        {lane.copiesClaudeSettings && (
          <label className="flex items-center gap-2 text-xs text-on-surface">
            <input type="checkbox" checked={copy} onChange={(e) => setCopy(e.target.checked)} />
            Copy CLAUDE.md and settings.json from ~/.claude
          </label>
        )}
        {add.error && <div className="text-error text-xs">{(add.error as Error).message}</div>}
        {added?.login && <LoginStep login={added.login} />}
        {added && added.copied.length > 0 && <div className="text-xs text-on-surface-variant">Copied {added.copied.join(", ")}</div>}
      </div>
    </div>
  );
}

function AccountRow({ lane, account: a, index, runsActive, onUp, onDown }: {
  lane: AccountLane; account: LaneAccount; index: number; runsActive: boolean; onUp?: () => void; onDown?: () => void;
}) {
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ACCOUNTS_KEY });
  const [confirming, setConfirming] = useState(false);
  const [deleteFolder, setDeleteFolder] = useState(false);
  const base = `/relay/agents/${lane.agent}/accounts/${a.id}`;
  const toggle = useMutation({ mutationFn: () => api.patch(base, { disabled: !a.disabled }), onSuccess: invalidate });
  const check = useMutation({ mutationFn: () => api.post(`${base}/check`) as Promise<{ ok: boolean; error?: string }>, onSuccess: invalidate });
  const remove = useMutation({ mutationFn: () => api.del(base, { deleteFolder }), onSuccess: () => { setConfirming(false); invalidate(); } });
  const s = a.state;
  const exhausted = s.exhaustedUntil && Date.parse(s.exhaustedUntil) > Date.now() ? s.exhaustedUntil : undefined;
  const login = s.loginOk === true ? "logged_in" : s.loginOk === false ? "not_logged_in" : "unchecked";
  const pill = s.loginOk === true ? "bg-green-500/20 text-green-400" : s.loginOk === false ? "bg-red-500/20 text-red-400" : "text-on-surface-variant";
  const lock = runsActive ? RUNS_ACTIVE_TITLE : undefined;
  const err = (toggle.error ?? check.error ?? remove.error) as Error | null;
  return (
    <div className={`p-3 rounded border border-white/5 space-y-1 ${a.disabled ? "opacity-60" : ""}`}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm font-bold text-on-surface">{a.label || a.id}</span>
        <span className="text-[10px] font-code-label uppercase text-primary">{index === 0 ? "Primary" : `Backup ${index}`}</span>
        <span className={`text-[10px] font-code-label uppercase px-1.5 rounded ${pill}`}>{login}</span>
        {a.disabled && <span className="text-[10px] font-code-label uppercase text-on-surface-variant">disabled</span>}
        <div className="ml-auto flex gap-1">
          <button type="button" aria-label={`Move ${a.label} up`} onClick={onUp} disabled={!onUp || runsActive} title={lock} className={btn}>
            <span className="material-symbols-outlined text-[16px]">arrow_upward</span>
          </button>
          <button type="button" aria-label={`Move ${a.label} down`} onClick={onDown} disabled={!onDown || runsActive} title={lock} className={btn}>
            <span className="material-symbols-outlined text-[16px]">arrow_downward</span>
          </button>
          <button type="button" onClick={() => toggle.mutate()} disabled={runsActive || toggle.isPending} title={lock} className={btn}>
            {a.disabled ? "Enable" : "Disable"}
          </button>
          {lane.canCheckLogin && (
            <button type="button" onClick={() => check.mutate()} disabled={check.isPending} className={btn}>
              {check.isPending && <span className="material-symbols-outlined text-[14px] animate-spin">progress_activity</span>} Check login
            </button>
          )}
          <button type="button" aria-label={`Remove ${a.label}`} onClick={() => setConfirming(true)} disabled={runsActive} title={lock} className={btn}>Remove</button>
        </div>
      </div>
      <div className="font-code-sm text-xs text-on-surface-variant break-all">{a.configDir}</div>
      <div className="text-xs text-on-surface-variant flex gap-3 flex-wrap">
        <span>{a.runs} runs</span>
        {a.lastRunAt && <span>Last run {when(a.lastRunAt)}</span>}
        {s.lastUsed && <span>Last used {when(s.lastUsed)}</span>}
        {exhausted && <span className="text-error">Exhausted until {when(exhausted)}</span>}
      </div>
      {s.lastError && <div className="text-error text-xs font-code-sm break-all">Last error: {s.lastError}</div>}
      {check.data && (
        <div className={`text-xs ${check.data.ok ? "text-on-surface" : "text-error"}`}>
          {check.data.ok ? "Login check: ok" : `Login check: not logged in${check.data.error ? ` (${check.data.error})` : ""}`}
        </div>
      )}
      {s.loginOk !== true && a.login && <LoginStep login={a.login} />}
      {confirming && (
        <div className="flex items-center gap-2 flex-wrap text-xs">
          <span className="text-on-surface">Remove {a.label} from relay.json?</span>
          <label className="flex items-center gap-1 text-on-surface-variant">
            <input type="checkbox" checked={deleteFolder} onChange={(e) => setDeleteFolder(e.target.checked)} aria-label={`Also delete the folder of ${a.label}`} />
            Also delete the folder
          </label>
          <button type="button" aria-label={`Confirm remove ${a.label}`} onClick={() => remove.mutate()} disabled={runsActive || remove.isPending} title={lock} className={btn}>Confirm</button>
          <button type="button" onClick={() => { setConfirming(false); setDeleteFolder(false); }} className={btn}>Cancel</button>
        </div>
      )}
      {err && <div className="text-error text-xs">{err.message}</div>}
    </div>
  );
}
