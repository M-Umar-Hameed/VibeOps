import { useState, useEffect, type FormEvent } from "react";
import { api } from "../../lib/api.js";

type MarketplaceSkill = { name: string; description: string; dir: string; installed: boolean };
type Marketplace = { url: string; skills: MarketplaceSkill[] };
type InstalledSkill = { name: string; dir: string; url: string; installedAt: string; present: boolean };

export function PluginsTab() {
  const [installed, setInstalled] = useState<InstalledSkill[]>([]);
  const [marketplaces, setMarketplaces] = useState<Marketplace[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  const [newUrl, setNewUrl] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ key: string; message: string } | null>(null);

  async function loadAll() {
    try {
      const [inst, mkts] = await Promise.all([
        api.get("/skills/installed") as Promise<InstalledSkill[]>,
        api.get("/skills/marketplaces") as Promise<Marketplace[]>
      ]);
      setInstalled(inst);
      setMarketplaces(mkts);
      setListError(null);
    } catch (e) {
      setListError(e instanceof Error ? e.message : "Failed to load skills");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadAll();
  }, []);

  async function handleAddMarketplace(e: FormEvent) {
    e.preventDefault();
    setBusy("add-marketplace");
    setAddError(null);
    try {
      await api.post("/skills/marketplaces", { url: newUrl.trim() });
      setNewUrl("");
      await loadAll();
    } catch (err) {
      setAddError(err instanceof Error ? err.message : "Failed to add marketplace");
    } finally {
      setBusy(null);
    }
  }

  async function handleAction(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    setRowError(null);
    try {
      await fn();
      await loadAll();
    } catch (err) {
      setRowError({ key, message: err instanceof Error ? err.message : "Action failed" });
    } finally {
      setBusy(null);
    }
  }

  if (loading) {
    return (
      <div className="animate-in fade-in duration-500">
        <div className="text-sm text-on-surface-variant p-4">Loading plugins...</div>
      </div>
    );
  }

  return (
    <div className="animate-in fade-in slide-in-from-bottom-2 duration-500">
      <div className="mb-8 border-b border-white/10 pb-6">
        <h2 className="font-headline-md text-headline-md text-on-surface mb-2">Plugins</h2>
        <p className="text-on-surface-variant text-sm max-w-2xl">
          Manage skill marketplaces and install/uninstall agent skills.
        </p>
      </div>

      {listError && (
        <div className="bg-error-container/20 border border-error p-4 rounded text-error text-sm font-code-sm mb-6">
          {listError}
        </div>
      )}

      <div className="glass-card rounded-xl overflow-hidden border border-white/10 flex flex-col group mb-6">
        <div className="p-6 border-b border-white/5 bg-surface-container/30">
          <h3 className="font-headline-sm text-on-surface font-bold">Installed skills</h3>
        </div>
        <div className="p-6 flex flex-col">
          {installed.length === 0 ? (
            <p className="text-sm text-on-surface-variant">No skills installed.</p>
          ) : (
            installed.map((skill) => {
              const actionKey = `uninstall:${skill.name}`;
              return (
                <div key={skill.name} className="flex items-center justify-between gap-4 py-3 border-b border-white/5 last:border-0">
                  <div className="flex flex-col gap-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-on-surface">{skill.name}</span>
                      {!skill.present && (
                        <span className="text-xs px-2 py-1 rounded bg-white/5 text-on-surface-variant">missing on disk</span>
                      )}
                    </div>
                    <div className="text-xs text-on-surface-variant font-code-sm truncate max-w-[16rem]">
                      {skill.dir} • {skill.url}
                    </div>
                    <div className="text-xs text-on-surface-variant/70">
                      Installed {new Date(skill.installedAt).toLocaleDateString()}
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-1 flex-shrink-0">
                    <button
                      onClick={() => handleAction(actionKey, () => api.post("/skills/uninstall", { name: skill.name }))}
                      disabled={busy !== null}
                      className="px-3 py-1.5 rounded bg-white/5 hover:bg-error/20 hover:text-error text-on-surface text-xs font-medium transition-all disabled:opacity-50"
                    >
                      {busy === actionKey ? "Removing..." : "Uninstall"}
                    </button>
                    {rowError?.key === actionKey && <div className="text-xs text-error font-code-sm">{rowError.message}</div>}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      <div className="glass-card rounded-xl overflow-hidden border border-white/10 flex flex-col group mb-6">
        <div className="p-6 bg-surface-container/30">
          <form onSubmit={handleAddMarketplace} className="flex flex-col gap-3">
            <label className="text-xs font-code-sm text-on-surface-variant/70 block">Add marketplace</label>
            <div className="flex gap-2">
              <input
                type="text"
                required
                className="flex-1 bg-surface-container-lowest/50 border border-white/10 rounded px-3 py-2 text-sm text-on-surface font-code-sm outline-none"
                placeholder="https://github.com/owner/repo"
                value={newUrl}
                onChange={(e) => setNewUrl(e.target.value)}
              />
              <button
                type="submit"
                className="px-4 py-2 rounded bg-white/5 hover:bg-primary hover:text-on-primary text-on-surface text-sm font-medium transition-all disabled:opacity-50 flex-shrink-0"
                disabled={busy !== null || !newUrl.trim()}
              >
                {busy === "add-marketplace" ? "Adding..." : "Add"}
              </button>
            </div>
            {addError && <div className="text-xs text-error font-code-sm">{addError}</div>}
          </form>
        </div>
      </div>

      <div className="flex flex-col gap-6">
        {marketplaces.map((mkt) => {
          const refreshKey = `refresh:${mkt.url}`;
          const removeKey = `remove:${mkt.url}`;

          return (
            <div key={mkt.url} className="glass-card rounded-xl overflow-hidden border border-white/10 flex flex-col group">
              <div className="p-6 border-b border-white/5 bg-surface-container/30 flex items-center justify-between gap-4">
                <h3 className="font-headline-sm text-on-surface font-bold truncate" title={mkt.url}>{mkt.url}</h3>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <button
                    onClick={() => handleAction(refreshKey, () => api.post("/skills/marketplaces", { url: mkt.url }))}
                    disabled={busy !== null}
                    className="px-3 py-1.5 rounded bg-white/5 hover:bg-white/10 text-on-surface text-xs font-medium transition-all disabled:opacity-50"
                  >
                    {busy === refreshKey ? "Refreshing..." : "Refresh"}
                  </button>
                  <button
                    onClick={() => handleAction(removeKey, () => api.del("/skills/marketplaces", { url: mkt.url }))}
                    disabled={busy !== null}
                    className="px-3 py-1.5 rounded bg-white/5 hover:bg-error/20 hover:text-error text-on-surface text-xs font-medium transition-all disabled:opacity-50"
                  >
                    {busy === removeKey ? "Removing..." : "Remove"}
                  </button>
                </div>
              </div>
              
              {rowError?.key === refreshKey && <div className="px-6 pt-4 text-xs text-error font-code-sm">{rowError.message}</div>}
              {rowError?.key === removeKey && <div className="px-6 pt-4 text-xs text-error font-code-sm">{rowError.message}</div>}

              <div className="p-6 flex flex-col">
                {mkt.skills.length === 0 ? (
                  <p className="text-sm text-on-surface-variant">No skills found.</p>
                ) : (
                  mkt.skills.map((skill) => {
                    const installKey = `install:${mkt.url}:${skill.dir}`;
                    const uninstallKey = `uninstall:${skill.name}`;
                    const actionKey = skill.installed ? uninstallKey : installKey;

                    return (
                      <div key={skill.name} className="flex items-center justify-between gap-4 py-3 border-b border-white/5 last:border-0">
                        <div className="flex flex-col gap-1 min-w-0 flex-1">
                          <span className="text-sm font-medium text-on-surface">{skill.name}</span>
                          <span className="text-xs text-on-surface-variant line-clamp-2" title={skill.description}>
                            {skill.description}
                          </span>
                        </div>
                        <div className="flex flex-col items-end gap-1 flex-shrink-0">
                          {skill.installed ? (
                            <div className="flex items-center gap-3">
                              <span className="text-xs text-on-surface-variant">Installed</span>
                              <button
                                onClick={() => handleAction(actionKey, () => api.post("/skills/uninstall", { name: skill.name }))}
                                disabled={busy !== null}
                                className="px-3 py-1.5 rounded bg-white/5 hover:bg-error/20 hover:text-error text-on-surface text-xs font-medium transition-all disabled:opacity-50"
                              >
                                {busy === actionKey ? "Removing..." : "Uninstall"}
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() => handleAction(actionKey, () => api.post("/skills/install", { url: mkt.url, dir: skill.dir }))}
                              disabled={busy !== null}
                              className="px-3 py-1.5 rounded bg-primary/20 hover:bg-primary hover:text-on-primary text-primary text-xs font-medium transition-all disabled:opacity-50"
                            >
                              {busy === actionKey ? "Installing..." : "Install"}
                            </button>
                          )}
                          {rowError?.key === actionKey && <div className="text-xs text-error font-code-sm">{rowError.message}</div>}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
