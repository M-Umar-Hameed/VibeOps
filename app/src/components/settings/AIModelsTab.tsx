import { useState } from "react";

export function AIModelsTab() {
  const [openaiKey, setOpenaiKey] = useState("");
  const [anthropicKey, setAnthropicKey] = useState("");
  const [ollamaUrl, setOllamaUrl] = useState("http://localhost:11434");

  return (
    <div className="animate-in fade-in slide-in-from-bottom-2 duration-500">
      <div className="mb-8 border-b border-white/10 pb-6">
        <h2 className="font-headline-md text-headline-md text-on-surface mb-2">AI Model Providers</h2>
        <p className="text-on-surface-variant text-sm max-w-2xl">
          Configure the AI models that power VibeOps intelligent features like auto-tagging, summarization, and codebase querying.
        </p>
      </div>

      <div className="space-y-6 max-w-3xl">
        {/* OpenAI Card */}
        <div className="glass-card rounded-xl overflow-hidden border border-white/10 flex flex-col md:flex-row md:items-center gap-6 p-6 group hover:border-white/20 transition-all duration-300">
          <div className="flex items-center gap-4 min-w-[200px]">
            <div className="w-12 h-12 bg-white rounded-full flex items-center justify-center">
              {/* Simple OpenAI-like logo using css/unicode */}
              <span className="text-black text-2xl">✹</span>
            </div>
            <div>
              <h3 className="font-headline-sm text-on-surface font-bold">OpenAI</h3>
              <p className="text-xs text-on-surface-variant">GPT-4 & Embeddings</p>
            </div>
          </div>
          
          <div className="flex-1 flex flex-col md:flex-row gap-4 items-end">
            <div className="flex-1 w-full">
              <label className="text-xs font-code-sm text-on-surface-variant/70 mb-1 block">API Key</label>
              <input 
                type="password" 
                className="w-full bg-surface-container-lowest/50 border border-white/10 rounded px-3 py-2 text-sm text-on-surface focus:border-primary outline-none transition-colors"
                placeholder="sk-..."
                value={openaiKey}
                onChange={(e) => setOpenaiKey(e.target.value)}
              />
            </div>
            <button className="px-6 py-2.5 rounded bg-white/5 hover:bg-primary hover:text-on-primary text-on-surface text-sm font-medium transition-all">
              Save
            </button>
          </div>
        </div>

        {/* Anthropic Card */}
        <div className="glass-card rounded-xl overflow-hidden border border-white/10 flex flex-col md:flex-row md:items-center gap-6 p-6 group hover:border-[#D97757]/40 transition-all duration-300">
          <div className="flex items-center gap-4 min-w-[200px]">
            <div className="w-12 h-12 bg-[#D97757]/20 rounded-xl flex items-center justify-center">
              <span className="font-serif italic text-2xl text-[#D97757]">C</span>
            </div>
            <div>
              <h3 className="font-headline-sm text-on-surface font-bold">Anthropic</h3>
              <p className="text-xs text-on-surface-variant">Claude 3.5 Sonnet</p>
            </div>
          </div>
          
          <div className="flex-1 flex flex-col md:flex-row gap-4 items-end">
            <div className="flex-1 w-full">
              <label className="text-xs font-code-sm text-on-surface-variant/70 mb-1 block">API Key</label>
              <input 
                type="password" 
                className="w-full bg-surface-container-lowest/50 border border-white/10 rounded px-3 py-2 text-sm text-on-surface focus:border-primary outline-none transition-colors"
                placeholder="sk-ant-..."
                value={anthropicKey}
                onChange={(e) => setAnthropicKey(e.target.value)}
              />
            </div>
            <button className="px-6 py-2.5 rounded bg-white/5 hover:bg-primary hover:text-on-primary text-on-surface text-sm font-medium transition-all">
              Save
            </button>
          </div>
        </div>

        {/* Local Ollama Card */}
        <div className="glass-card rounded-xl overflow-hidden border border-white/10 flex flex-col md:flex-row md:items-center gap-6 p-6 group hover:border-secondary/40 transition-all duration-300">
          <div className="flex items-center gap-4 min-w-[200px]">
            <div className="w-12 h-12 bg-surface-container-highest rounded-xl flex items-center justify-center">
              <img src="https://ollama.com/public/icon-64x64.png" alt="Ollama" className="w-8 h-8" onError={(e) => e.currentTarget.style.display = 'none'} />
              <span className="material-symbols-outlined text-secondary absolute -z-10">smart_toy</span>
            </div>
            <div>
              <h3 className="font-headline-sm text-on-surface font-bold">Local Model</h3>
              <p className="text-xs text-on-surface-variant">Ollama / Llama 3</p>
            </div>
          </div>
          
          <div className="flex-1 flex flex-col md:flex-row gap-4 items-end">
            <div className="flex-1 w-full">
              <label className="text-xs font-code-sm text-on-surface-variant/70 mb-1 block">Local Server URL</label>
              <input 
                type="text" 
                className="w-full bg-surface-container-lowest/50 border border-white/10 rounded px-3 py-2 text-sm text-on-surface focus:border-primary outline-none transition-colors"
                placeholder="http://localhost:11434"
                value={ollamaUrl}
                onChange={(e) => setOllamaUrl(e.target.value)}
              />
            </div>
            <button className="px-6 py-2.5 rounded bg-white/5 hover:bg-primary hover:text-on-primary text-on-surface text-sm font-medium transition-all">
              Save
            </button>
          </div>
        </div>

      </div>
    </div>
  );
}
