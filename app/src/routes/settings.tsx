import { useState } from "react";
import { isAuthRejected } from "../lib/queryClient.js";
import { LocalNodeTab } from "../components/settings/LocalNodeTab.js";
import { IntegrationsTab } from "../components/settings/IntegrationsTab.js";
import { AIModelsTab } from "../components/settings/AIModelsTab.js";
import { MCPTab } from "../components/settings/MCPTab.js";

type TabId = "node" | "integrations" | "ai" | "mcp";

export function SettingsScreen() {
  const [activeTab, setActiveTab] = useState<TabId>("integrations");
  const [rejected] = useState(isAuthRejected);

  const tabs: { id: TabId; label: string; icon: string }[] = [
    { id: "integrations", label: "Integrations", icon: "hub" },
    { id: "ai", label: "AI Models", icon: "psychology" },
    { id: "mcp", label: "MCP Servers", icon: "extension" },
    { id: "node", label: "Local Node", icon: "dns" },
  ];

  return (
    <div className="max-w-6xl mx-auto pt-8 flex flex-col md:flex-row gap-8 h-[calc(100vh-8rem)]">
      {/* Settings Sidebar */}
      <div className="w-full md:w-64 flex-shrink-0 space-y-2">
        <h2 className="text-xs font-code-label text-on-surface-variant/60 uppercase tracking-wider mb-4 px-4">Settings Menu</h2>
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition-all ${
              activeTab === tab.id 
                ? "bg-primary/10 text-primary border border-primary/20" 
                : "text-on-surface-variant hover:bg-white/5 hover:text-on-surface border border-transparent"
            }`}
          >
            <span className="material-symbols-outlined text-[20px]">{tab.icon}</span>
            {tab.label}
          </button>
        ))}
      </div>

      {/* Main Content Area */}
      <div className="flex-1 overflow-y-auto pr-4 terminal-scroll">
        {activeTab === "node" && <LocalNodeTab rejected={rejected} />}
        {activeTab === "integrations" && <IntegrationsTab />}
        {activeTab === "ai" && <AIModelsTab />}
        {activeTab === "mcp" && <MCPTab />}
      </div>
    </div>
  );
}
