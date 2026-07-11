import { useState } from "react";

export function IntegrationsTab() {
  const [githubToken, setGithubToken] = useState("");
  const [githubRepo, setGithubRepo] = useState("");
  
  return (
    <div className="animate-in fade-in slide-in-from-bottom-2 duration-500">
      <div className="mb-8 border-b border-white/10 pb-6">
        <h2 className="font-headline-md text-headline-md text-on-surface mb-2">Connect Your Workspace</h2>
        <p className="text-on-surface-variant text-sm max-w-2xl">
          Sync your tickets, issues, and projects seamlessly. VibeOps currently supports zero-config syncing from popular version control and issue tracking platforms.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {/* GitHub Integration Card */}
        <div className="glass-card rounded-xl overflow-hidden border border-white/10 flex flex-col group hover:border-primary/30 transition-all duration-300">
          <div className="p-6 border-b border-white/5 bg-surface-container/30 flex items-center gap-4">
            <img src="https://github.githubassets.com/images/modules/logos_page/GitHub-Mark.png" alt="GitHub" className="w-10 h-10 invert opacity-90 rounded-full" />
            <div>
              <h3 className="font-headline-sm text-on-surface font-bold">GitHub</h3>
              <p className="text-xs text-on-surface-variant">Issues & Projects</p>
            </div>
          </div>
          
          <div className="p-6 flex-1 flex flex-col gap-4">
            <div>
              <label className="text-xs font-code-sm text-on-surface-variant/70 mb-1 block">Repository (e.g. M-Umar-Hameed/VibeOps)</label>
              <input 
                type="text" 
                className="w-full bg-surface-container-lowest/50 border border-white/10 rounded px-3 py-2 text-sm text-on-surface focus:border-primary outline-none transition-colors"
                placeholder="owner/repo"
                value={githubRepo}
                onChange={(e) => setGithubRepo(e.target.value)}
              />
            </div>
            <div>
              <label className="text-xs font-code-sm text-on-surface-variant/70 mb-1 block">
                Personal Access Token
                <a href="https://github.com/settings/tokens" target="_blank" rel="noreferrer" className="text-primary hover:underline ml-2 text-[10px]">Get Token &rarr;</a>
              </label>
              <input 
                type="password" 
                className="w-full bg-surface-container-lowest/50 border border-white/10 rounded px-3 py-2 text-sm text-on-surface focus:border-primary outline-none transition-colors"
                placeholder="ghp_..."
                value={githubToken}
                onChange={(e) => setGithubToken(e.target.value)}
              />
            </div>
            
            <button className="mt-auto w-full py-2.5 rounded bg-white/5 hover:bg-primary hover:text-on-primary text-on-surface text-sm font-medium transition-all flex items-center justify-center gap-2">
              <span className="material-symbols-outlined text-sm">link</span>
              Connect GitHub
            </button>
          </div>
        </div>

        {/* GitLab Integration Card */}
        <div className="glass-card rounded-xl overflow-hidden border border-white/10 flex flex-col group hover:border-[#FC6D26]/30 transition-all duration-300 opacity-70 grayscale hover:grayscale-0 hover:opacity-100">
          <div className="p-6 border-b border-white/5 bg-surface-container/30 flex items-center gap-4">
            <div className="w-10 h-10 bg-[#FC6D26]/20 rounded-full flex items-center justify-center">
              <span className="material-symbols-outlined text-[#FC6D26]">webhook</span>
            </div>
            <div>
              <h3 className="font-headline-sm text-on-surface font-bold">GitLab</h3>
              <p className="text-xs text-on-surface-variant">Issues & Epics</p>
            </div>
          </div>
          <div className="p-6 flex-1 flex flex-col justify-center items-center text-center gap-2">
            <span className="material-symbols-outlined text-3xl text-on-surface-variant/30">construction</span>
            <p className="text-sm text-on-surface-variant">Coming Soon</p>
          </div>
        </div>

        {/* Jira Integration Card */}
        <div className="glass-card rounded-xl overflow-hidden border border-white/10 flex flex-col group hover:border-[#0052CC]/30 transition-all duration-300 opacity-70 grayscale hover:grayscale-0 hover:opacity-100">
          <div className="p-6 border-b border-white/5 bg-surface-container/30 flex items-center gap-4">
            <div className="w-10 h-10 bg-[#0052CC]/20 rounded-full flex items-center justify-center">
              <span className="material-symbols-outlined text-[#0052CC]">view_kanban</span>
            </div>
            <div>
              <h3 className="font-headline-sm text-on-surface font-bold">Jira</h3>
              <p className="text-xs text-on-surface-variant">Issues & Sprints</p>
            </div>
          </div>
          <div className="p-6 flex-1 flex flex-col justify-center items-center text-center gap-2">
            <span className="material-symbols-outlined text-3xl text-on-surface-variant/30">construction</span>
            <p className="text-sm text-on-surface-variant">Coming Soon</p>
          </div>
        </div>
      </div>
    </div>
  );
}
