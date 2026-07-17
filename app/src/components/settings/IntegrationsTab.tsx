import { WorkspacesCard } from "./WorkspacesCard.js";
import { ObsidianIntegrationCard } from "./ObsidianIntegrationCard.js";
import { PlatformIntegrationCard } from "./PlatformIntegrationCard.js";

export function IntegrationsTab() {
  return (
    <div className="animate-in fade-in slide-in-from-bottom-2 duration-500">
      <div className="mb-8 border-b border-white/10 pb-6">
        <h2 className="font-headline-md text-headline-md text-on-surface mb-2">Connect Your Workspace</h2>
        <p className="text-on-surface-variant text-sm max-w-2xl">
          Sync your tickets, issues, and projects seamlessly. VibeOps currently supports zero-config syncing from popular version control and issue tracking platforms.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        <WorkspacesCard />
        <ObsidianIntegrationCard />

        <PlatformIntegrationCard
          id="github"
          title="GitHub"
          subtitle="Issues & Projects"
          borderColorClass="primary/30"
          icon={<img src="https://github.githubassets.com/images/modules/logos_page/GitHub-Mark.png" alt="GitHub" className="w-10 h-10 invert opacity-90 rounded-full" />}
          fields={[
            { key: "github.repo", label: "Repository (e.g. owner/repo)", placeholder: "owner/repo" },
            { key: "github.token", label: "Personal Access Token", type: "password", link: { text: "Get Token", url: "https://github.com/settings/tokens" } }
          ]}
        />

        <PlatformIntegrationCard
          id="gitlab"
          title="GitLab"
          subtitle="Issues & Epics"
          borderColorClass="[#FC6D26]/30"
          icon={<div className="w-10 h-10 bg-[#FC6D26]/20 rounded-full flex items-center justify-center"><span className="material-symbols-outlined text-[#FC6D26]">webhook</span></div>}
          fields={[
            { key: "gitlab.url", label: "Host URL", placeholder: "https://gitlab.com" },
            { key: "gitlab.token", label: "Personal Access Token", type: "password", link: { text: "Get Token", url: "https://gitlab.com/-/profile/personal_access_tokens" } }
          ]}
        />

        <PlatformIntegrationCard
          id="jira"
          title="Jira"
          subtitle="Issues & Sprints"
          borderColorClass="[#0052CC]/30"
          icon={<div className="w-10 h-10 bg-[#0052CC]/20 rounded-full flex items-center justify-center"><span className="material-symbols-outlined text-[#0052CC]">view_kanban</span></div>}
          fields={[
            { key: "jira.url", label: "Jira URL", placeholder: "https://your-domain.atlassian.net" },
            { key: "jira.token", label: "API Token", type: "password", link: { text: "Get Token", url: "https://id.atlassian.com/manage-profile/security/api-tokens" } }
          ]}
        />

        <PlatformIntegrationCard
          id="asana"
          title="Asana"
          subtitle="Tasks & Workflows"
          borderColorClass="[#F06A6A]/30"
          icon={<div className="w-10 h-10 bg-[#F06A6A]/20 rounded-full flex items-center justify-center"><span className="material-symbols-outlined text-[#F06A6A]">task_alt</span></div>}
          fields={[
            { key: "asana.workspace", label: "Workspace ID", placeholder: "e.g. 1234567890" },
            { key: "asana.token", label: "Personal Access Token", type: "password", link: { text: "Get Token", url: "https://app.asana.com/0/my-apps" } }
          ]}
        />

        <PlatformIntegrationCard
          id="rrmservices"
          title="RRM Services"
          subtitle="Internal Infrastructure"
          borderColorClass="secondary/30"
          icon={<div className="w-10 h-10 bg-secondary/20 rounded-full flex items-center justify-center"><span className="material-symbols-outlined text-secondary">dns</span></div>}
          fields={[
            { key: "rrmservices.url", label: "Endpoint URL", placeholder: "https://api.rrmservices.com" },
            { key: "rrmservices.token", label: "Service Token", type: "password" }
          ]}
        />
      </div>
    </div>
  );
}
