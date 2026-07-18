import { WorkspacesCard, ProjectWorkspaceRow } from "./WorkspacesCard.js";
import { ObsidianIntegrationCard } from "./ObsidianIntegrationCard.js";
import { PlatformIntegrationCard } from "./PlatformIntegrationCard.js";
import { ProjectBindingsCard } from "./ProjectBindingsCard.js";
import { useProject } from "../../context/project.js";

export function IntegrationsTab() {
  const { projects, activeProjectId } = useProject();
  const activeProject = activeProjectId ? projects.find(p => p.id === activeProjectId) : null;

  if (activeProject) {
    return (
      <div className="animate-in fade-in slide-in-from-bottom-2 duration-500">
        <div className="mb-8 border-b border-white/10 pb-6">
          <h2 className="font-headline-md text-headline-md text-on-surface mb-2">Connections for {activeProject.name}</h2>
          <p className="text-on-surface-variant text-sm max-w-2xl">
            Configure integrations specifically for this project.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          <div className="glass-card rounded-xl overflow-hidden border border-white/10 flex flex-col group hover:border-primary/30 transition-all duration-300">
            <div className="p-6 border-b border-white/5 bg-surface-container/30 flex items-center gap-4">
              <div className="w-10 h-10 bg-primary/20 rounded-full flex items-center justify-center">
                <span className="material-symbols-outlined text-primary">folder</span>
              </div>
              <div>
                <h3 className="font-headline-sm text-on-surface font-bold">Workspace</h3>
                <p className="text-xs text-on-surface-variant">Local repository</p>
              </div>
            </div>
            <div className="p-6 flex-1 flex flex-col gap-4">
              <ProjectWorkspaceRow project={activeProject} />
            </div>
          </div>

          <ProjectBindingsCard
            projectId={activeProject.id}
            id="github"
            title="GitHub"
            subtitle="Issues & Projects"
            borderColorClass="primary/30"
            icon={<img src="https://github.githubassets.com/images/modules/logos_page/GitHub-Mark.png" alt="GitHub" className="w-10 h-10 invert opacity-90 rounded-full" />}
            bindingKey="github.repo"
            label="Repository (e.g. owner/repo)"
            placeholder="owner/repo"
            globalCredentialKey="github.token"
          />

          <ProjectBindingsCard
            projectId={activeProject.id}
            id="gitlab"
            title="GitLab"
            subtitle="Issues & Epics"
            borderColorClass="[#FC6D26]/30"
            icon={<div className="w-10 h-10 bg-[#FC6D26]/20 rounded-full flex items-center justify-center"><span className="material-symbols-outlined text-[#FC6D26]">webhook</span></div>}
            bindingKey="gitlab.project"
            label="Project Path (e.g. owner/project)"
            placeholder="owner/project"
            globalCredentialKey="gitlab.token"
          />

          <ProjectBindingsCard
            projectId={activeProject.id}
            id="jira"
            title="Jira"
            subtitle="Issues & Sprints"
            borderColorClass="[#0052CC]/30"
            icon={<div className="w-10 h-10 bg-[#0052CC]/20 rounded-full flex items-center justify-center"><span className="material-symbols-outlined text-[#0052CC]">view_kanban</span></div>}
            bindingKey="jira.project"
            label="Jira Project Key"
            placeholder="e.g. ENG"
            globalCredentialKey="jira.token"
          />

          <ProjectBindingsCard
            projectId={activeProject.id}
            id="asana"
            title="Asana"
            subtitle="Tasks & Workflows"
            borderColorClass="[#F06A6A]/30"
            icon={<div className="w-10 h-10 bg-[#F06A6A]/20 rounded-full flex items-center justify-center"><span className="material-symbols-outlined text-[#F06A6A]">task_alt</span></div>}
            bindingKey="asana.projectGid"
            label="Asana Project GID"
            placeholder="e.g. 1234567890"
            globalCredentialKey="asana.token"
          />
        </div>
      </div>
    );
  }

  return (
    <div className="animate-in fade-in slide-in-from-bottom-2 duration-500">
      <div className="mb-8 border-b border-white/10 pb-6">
        <h2 className="font-headline-md text-headline-md text-on-surface mb-2">Global connections</h2>
        <p className="text-on-surface-variant text-sm max-w-2xl">
          Sync your work orders, issues, and projects seamlessly. VibeOps currently supports zero-config syncing from popular version control and issue tracking platforms.
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
