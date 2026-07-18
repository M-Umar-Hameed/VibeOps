import { useState } from "react";
import { isAuthRejected } from "../lib/queryClient.js";
import { LocalNodeTab } from "../components/settings/LocalNodeTab.js";
import { IntegrationsTab } from "../components/settings/IntegrationsTab.js";
import { AIModelsTab } from "../components/settings/AIModelsTab.js";
import { MCPTab } from "../components/settings/MCPTab.js";
import { PluginsTab } from "../components/settings/PluginsTab.js";

type TabId = "node" | "integrations" | "ai" | "mcp" | "plugins";

export function SettingsScreen() {
  const initTab = (new URLSearchParams(window.location.search).get("tab") as TabId) || "integrations";
  const [activeTab, setActiveTab] = useState<TabId>(initTab);
  const [rejected] = useState(isAuthRejected);

  const tabs: { id: TabId; label: string; icon: string }[] = [
    { id: "integrations", label: "Integrations", icon: "hub" },
    { id: "ai", label: "AI Models", icon: "psychology" },
    { id: "mcp", label: "MCP Servers", icon: "extension" },
    { id: "plugins", label: "Plugins", icon: "extension" },
    { id: "node", label: "Local Node", icon: "dns" },
  ];

  return (
    <div className="absolute inset-0 flex flex-col overflow-hidden bg-surface-container-lowest">
      <div className="shrink-0 p-6 md:px-8 md:pt-8">
        <h1 className="font-headline-sm text-on-surface font-bold">Settings</h1>
        <p className="text-sm text-on-surface-variant/70 mt-1">Configure integrations, models, and connections.</p>
      </div>
      <div className="flex-1 flex flex-col md:flex-row overflow-hidden">
        {/* Settings Sidebar */}
        <div className="w-full md:w-64 flex-shrink-0 flex md:block overflow-x-auto md:overflow-visible space-x-2 md:space-x-0 md:space-y-2 p-6 md:p-8 pt-0 md:pt-0 hide-scrollbar">
          <h2 className="hidden md:block text-xs font-code-label text-on-surface-variant/60 uppercase tracking-wider mb-4 px-4">Settings Menu</h2>
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex-shrink-0 md:w-full flex items-center gap-2 md:gap-3 px-4 py-2 md:py-3 rounded-lg text-sm font-medium transition-all ${
              activeTab === tab.id 
                ? "bg-primary/10 text-primary border border-primary/20" 
                : "text-on-surface-variant hover:bg-white/5 hover:text-on-surface border border-transparent"
            }`}
          >
            <span className="material-symbols-outlined text-[18px] md:text-[20px]">{tab.icon}</span>
            <span className="whitespace-nowrap">{tab.label}</span>
          </button>
        ))}
      </div>

      {/* Main Content Area */}
      <div className="flex-1 overflow-y-auto px-6 md:px-8 pb-8 terminal-scroll">
        {activeTab === "node" && <LocalNodeTab rejected={rejected} />}
        {activeTab === "integrations" && <IntegrationsTab />}
        {activeTab === "ai" && <AIModelsTab />}
        {activeTab === "mcp" && <MCPTab />}
        {activeTab === "plugins" && <PluginsTab />}
      </div>
    </div>
  </div>
  );
}
