import { existsSync } from "node:fs";
import { checkCommand, type Dialect, type LiftHit } from "./firewall.js";

export type RiskHit = { id: string; reason: string };

type Rule = {
  id: string;
  reason: string;
  globs: string[] | ((drives: readonly string[]) => string[]);
};

const RM_FLAGS = ["-r", "-R", "-rf", "-fr", "-Rf"];
const RM_TARGETS = ["/", "~", "..", "$HOME"];
const driveCases = (drives: readonly string[]) => drives.flatMap((d) => [d.toUpperCase(), d.toLowerCase()]);

export function existingDrives(): string[] {
  if (process.platform !== "win32") return [];
  return Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i) + ":").filter((d) => existsSync(d + "\\"));
}

const RULES: Rule[] = [
  { id: "git-push", reason: "git push publishes commits outside the sandbox", globs: ["git push*", "git -C * push*"] },
  { id: "git-remote", reason: "changing git remotes can redirect pushes", globs: ["git remote add*", "git remote set-url*"] },
  { id: "git-reset-origin", reason: "git reset --hard to origin discards local work", globs: ["git reset --hard origin*"] },
  {
    id: "rm-outside",
    reason: "recursive rm outside the sandbox workdir (or on it)",
    globs: (drives) => RM_FLAGS.flatMap((f) => [...RM_TARGETS, ...driveCases(drives)].map((t) => `rm ${f} ${t}*`)),
  },
  {
    id: "find-delete-outside",
    reason: "find -delete outside the sandbox workdir",
    globs: (drives) => ["/", "~", "..", ...driveCases(drives)].map((t) => `find ${t}* -delete*`),
  },
  { id: "curl-pipe", reason: "piping a download into a shell runs unreviewed code", globs: ["curl *| sh*", "curl *| bash*", "wget *| sh*", "wget *| bash*"] },
  { id: "npm-publish", reason: "npm publish releases a package", globs: ["npm publish*"] },
  { id: "npm-deploy", reason: "npm deploy/publish/release scripts ship the project", globs: ["npm run deploy*", "npm run publish*", "npm run release*"] },
  { id: "vercel", reason: "vercel deploys or changes hosted projects", globs: ["vercel*", "npx vercel*"] },
  { id: "gh-write", reason: "gh pr/issue/release/repo writes to GitHub", globs: ["gh pr*", "gh issue*", "gh release*", "gh repo*"] },
  { id: "ssh", reason: "ssh/scp reach other machines", globs: ["ssh *", "scp *"] },
  { id: "docker-push", reason: "docker push publishes an image", globs: ["docker push*"] },
  { id: "dd", reason: "dd with of= can overwrite devices or files", globs: ["dd *of=*"] },
];

export const RISK_IDS: readonly string[] = RULES.map((r) => r.id);

const CURL_PIPE = /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(sh|bash|zsh|pwsh|powershell)\b/;
const GH_WRITE = new Set(["pr", "issue", "release", "repo"]);

// Maps a firewall deny back to the legacy ALLOW-COMMAND id; undefined = never liftable.
function legacyId(h: LiftHit, cmd: string): string | undefined {
  const { rule, reason, name, args } = h;
  const sub = args.find((x) => x[0] !== "-");
  switch (rule) {
    case "git-remote": return "git-remote";
    case "git-destructive":
      if (reason.startsWith("git push:")) return "git-push";
      if (reason.startsWith("git reset:") && args.includes("--hard") && args.some((x) => x[0] !== "-" && x !== "reset" && x.includes("origin"))) return "git-reset-origin";
      return undefined;
    case "delete-outside": return "rm-outside";
    case "find-delete": return "find-delete-outside";
    case "system": return name === "dd" ? "dd" : undefined;
    case "egress-remote-shell": return name === "ssh" || name === "scp" ? "ssh" : undefined;
    // ponytail: firewall has no curl-pipe rule; lift curl/wget egress + pipe-to-shell only when the legacy CURL_PIPE regex matches the whole command
    case "egress": return (name === "curl" || name === "wget") && CURL_PIPE.test(cmd) ? "curl-pipe" : undefined;
    case "pipe-to-shell": return CURL_PIPE.test(cmd) ? "curl-pipe" : undefined;
    case "publish-deploy":
      if (name === "docker") return "docker-push";
      if (name === "vercel") return "vercel";
      if (name === "gh") return sub !== undefined && GH_WRITE.has(sub) ? "gh-write" : undefined;
      if (name === "npm") return sub === "run" || sub === "run-script" ? "npm-deploy" : "npm-publish";
      return undefined;
  }
  return undefined;
}

export function commandRisk(cmd: string, workdir: string, lifted: readonly string[] = [], dialect: Dialect = "posix"): RiskHit | null {
  const skip = new Set(lifted);
  let last: LiftHit | undefined;
  try {
    const v = checkCommand(cmd, {
      workspace: workdir, dialect,
      lift: (h) => {
        const id = legacyId(h, cmd);
        if (id !== undefined && skip.has(id)) return true;
        last = h;
        return false;
      },
    });
    if (v.allow) return null;
    const h = last && last.rule === v.rule && last.reason === v.reason ? last : { rule: v.rule, reason: v.reason, name: "", args: [] };
    return { id: legacyId(h, cmd) ?? v.rule, reason: v.reason };
  } catch {
    return { id: "internal-error", reason: "command firewall failed; denied" };
  }
}

export function denyPatterns(lifted: readonly string[] = [], drives: readonly string[] = existingDrives()): string[] {
  const skip = new Set(lifted);
  return RULES.filter((r) => !skip.has(r.id)).flatMap((r) => (typeof r.globs === "function" ? r.globs(drives) : r.globs).flatMap((g) => [`Bash(${g})`, `PowerShell(${g})`]));
}

const AGY: Record<string, string[]> = {
  "git-push": ["git push"],
  "git-remote": ["git remote add", "git remote set-url"],
  "git-reset-origin": ["regex:git reset --hard origin.*"],
  "rm-outside": ["regex:rm -[a-zA-Z]*[rR][a-zA-Z]* (/|~|\\.\\.|\\$HOME|[A-Za-z]:).*"],
  "npm-publish": ["npm publish"],
  "npm-deploy": ["npm run deploy", "npm run publish", "npm run release"],
  vercel: ["vercel", "npx vercel"],
  "gh-write": ["gh pr", "gh issue", "gh release", "gh repo"],
  ssh: ["ssh", "scp"],
  "docker-push": ["docker push"],
  dd: ["dd"],
};

export function agyPatterns(lifted: readonly string[] = []): string[] {
  const skip = new Set(lifted);
  return Object.entries(AGY).filter(([id]) => !skip.has(id)).flatMap(([, ps]) => ps.map((p) => `command(${p})`));
}
