import { homedir } from "node:os";
import { join } from "node:path";
import { getProjectSettings } from "../services/projects.js";

// Default per-project vault lives beside the legacy global vault, keyed by id.
export function defaultProjectVaultPath(projectId: string, homeDir = homedir()): string {
  return join(homeDir, ".vibeops", "vaults", projectId);
}

// Override lives in project_settings key "vault.path"; else the default.
export async function resolveProjectVaultPath(projectId: string, homeDir = homedir()): Promise<string> {
  const s = await getProjectSettings(projectId);
  return s["vault.path"] || defaultProjectVaultPath(projectId, homeDir);
}
