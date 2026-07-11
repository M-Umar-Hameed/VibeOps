import { useState, useEffect } from "react";
import { getSettings, saveSettings } from "../../settings.js";
import { projects } from "../../api/projects.js";

export function LocalNodeTab({ rejected }: { rejected: boolean }) {
  const [baseUrl, setBaseUrl] = useState("http://localhost:8787");
  const [apiKey, setApiKey] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    getSettings().then((s) => {
      setBaseUrl(s.baseUrl);
      setApiKey(s.apiKey);
    });
  }, []);

  async function test() {
    setTesting(true);
    setStatus(null);
    await saveSettings({ baseUrl, apiKey });
    try { 
      await projects.list(); 
      setStatus("ok"); 
    }
    catch { 
      setStatus("bad"); 
    }
    setTesting(false);
  }
  
  async function save() { 
    await saveSettings({ baseUrl, apiKey }); 
  }

  return (
    <div className="animate-in fade-in slide-in-from-bottom-2 duration-500 max-w-4xl">
      <div className="mb-10">
        <h2 className="font-headline-md text-headline-md text-on-surface mb-2 flex items-center gap-3">
          <span className="material-symbols-outlined text-primary text-3xl">dns</span>
          Local Backend Node
        </h2>
        <p className="text-on-surface-variant font-code-sm text-sm">
          Connect to your locally running VibeOps instance.
        </p>
      </div>

      {rejected && (
        <div className="bg-error-container/20 border border-error p-4 rounded-xl text-error text-sm font-code-sm mb-8 flex items-center gap-3 shadow-[0_0_15px_rgba(255,84,73,0.2)]">
          <span className="material-symbols-outlined">warning</span>
          API Key rejected — access denied. Check your credentials.
        </div>
      )}

      <div className="space-y-6">
        <div className="glass-card p-6 md:p-8 rounded-2xl border border-white/5 relative overflow-hidden group hover:border-primary/30 transition-all duration-300">
          <div className="relative z-10 grid grid-cols-1 md:grid-cols-2 gap-8">
            <div className="space-y-6">
              <div>
                <label className="text-xs font-code-sm text-on-surface-variant/70 mb-2 block flex items-center gap-2">
                  <span className="material-symbols-outlined text-[16px] text-primary">key</span>
                  Security Token
                </label>
                <input 
                  type="password"
                  className="w-full bg-surface-container-lowest/80 border border-white/10 rounded-lg px-4 py-3 text-sm text-on-surface focus:border-primary focus:ring-1 focus:ring-primary/50 outline-none transition-all shadow-inner font-code-sm"
                  placeholder="Paste your API key here..."
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                />
              </div>

              <div>
                <label className="text-xs font-code-sm text-on-surface-variant/70 mb-2 block flex items-center gap-2">
                  <span className="material-symbols-outlined text-[16px] text-secondary">terminal</span>
                  Node URL
                </label>
                <input 
                  type="text"
                  className="w-full bg-surface-container-lowest/80 border border-white/10 rounded-lg px-4 py-3 text-sm text-on-surface focus:border-secondary focus:ring-1 focus:ring-secondary/50 outline-none transition-all shadow-inner font-code-sm"
                  placeholder="http://localhost:8787"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                />
              </div>
            </div>

            <div className="flex flex-col justify-between">
              <div className="bg-surface-container-highest/50 rounded-xl p-5 border border-white/5">
                <h4 className="text-sm font-bold text-on-surface mb-2 flex items-center gap-2">
                  <span className="material-symbols-outlined text-sm text-primary">help</span>
                  Need a key?
                </h4>
                <p className="text-xs text-on-surface-variant leading-relaxed mb-3">
                  If you are running the backend locally, you can easily generate a new master key from your terminal.
                </p>
                <div className="bg-background rounded-lg p-3 flex items-center justify-between border border-white/5 group/code cursor-copy relative overflow-hidden"
                     onClick={() => navigator.clipboard.writeText("npm run key")}>
                  <div className="absolute inset-0 bg-primary/10 translate-y-full group-hover/code:translate-y-0 transition-transform duration-300" />
                  <code className="text-xs font-code-sm text-primary relative z-10">npm run key</code>
                  <span className="material-symbols-outlined text-[14px] text-on-surface-variant group-hover/code:text-primary relative z-10 transition-colors">content_copy</span>
                </div>
              </div>

              <div className="flex gap-4 mt-6">
                <button 
                  className="flex-1 py-3 rounded-lg border border-white/10 font-medium text-sm text-on-surface hover:bg-surface-container-highest hover:border-white/20 transition-all flex items-center justify-center gap-2 disabled:opacity-50"
                  onClick={test}
                  disabled={testing}
                >
                  <span className={`material-symbols-outlined text-[18px] ${testing ? 'animate-spin text-primary' : ''}`}>
                    {testing ? 'refresh' : 'wifi_tethering'}
                  </span>
                  Test Link
                </button>
                <button 
                  className="flex-1 py-3 rounded-lg bg-primary text-on-primary font-bold text-sm hover:brightness-110 active:scale-[0.98] transition-all flex items-center justify-center gap-2 shadow-[0_0_20px_rgba(0,219,233,0.3)] hover:shadow-[0_0_25px_rgba(0,219,233,0.5)]"
                  onClick={save}
                >
                  <span className="material-symbols-outlined text-[18px]">save</span>
                  Save Config
                </button>
              </div>
            </div>
          </div>
          
          {/* Status Bar */}
          <div className="mt-8 pt-4 border-t border-white/5 flex items-center justify-between text-xs font-code-sm">
            <span className="text-on-surface-variant/60">UPLINK STATUS</span>
            <div className="flex items-center gap-2">
              <span className="relative flex h-2 w-2">
                <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${status === 'ok' ? 'bg-primary' : status === 'bad' ? 'bg-error' : 'bg-on-surface-variant'}`}></span>
                <span className={`relative inline-flex rounded-full h-2 w-2 ${status === 'ok' ? 'bg-primary' : status === 'bad' ? 'bg-error' : 'bg-on-surface-variant'}`}></span>
              </span>
              <span className={`${status === 'ok' ? 'text-primary' : status === 'bad' ? 'text-error' : 'text-on-surface-variant'}`}>
                {status === 'ok' ? 'CONNECTED' : status === 'bad' ? 'CONNECTION REFUSED' : 'WAITING'}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
