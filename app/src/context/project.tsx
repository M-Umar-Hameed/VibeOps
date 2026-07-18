import { createContext, useContext, useState, useEffect, type ReactNode } from "react";
import { load } from "@tauri-apps/plugin-store";
import { projects as projectsApi } from "../api/projects.js";
import type { Project } from "../api/types.js";

interface ProjectContextValue {
  projects: Project[];
  activeProjectId: string | null;
  setActiveProject: (id: string | null) => void;
  refreshProjects: () => Promise<void>;
}

const ProjectContext = createContext<ProjectContextValue | undefined>(undefined);

export function ProjectProvider({ children }: { children: ReactNode }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectIdState] = useState<string | null>(null);

  const fetchAndValidate = async () => {
    try {
      const list = await projectsApi.list();
      const validProjects = Array.isArray(list) ? list : [];
      setProjects(validProjects);

      let persistedId: string | null = null;
      try {
        const store = await load("settings.json", { autoSave: false, defaults: {} });
        persistedId = await store.get<string>("activeProjectId") ?? null;
      } catch {
        // best effort
      }

      // Check current state or persisted against the fresh list
      setActiveProjectIdState((current) => {
        const targetId = current ?? persistedId;
        if (targetId && validProjects.some((p) => p.id === targetId)) {
          return targetId;
        }
        return null;
      });
    } catch (err) {
      console.error("Failed to fetch projects", err);
      setProjects([]);
      setActiveProjectIdState(null);
    }
  };

  useEffect(() => {
    fetchAndValidate();
  }, []);

  const setActiveProject = (id: string | null) => {
    setActiveProjectIdState(id);
    // Best-effort async write
    (async () => {
      try {
        const store = await load("settings.json", { autoSave: false, defaults: {} });
        if (id === null) {
          await store.delete("activeProjectId");
        } else {
          await store.set("activeProjectId", id);
        }
        await store.save();
      } catch {
        // ignore
      }
    })();
  };

  const refreshProjects = async () => {
    await fetchAndValidate();
  };

  return (
    <ProjectContext.Provider value={{ projects, activeProjectId, setActiveProject, refreshProjects }}>
      {children}
    </ProjectContext.Provider>
  );
}

// Safe defaults outside the provider (tests render screens bare; a screen
// without the provider just behaves as "All projects").
const FALLBACK: ProjectContextValue = {
  projects: [],
  activeProjectId: null,
  setActiveProject: () => {},
  refreshProjects: async () => {},
};

export function useProject() {
  return useContext(ProjectContext) ?? FALLBACK;
}
