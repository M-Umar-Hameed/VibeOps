import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type RiskHit = { id: string; reason: string };

type Rule = {
  id: string;
  reason: string;
  globs: string[] | ((drives: readonly string[]) => string[]);
  test: (seg: string, cwd: string, workdir: string) => boolean;
};

const lc = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);

function expand(t: string): string {
  const m = /^(~|\$HOME)(?=$|[\\/])/.exec(t);
  return m ? os.homedir() + t.slice(m[0].length) : t;
}

function strictlyInside(target: string, workdir: string): boolean {
  const root = lc(path.resolve(workdir)).replace(/[\\/]+$/, "") + path.sep;
  return lc(target).startsWith(root);
}

function sameDir(target: string, workdir: string): boolean {
  const trim = (p: string) => lc(p).replace(/[\/]+$/, "");
  return trim(target) === trim(path.resolve(workdir));
}

const resolveTarget = (t: string, cwd: string) => path.resolve(cwd, expand(t));
const tokens = (seg: string) => seg.split(/\s+/).map((t) => t.replace(/^["']|["']$/g, "")).filter(Boolean);

const RM_FLAGS = ["-r", "-R", "-rf", "-fr", "-Rf"];
const RM_TARGETS = ["/", "~", "..", "$HOME"];
const PS_RM = new Set(["remove-item", "ri", "rd", "rmdir", "del"]);
const driveCases = (drives: readonly string[]) => drives.flatMap((d) => [d.toUpperCase(), d.toLowerCase()]);

export function existingDrives(): string[] {
  if (process.platform !== "win32") return [];
  return Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i) + ":").filter((d) => existsSync(d + "\\"));
}

const RULES: Rule[] = [
  { id: "git-push", reason: "git push publishes commits outside the sandbox", globs: ["git push*", "git -C * push*"], test: (s) => /^git\s+(?:-[cC]\s+\S+\s+)*push\b/.test(s) },
  { id: "git-remote", reason: "changing git remotes can redirect pushes", globs: ["git remote add*", "git remote set-url*"], test: (s) => /^git\s+remote\s+(add|set-url)\b/.test(s) },
  { id: "git-reset-origin", reason: "git reset --hard to origin discards local work", globs: ["git reset --hard origin*"], test: (s) => /^git\s+reset\s+--hard\s+\S*origin/.test(s) },
  {
    id: "rm-outside",
    reason: "recursive rm outside the sandbox workdir (or on it)",
    globs: (drives) => RM_FLAGS.flatMap((f) => [...RM_TARGETS, ...driveCases(drives)].map((t) => `rm ${f} ${t}*`)),
    test: (s, cwd, wd) => {
      const t = tokens(s);
      const cmd = (t[0] ?? "").toLowerCase();
      const ps = PS_RM.has(cmd);
      if (cmd !== "rm" && !ps) return false;
      const args = t.slice(1);
      const slashS = cmd !== "ri" && cmd !== "remove-item";
      const recurse = ps
        ? (a: string) => /^-r(ecurse)?$/i.test(a) || (slashS && /^\/s$/i.test(a))
        : (a: string) => /^-[a-zA-Z]*[rR]/.test(a) || a === "--recursive";
      if (!args.some(recurse)) return false;
      return args.filter((a) => !a.startsWith("-") && !(ps && /^\/[a-z]$/i.test(a))).some((a) => !strictlyInside(resolveTarget(a, cwd), wd));
    },
  },
  {
    id: "find-delete-outside",
    reason: "find -delete outside the sandbox workdir",
    globs: (drives) => ["/", "~", "..", ...driveCases(drives)].map((t) => `find ${t}* -delete*`),
    test: (s, cwd, wd) => {
      const t = tokens(s);
      if (t[0] !== "find" || !t.includes("-delete")) return false;
      const paths: string[] = [];
      for (const a of t.slice(1)) {
        if (/^[-(!]/.test(a)) break;
        paths.push(a);
      }
      return paths.some((a) => {
        const abs = resolveTarget(a, cwd);
        return !strictlyInside(abs, wd) && !sameDir(abs, wd);
      });
    },
  },
  { id: "curl-pipe", reason: "piping a download into a shell runs unreviewed code", globs: ["curl *| sh*", "curl *| bash*", "wget *| sh*", "wget *| bash*"], test: () => false },
  { id: "npm-publish", reason: "npm publish releases a package", globs: ["npm publish*"], test: (s) => /^npm\s+publish\b/.test(s) },
  { id: "npm-deploy", reason: "npm deploy/publish/release scripts ship the project", globs: ["npm run deploy*", "npm run publish*", "npm run release*"], test: (s) => /^npm\s+run\s+(deploy|publish|release)\b/.test(s) },
  { id: "vercel", reason: "vercel deploys or changes hosted projects", globs: ["vercel*", "npx vercel*"], test: (s) => /^(npx\s+)?vercel\b/.test(s) },
  { id: "gh-write", reason: "gh pr/issue/release/repo writes to GitHub", globs: ["gh pr*", "gh issue*", "gh release*", "gh repo*"], test: (s) => /^gh\s+(pr|issue|release|repo)\b/.test(s) },
  { id: "ssh", reason: "ssh/scp reach other machines", globs: ["ssh *", "scp *"], test: (s) => /^(ssh|scp)(?=\s|$)/.test(s) },
  { id: "docker-push", reason: "docker push publishes an image", globs: ["docker push*"], test: (s) => /^docker\s+push\b/.test(s) },
  { id: "dd", reason: "dd with of= can overwrite devices or files", globs: ["dd *of=*"], test: (s) => /^dd\s.*\bof=/.test(s) },
];

export const RISK_IDS: readonly string[] = RULES.map((r) => r.id);

const CURL_PIPE = /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(sh|bash|zsh|pwsh|powershell)\b/;
const WRAPPERS = /^(\w+=\S*|sudo|env|timeout\s+\d+\S*|nice(\s+-n\s+\d+)?)(\s+|$)/;

// ponytail: regex over command segments, not a shell parser; $(...), sh -c, and quoted
// separators can evade or over-trigger it. Upgrade path: a real shell tokenizer.
export function commandRisk(cmd: string, workdir: string, lifted: readonly string[] = []): RiskHit | null {
  const skip = new Set(lifted);
  const hit = (r: Rule): RiskHit => ({ id: r.id, reason: r.reason });
  const curl = RULES.find((r) => r.id === "curl-pipe")!;
  if (!skip.has(curl.id) && CURL_PIPE.test(cmd)) return hit(curl);
  let cwd = workdir;
  for (const raw of cmd.split(/&&|\|\||[;|&(){}]|\r?\n/)) {
    let seg = raw.trim();
    for (let m = WRAPPERS.exec(seg); m; m = WRAPPERS.exec(seg)) seg = seg.slice(m[0].length);
    const cd = /^cd\s+(.+)$/.exec(seg);
    if (cd) {
      cwd = resolveTarget(cd[1].trim().replace(/^["']|["']$/g, ""), cwd);
      continue;
    }
    for (const r of RULES) if (!skip.has(r.id) && r.test(seg, cwd, workdir)) return hit(r);
  }
  return null;
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
