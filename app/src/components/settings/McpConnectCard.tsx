import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiFetch } from "../../api/client.js";

type McpConfig = {
  url: string;
  claudeCode: { command: string };
  cursor: { path: string; snippet: unknown };
  gemini: { path: string; snippet: unknown };
};

type InstallResult = { path: string; backedUp: boolean };
type InstallableClient = "cursor" | "gemini";

const getMcpConfig = () => apiFetch("/mcp/config", {}) as Promise<McpConfig>;
const installMcp = (client: InstallableClient) =>
  apiFetch("/mcp/install", { method: "POST", body: { client } }) as Promise<InstallResult>;

function InstallRow({ label, client }: { label: string; client: InstallableClient }) {
  const install = useMutation({ mutationFn: () => installMcp(client) });

  return (
    <div className="flex items-center justify-between gap-4 py-3 border-b border-white/5 last:border-0">
      <div>
        <div className="text-sm text-on-surface font-medium">{label}</div>
        {install.isSuccess && (
          <div className="text-xs text-on-surface-variant font-code-sm mt-1">
            Wrote {install.data.path}
            {install.data.backedUp ? " (backed up existing config)" : ""}
          </div>
        )}
        {install.isError && (
          <div className="text-xs text-error font-code-sm mt-1">
            {install.error instanceof Error ? install.error.message : "Install failed"}
          </div>
        )}
      </div>
      <button
        className="px-4 py-2 rounded bg-white/5 hover:bg-primary hover:text-on-primary text-on-surface text-sm font-medium transition-all disabled:opacity-50 flex items-center gap-2"
        onClick={() => install.mutate()}
        disabled={install.isPending}
      >
        <span className="material-symbols-outlined text-[16px]">{install.isSuccess ? "check" : "download"}</span>
        {install.isSuccess ? "Installed" : install.isPending ? "Installing..." : "Install"}
      </button>
    </div>
  );
}

export function McpConnectCard() {
  const configQ = useQuery({ queryKey: ["mcpConfig"], queryFn: getMcpConfig });
  const [copied, setCopied] = useState(false);

  function copyCommand() {
    if (!configQ.data) return;
    navigator.clipboard.writeText(configQ.data.claudeCode.command);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="glass-card rounded-xl overflow-hidden border border-white/10 flex flex-col group hover:border-primary/30 transition-all duration-300">
      <div className="p-6 border-b border-white/5 bg-surface-container/30 flex items-center gap-4">
        <div className="w-10 h-10 bg-primary/20 rounded-full flex items-center justify-center">
          <span className="material-symbols-outlined text-primary">hub</span>
        </div>
        <div>
          <h3 className="font-headline-sm text-on-surface font-bold">Connect an Agent</h3>
          <p className="text-xs text-on-surface-variant">Model Context Protocol (MCP)</p>
        </div>
      </div>

      <div className="p-6 flex-1 flex flex-col gap-4">
        {configQ.isLoading && <div className="text-sm text-on-surface-variant font-code-sm">Loading...</div>}
        {configQ.isError && (
          <div className="bg-error-container/20 border border-error p-4 rounded text-error text-sm font-code-sm">
            {configQ.error instanceof Error ? configQ.error.message : "Failed to load MCP config"}
          </div>
        )}

        {configQ.data && (
          <>
            <div>
              <label className="text-xs font-code-sm text-on-surface-variant/70 mb-1 block">MCP URL</label>
              <div className="w-full bg-surface-container-lowest/50 border border-white/10 rounded px-3 py-2 text-sm text-on-surface font-code-sm">
                {configQ.data.url}
              </div>
            </div>

            <div>
              <label className="text-xs font-code-sm text-on-surface-variant/70 mb-1 block">Claude Code</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  readOnly
                  className="flex-1 bg-surface-container-lowest/50 border border-white/10 rounded px-3 py-2 text-xs text-on-surface font-code-sm outline-none"
                  value={configQ.data.claudeCode.command}
                />
                <button
                  className="px-4 py-2 rounded bg-white/5 hover:bg-primary hover:text-on-primary text-on-surface text-sm font-medium transition-all flex items-center gap-2"
                  onClick={copyCommand}
                >
                  <span className="material-symbols-outlined text-[16px]">{copied ? "check" : "content_copy"}</span>
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
            </div>

            <InstallRow label="Cursor" client="cursor" />
            <InstallRow label="Gemini" client="gemini" />
          </>
        )}
      </div>
    </div>
  );
}
