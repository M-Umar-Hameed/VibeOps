import { useState } from "react";

export function MCPTab() {
  const [serverUrl, setServerUrl] = useState("");

  const mockServers = [
    { name: "Figma Design System", status: "connected", icon: "draw" },
    { name: "PostgreSQL Database Admin", status: "disconnected", icon: "database" },
    { name: "AWS Cloud Control", status: "disconnected", icon: "cloud" },
  ];

  return (
    <div className="animate-in fade-in slide-in-from-bottom-2 duration-500">
      <div className="mb-8 border-b border-white/10 pb-6 flex justify-between items-end">
        <div>
          <h2 className="font-headline-md text-headline-md text-on-surface mb-2">Model Context Protocol (MCP)</h2>
          <p className="text-on-surface-variant text-sm max-w-2xl">
            Supercharge VibeOps by connecting external tools and knowledge sources that AI agents can utilize automatically.
          </p>
        </div>
        <button className="px-4 py-2 rounded bg-primary text-on-primary font-medium text-sm flex items-center gap-2 hover:brightness-110 transition-all">
          <span className="material-symbols-outlined text-sm">add</span>
          Add Custom Server
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-10">
        {mockServers.map((server, i) => (
          <div key={i} className="glass-card p-5 rounded-xl border border-white/5 flex items-center gap-4 group hover:border-white/20 transition-colors cursor-pointer">
            <div className={`w-10 h-10 rounded-full flex items-center justify-center ${server.status === 'connected' ? 'bg-primary/20 text-primary' : 'bg-surface-container-highest text-on-surface-variant'}`}>
              <span className="material-symbols-outlined">{server.icon}</span>
            </div>
            <div className="flex-1">
              <h4 className="text-sm font-medium text-on-surface">{server.name}</h4>
              <p className={`text-xs mt-0.5 ${server.status === 'connected' ? 'text-primary' : 'text-on-surface-variant/60'}`}>
                {server.status === 'connected' ? 'Connected' : 'Not Configured'}
              </p>
            </div>
            <div className="opacity-0 group-hover:opacity-100 transition-opacity">
              <span className="material-symbols-outlined text-on-surface-variant hover:text-on-surface">settings</span>
            </div>
          </div>
        ))}
      </div>

      <div className="glass-card rounded-xl border border-white/10 overflow-hidden max-w-2xl">
        <div className="p-5 border-b border-white/5 bg-surface-container/50">
          <h3 className="text-sm font-medium text-on-surface flex items-center gap-2">
            <span className="material-symbols-outlined text-primary-fixed-dim text-sm">terminal</span>
            Manual Connection
          </h3>
        </div>
        <div className="p-5 flex flex-col sm:flex-row gap-4">
          <div className="flex-1">
            <label className="text-xs font-code-sm text-on-surface-variant/70 mb-1 block">Server CLI Command or URL</label>
            <input 
              type="text" 
              className="w-full bg-surface-container-lowest/50 border border-white/10 rounded px-3 py-2 text-sm text-on-surface focus:border-primary outline-none transition-colors font-code-sm"
              placeholder="npx -y @modelcontextprotocol/server-postgres..."
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
            />
          </div>
          <div className="flex items-end">
            <button className="px-6 py-2 rounded bg-surface-container-highest hover:bg-white/10 text-on-surface text-sm font-medium transition-all h-[38px]">
              Connect
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
