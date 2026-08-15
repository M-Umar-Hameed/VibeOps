import { useQueryClient } from "@tanstack/react-query";
import type { Project } from "../../api/types.js";
import { api } from "../../lib/api.js";
import { useProject } from "../../context/project.js";
import { openRepoFolder } from "../../lib/native-dialog.js";
import { ContextMenu, type MenuItemSpec } from "../ContextMenu.js";

// Thin adapter over the shared ContextMenu: this file only knows which project
// actions exist; menu chrome, positioning, portal, confirm and notice handling
// all live in one place.
export function ProjectContextMenu({ project, x, y, onClose }: {
  project: Project; x: number; y: number; onClose: () => void;
}) {
  const { setActiveProject, refreshProjects } = useProject();
  const queryClient = useQueryClient();

  const items: MenuItemSpec[] = [
    {
      key: "set-active", label: "Set as active",
      onSelect: () => { setActiveProject(project.id); },
    },
    {
      key: "index", label: "Index docs",
      disabled: !project.repoPath, disabledReason: !project.repoPath ? "no repo folder configured" : undefined,
      onSelect: async () => {
        const r: any = await api.post(`/projects/${project.id}/index-repo`);
        return `indexed ${r.indexed}, skipped ${r.skipped}, removed ${r.removed}`;
      },
    },
    {
      key: "open-folder", label: "Open repo folder",
      disabled: !project.repoPath, disabledReason: !project.repoPath ? "no repo folder configured" : undefined,
      onSelect: () => { if (project.repoPath) void openRepoFolder(project.repoPath); },
    },
    {
      key: "clear", label: "Clear knowledge", danger: true,
      confirm: {
        title: "Clear knowledge",
        message: `Clear knowledge for "${project.name}"? Removes all indexed chunks so the project can be re-indexed. Tickets and notes are kept.`,
        confirmLabel: "Clear",
      },
      onSelect: async () => {
        const r: any = await api.del(`/projects/${project.id}/knowledge`);
        return `removed ${r.removed} chunk(s)`;
      },
    },
    {
      key: "delete", label: "Delete project", danger: true,
      confirm: {
        title: "Delete project",
        message: `Delete "${project.name}"? Removes the project and all its tickets, comments, notes, and indexed knowledge from VibeOps. Files on disk are NOT touched.`,
        confirmLabel: "Delete",
      },
      onSelect: async () => {
        await api.del(`/projects/${project.id}`);
        await refreshProjects();
        queryClient.invalidateQueries({ queryKey: ["projects"] });
      },
    },
  ];

  return <ContextMenu items={items} x={x} y={y} label={`Actions for ${project.name}`} onClose={onClose} />;
}
