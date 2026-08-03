import { homedir } from "node:os";

// Single override point for the ~/.vibeops base. Defaults to homedir() when
// VIBEOPS_HOME is unset, so nothing changes for normal users.
export function vibeopsHome(): string {
  return process.env.VIBEOPS_HOME ?? homedir();
}
