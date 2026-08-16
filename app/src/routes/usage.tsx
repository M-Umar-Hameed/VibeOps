import { AIUsageTab } from "../components/settings/AIUsageTab.js";

export function UsageScreen() {
  return (
    <div className="absolute inset-0 flex flex-col overflow-hidden bg-surface-container-lowest">
      <div className="shrink-0 p-6 md:px-8 md:pt-8">
        <h1 className="font-headline-sm text-on-surface font-bold">Usage</h1>
        <p className="text-sm text-on-surface-variant/70 mt-1">AI token usage observed from local session logs.</p>
      </div>
      <div className="flex-1 overflow-y-auto px-6 md:px-8 pb-8 terminal-scroll">
        <AIUsageTab />
      </div>
    </div>
  );
}
