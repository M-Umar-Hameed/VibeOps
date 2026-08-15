import { homedir } from "node:os";
import { join } from "node:path";

// Single override point for the ~/.vibeops base. Defaults to homedir() when
// VIBEOPS_HOME is unset, so nothing changes for normal users.
export function vibeopsHome(): string {
  return process.env.VIBEOPS_HOME ?? homedir();
}

// Embedded data dir. Under the serial embedded TEST lane (VITEST set) the dir
// MUST be a throwaway VIBEOPS_HOME: the desktop sidecar holds ~/.vibeops/data
// open and a second opener corrupts it (four incidents). Fail loudly rather
// than fall back to the real home.
export function resolveEmbeddedDataDir(): string {
  if (process.env.VITEST && !process.env.VIBEOPS_HOME) {
    throw new Error(
      "embedded test lane requires VIBEOPS_HOME to point at a throwaway dir; " +
      "refusing to open ~/.vibeops/data (the sidecar holds it open).",
    );
  }
  return join(vibeopsHome(), ".vibeops", "data");
}
