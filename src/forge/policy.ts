// Deterministic protected-path policy for the forge pipeline. Agents have been
// observed editing harness/config/audit files to force a red gate green; this
// gate is evaluated on the DIFF, never the agent's self-report.

export const DEFAULT_PROTECTED_GLOBS: string[] = [
  "vitest.config.*", "jest.config.*", "tests/global-setup.*", "tests/setup.*", "playwright.config.*",
  ".github/**",
  "tsconfig*.json", "package.json", "package-lock.json", "*.lock",
  "tests/*audit*.test.ts", "tests/no-dangerous-html.test.ts",
];

// forge.protectedPaths setting (JSON string array) wins, incl. [] to disable;
// unset or malformed falls back to the defaults with a warning (never crashes).
export function resolveProtectedPaths(setting: string | null): string[] {
  if (setting !== null) {
    try {
      const parsed: unknown = JSON.parse(setting);
      if (Array.isArray(parsed) && parsed.every((g) => typeof g === "string")) return parsed;
      console.warn("forge.protectedPaths: not a string array; using defaults");
    } catch {
      console.warn("forge.protectedPaths: invalid JSON; using defaults");
    }
  }
  return DEFAULT_PROTECTED_GLOBS;
}

// ALLOW-PROTECTED: <glob>, <glob> lines in the ticket body waive specific globs.
export function parseAllowProtected(body: string): string[] {
  const globs: string[] = [];
  for (const m of body.matchAll(/^\s*ALLOW-PROTECTED:\s*(.+)$/gim)) {
    for (const g of m[1].split(",")) {
      const t = g.trim();
      if (t) globs.push(t);
    }
  }
  return globs;
}

// Minimatch-style, full-path anchored. * and ? do not cross "/"; ** does.
function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") { re += ".*"; i++; }
      else re += "[^/]*";
    } else if (c === "?") {
      re += "[^/]";
    } else if (".+^${}()|[]\\".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

function matchAny(path: string, globs: string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(path));
}

// Offending paths: matched a protected glob AND not waived by an allow glob.
export function evaluateProtectedPaths(
  changedPaths: string[], protectedGlobs: string[], allowGlobs: string[],
): string[] {
  return changedPaths.filter((p) => matchAny(p, protectedGlobs) && !matchAny(p, allowGlobs));
}
