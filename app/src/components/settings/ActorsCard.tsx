import { useState, useEffect, type FormEvent } from "react";
import { actors } from "../../api/actors.js";
import type { Actor } from "../../api/types.js";

export function ActorsCard() {
  const [list, setList] = useState<Actor[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  function load() {
    actors
      .list()
      .then(setList)
      .catch((e) => setListError(e instanceof Error ? e.message : "Failed to load actors"));
  }

  useEffect(() => { load(); }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setCreating(true);
    setCreateError(null);
    try {
      const result = await actors.create({ name, kind: "agent", role: "member" });
      setNewKey(result.apiKey);
      setName("");
      load();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to create agent key");
    }
    setCreating(false);
  }

  function copyKey() {
    if (!newKey) return;
    navigator.clipboard.writeText(newKey).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }

  return (
    <div className="glass-card rounded-xl overflow-hidden border border-white/10 flex flex-col group hover:border-primary/30 transition-all duration-300">
      <div className="p-6 border-b border-white/5 bg-surface-container/30 flex items-center gap-4">
        <div className="w-10 h-10 bg-primary/20 rounded-full flex items-center justify-center">
          <span className="material-symbols-outlined text-primary">badge</span>
        </div>
        <div>
          <h3 className="font-headline-sm text-on-surface font-bold">Actors</h3>
          <p className="text-xs text-on-surface-variant">Roles and agent keys</p>
        </div>
      </div>

      <div className="p-6 flex-1 flex flex-col gap-4">
        {listError && (
          <div className="bg-error-container/20 border border-error p-4 rounded text-error text-sm font-code-sm">
            {listError}
          </div>
        )}

        <div className="flex flex-col">
          {list.map((a) => (
            <div key={a.id} className="flex items-center justify-between gap-4 py-3 border-b border-white/5 last:border-0">
              <span className="text-sm text-on-surface font-medium">{a.name}</span>
              <div className="flex items-center gap-2">
                <span className="text-xs px-2 py-1 rounded bg-white/5 text-on-surface-variant">{a.kind}</span>
                <span className="text-xs px-2 py-1 rounded bg-white/5 text-on-surface-variant">{a.role}</span>
              </div>
            </div>
          ))}
        </div>

        <form onSubmit={onSubmit} className="flex flex-col gap-3 pt-4 border-t border-white/5">
          <label className="text-xs font-code-sm text-on-surface-variant/70 block">New agent key</label>
          <div className="flex gap-2">
            <input
              type="text"
              required
              className="flex-1 bg-surface-container-lowest/50 border border-white/10 rounded px-3 py-2 text-sm text-on-surface font-code-sm outline-none"
              placeholder="Agent name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <button
              type="submit"
              className="px-4 py-2 rounded bg-white/5 hover:bg-primary hover:text-on-primary text-on-surface text-sm font-medium transition-all disabled:opacity-50"
              disabled={creating}
            >
              {creating ? "Creating..." : "Create"}
            </button>
          </div>
          {createError && <div className="text-xs text-error font-code-sm">{createError}</div>}
        </form>

        {newKey && (
          <div className="bg-surface-container-highest/50 rounded-xl p-4 border border-white/5 flex flex-col gap-2">
            <div className="flex gap-2">
              <input
                type="text"
                readOnly
                value={newKey}
                className="flex-1 bg-surface-container-lowest/50 border border-white/10 rounded px-3 py-2 text-xs text-on-surface font-code-sm outline-none"
              />
              <button
                type="button"
                onClick={copyKey}
                className="px-4 py-2 rounded bg-white/5 hover:bg-primary hover:text-on-primary text-on-surface text-sm font-medium transition-all flex items-center gap-2"
              >
                <span className="material-symbols-outlined text-[16px]">{copied ? "check" : "content_copy"}</span>
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <p className="text-xs text-error font-code-sm">Store it now — it cannot be retrieved later.</p>
          </div>
        )}
      </div>
    </div>
  );
}
