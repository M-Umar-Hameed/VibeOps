import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { estimateTokens } from "../services/usage.js";
import { redactSecrets } from "../forge/redact.js";

export type ContextBudget = number | "unlimited";

export function resolveContextBudget(raw: string | null | undefined): ContextBudget {
  const v = (raw ?? "").trim();
  if (v === "" || v.toLowerCase() === "unlimited") return "unlimited";
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) return "unlimited";
  return n;
}

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "target",
  "build",
  "coverage",
  ".next",
  "__pycache__",
  "vendor",
  ".venv",
]);
const TREE_MAX_LINES = 500;
const MAX_SCAN_FILES = 5000;

export async function listRepoFiles(root: string): Promise<string[]> {
  try {
    const gitFiles = await new Promise<string[] | null>((resolve) => {
      const child = spawn("git", ["ls-files", "-c", "-o", "--exclude-standard"], {
        cwd: root,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "";
      child.stdout?.on("data", (d: Buffer) => {
        stdout += d.toString("utf-8");
      });
      child.on("close", (code) => {
        if (code !== 0) return resolve(null);
        const lines = stdout
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean)
          .map((p) => p.replace(/\\/g, "/"));
        resolve(lines);
      });
      child.on("error", () => resolve(null));
    });

    if (gitFiles !== null) {
      const filtered = gitFiles.filter((p) => {
        const segs = p.split("/");
        return !segs.some((s) => SKIP_DIRS.has(s));
      });
      return filtered.slice(0, MAX_SCAN_FILES);
    }
  } catch {
    // Fallback to manual walk
  }

  const files: string[] = [];
  try {
    function walk(dir: string, rel: string, depth: number) {
      if (depth > 3 || files.length >= MAX_SCAN_FILES) return;
      
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true, encoding: "utf-8" });
      } catch {
        return;
      }
      for (const entry of entries) {
        const name = String(entry.name);
        if (SKIP_DIRS.has(name)) continue;
        const entryRel = rel ? `${rel}/${name}` : name;
        if (entry.isDirectory()) {
          walk(join(dir, name), entryRel, depth + 1);
        } else if (entry.isFile()) {
          files.push(entryRel.replace(/\\/g, "/"));
          if (files.length >= MAX_SCAN_FILES) return;
        }
      }
    }
    walk(root, "", 1);
  } catch {
    return [];
  }
  return files;
}

const EXT_MAP: Record<string, string> = {
  ".ts": "TypeScript",
  ".tsx": "TypeScript",
  ".js": "JavaScript",
  ".jsx": "JavaScript",
  ".mjs": "JavaScript",
  ".cjs": "JavaScript",
  ".py": "Python",
  ".rs": "Rust",
  ".go": "Go",
  ".java": "Java",
  ".rb": "Ruby",
  ".php": "PHP",
  ".cs": "C#",
};

export function detectLanguages(files: string[]): string[] {
  const counts = new Map<string, number>();
  for (const f of files) {
    const dot = f.lastIndexOf(".");
    if (dot !== -1) {
      const ext = f.slice(dot).toLowerCase();
      const lang = EXT_MAP[ext];
      if (lang) {
        counts.set(lang, (counts.get(lang) ?? 0) + 1);
      }
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([lang]) => lang);
}

interface DirNode {
  dirs: Map<string, DirNode>;
  files: Set<string>;
  totalFiles: number;
}

function createDirNode(): DirNode {
  return { dirs: new Map(), files: new Set(), totalFiles: 0 };
}

function buildHierarchy(files: string[]): DirNode {
  const root = createDirNode();
  for (const file of files) {
    const parts = file.split("/");
    let curr = root;
    curr.totalFiles++;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      let next = curr.dirs.get(part);
      if (!next) {
        next = createDirNode();
        curr.dirs.set(part, next);
      }
      next.totalFiles++;
      curr = next;
    }
    curr.files.add(parts[parts.length - 1]);
  }
  return root;
}

export function renderTree(files: string[]): string {
  if (files.length === 0) return "";
  const root = buildHierarchy(files);

  function render(collapseBelowDepth2: boolean): string[] {
    const lines: string[] = [];

    function walk(node: DirNode, depth: number) {
      if (depth > 3) return;
      const sortedDirs = [...node.dirs.keys()].sort((a, b) => a.localeCompare(b));
      const sortedFiles = [...node.files].sort((a, b) => a.localeCompare(b));
      const indent = "  ".repeat(depth - 1);

      for (const dir of sortedDirs) {
        const sub = node.dirs.get(dir)!;
        if (collapseBelowDepth2 && depth >= 2) {
          lines.push(`${indent}${dir}/ (${sub.totalFiles} files)`);
        } else {
          lines.push(`${indent}${dir}/`);
          walk(sub, depth + 1);
        }
      }

      for (const file of sortedFiles) {
        lines.push(`${indent}${file}`);
      }
    }

    walk(root, 1);
    return lines;
  }

  let lines = render(false);
  if (lines.length > TREE_MAX_LINES) {
    lines = render(true);
    if (lines.length > TREE_MAX_LINES) {
      lines = lines.slice(0, TREE_MAX_LINES - 1);
      lines.push("… (tree truncated)");
    }
  }
  return lines.join("\n");
}

function parsePackageJson(content: string): string[] {
  try {
    const data = JSON.parse(content);
    const deps: string[] = [];
    const seen = new Set<string>();
    const add = (obj: any) => {
      if (obj && typeof obj === "object") {
        for (const [name, ver] of Object.entries(obj)) {
          if (!seen.has(name) && typeof ver === "string") {
            seen.add(name);
            deps.push(`${name}@${ver}`);
          }
        }
      }
    };
    add(data.dependencies);
    add(data.devDependencies);
    return deps.slice(0, 100);
  } catch {
    return [];
  }
}

function parseCargoToml(content: string): string[] {
  try {
    const lines = content.split(/\r?\n/);
    const deps: string[] = [];
    const seen = new Set<string>();
    let inDeps = false;
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (line.startsWith("#") || line === "") continue;
      if (line.startsWith("[")) {
        if (!line.endsWith("]")) return [];
        const header = line.toLowerCase();
        inDeps = header === "[dependencies]" || header === "[dev-dependencies]";
        continue;
      }
      if (inDeps) {
        const eqIdx = line.indexOf("=");
        if (eqIdx === -1) return [];
        const name = line.slice(0, eqIdx).trim();
        const val = line.slice(eqIdx + 1).trim();
        if (!name) return [];
        if (!seen.has(name)) {
          seen.add(name);
          const strMatch = val.match(/^["']([^"']+)["']/);
          const verMatch = val.match(/version\s*=\s*["']([^"']+)["']/);
          const version = strMatch ? strMatch[1] : (verMatch ? verMatch[1] : "");
          deps.push(version ? `${name}@${version}` : name);
          if (deps.length >= 100) break;
        }
      }
    }
    return deps;
  } catch {
    return [];
  }
}

function parsePyprojectToml(content: string): string[] {
  try {
    const lines = content.split(/\r?\n/);
    const deps: string[] = [];
    const seen = new Set<string>();
    let inProject = false;
    let inProjectDeps = false;
    let inPoetryDeps = false;

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (line.startsWith("#") || line === "") continue;
      if (line.startsWith("[")) {
        if (!line.endsWith("]")) return [];
        const header = line.toLowerCase();
        inProject = header === "[project]";
        inPoetryDeps = header === "[tool.poetry.dependencies]";
        inProjectDeps = false;
        continue;
      }
      if (inProject) {
        if (line.startsWith("dependencies") && line.includes("=")) {
          inProjectDeps = true;
        }
        if (inProjectDeps) {
          const matches = line.matchAll(/["']([^"']+)["']/g);
          for (const m of matches) {
            const dep = m[1].trim();
            const name = dep.split(/[<>=!~;]/)[0].trim();
            if (name && !seen.has(name)) {
              seen.add(name);
              deps.push(dep);
              if (deps.length >= 100) break;
            }
          }
          if (line.includes("]")) {
            inProjectDeps = false;
          }
        }
      }
      if (inPoetryDeps) {
        const eqIdx = line.indexOf("=");
        if (eqIdx === -1) return [];
        const name = line.slice(0, eqIdx).trim();
        const val = line.slice(eqIdx + 1).trim();
        if (!name) return [];
        if (name !== "python" && !seen.has(name)) {
          seen.add(name);
          const strMatch = val.match(/^["']([^"']+)["']/);
          deps.push(strMatch ? `${name}@${strMatch[1]}` : name);
          if (deps.length >= 100) break;
        }
      }
    }
    if (inProjectDeps) return [];
    return deps;
  } catch {
    return [];
  }
}

function parseGoMod(content: string): string[] {
  try {
    const lines = content.split(/\r?\n/);
    const deps: string[] = [];
    const seen = new Set<string>();
    let inRequireBlock = false;

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (line.startsWith("//") || line === "") continue;

      if (line.startsWith("require (")) {
        inRequireBlock = true;
        continue;
      }
      if (inRequireBlock) {
        if (line === ")") {
          inRequireBlock = false;
          continue;
        }
        const parts = line.split(/\s+/);
        if (parts.length >= 2) {
          const mod = parts[0];
          const ver = parts[1];
          if (mod && !seen.has(mod)) {
            seen.add(mod);
            deps.push(`${mod}@${ver}`);
            if (deps.length >= 100) break;
          }
        }
        continue;
      }
      if (line.startsWith("require ") && !line.startsWith("require (")) {
        const after = line.slice("require ".length).trim();
        const parts = after.split(/\s+/);
        if (parts.length >= 2) {
          const mod = parts[0];
          const ver = parts[1];
          if (mod && !seen.has(mod)) {
            seen.add(mod);
            deps.push(`${mod}@${ver}`);
            if (deps.length >= 100) break;
          }
        } else if (parts.length === 1 && parts[0]) {
          const mod = parts[0];
          if (!seen.has(mod)) {
            seen.add(mod);
            deps.push(mod);
            if (deps.length >= 100) break;
          }
        }
      }
    }
    if (inRequireBlock) return [];
    return deps;
  } catch {
    return [];
  }
}

const FRAMEWORK_PATTERNS: [RegExp, string][] = [
  [/\breact\b/i, "React"],
  [/\bnext(?:\.js)?\b/i, "Next.js"],
  [/\bvue\b/i, "Vue"],
  [/\bsvelte\b/i, "Svelte"],
  [/\bhono\b/i, "Hono"],
  [/\bexpress\b/i, "Express"],
  [/\bfastify\b/i, "Fastify"],
  [/\bdrizzle-orm\b/i, "Drizzle"],
  [/\bfastapi\b/i, "FastAPI"],
  [/\bdjango\b/i, "Django"],
  [/\bflask\b/i, "Flask"],
];

export function detectFrameworks(manifests: { deps: string[] }[]): string[] {
  const found = new Set<string>();
  for (const m of manifests) {
    for (const dep of m.deps) {
      for (const [re, name] of FRAMEWORK_PATTERNS) {
        if (re.test(dep)) {
          found.add(name);
        }
      }
    }
  }
  return [...found];
}

export async function parseManifests(
  root: string,
  files: string[],
): Promise<{ label: string; deps: string[] }[]> {
  const MANIFEST_NAMES = new Set(["package.json", "Cargo.toml", "pyproject.toml", "go.mod"]);
  const candidates: { rel: string; isRoot: boolean; depth: number }[] = [];

  for (const f of files) {
    const parts = f.split("/");
    const filename = parts.at(-1)!;
    if (MANIFEST_NAMES.has(filename)) {
      const dirDepth = parts.length - 1;
      if (dirDepth <= 2) {
        candidates.push({ rel: f, isRoot: dirDepth === 0, depth: dirDepth });
      }
    }
  }

  candidates.sort((a, b) => {
    if (a.isRoot !== b.isRoot) return a.isRoot ? -1 : 1;
    if (a.depth !== b.depth) return a.depth - b.depth;
    return a.rel.localeCompare(b.rel);
  });

  const selected = candidates.slice(0, 5);
  const results: { label: string; deps: string[] }[] = [];

  for (const cand of selected) {
    try {
      const fullPath = join(root, cand.rel);
      const content = readFileSync(fullPath, "utf-8");
      const filename = cand.rel.split("/").at(-1)!;
      let deps: string[] = [];
      if (filename === "package.json") {
        deps = parsePackageJson(content);
      } else if (filename === "Cargo.toml") {
        deps = parseCargoToml(content);
      } else if (filename === "pyproject.toml") {
        deps = parsePyprojectToml(content);
      } else if (filename === "go.mod") {
        deps = parseGoMod(content);
      }
      if (deps.length > 0) {
        results.push({ label: cand.rel, deps });
      }
    } catch {
      // ignore
    }
  }

  return results;
}

export async function buildRepoBriefing(
  root: string,
  budget: ContextBudget,
  code?: { content: string; citation?: string; sourceRef?: string }[],
): Promise<string> {
  try {
    if (budget === 0) return "";

    const files = await listRepoFiles(root);
    if (files.length === 0 && (!code || code.length === 0)) {
      return "";
    }

    const languages = detectLanguages(files);
    const manifests = await parseManifests(root, files);
    const frameworks = detectFrameworks(manifests);

    // Section 1: Project Identity
    const idLines: string[] = [
      `- Primary Languages: ${languages.join(", ") || "None detected"}`,
    ];
    if (frameworks.length > 0) {
      idLines.push(`- Frameworks: ${frameworks.join(", ")}`);
    }
    const secIdentity = `## Project Identity\n${idLines.join("\n")}`;

    // Section 2: Declared Dependencies
    let secDeps = "";
    if (manifests.length > 0) {
      const manifestBlocks = manifests.map(
        (m) => `### ${m.label}\n\`\`\`\n${m.deps.join("\n")}\n\`\`\``,
      );
      secDeps = `## Declared Dependencies\n${manifestBlocks.join("\n\n")}`;
    }

    // Section 3: Directory Layout
    let secTree = "";
    const tree = renderTree(files);
    if (tree) {
      secTree = `## Directory Layout\n\`\`\`\n${tree}\n\`\`\``;
    }

    // Section 4: Key Documentation
    let secDocs = "";
    const docCandidates = ["README.md", "CONTRIBUTING.md", "ARCHITECTURE.md"];
    const foundDocs: { name: string; content: string }[] = [];
    for (const docName of docCandidates) {
      const match = files.find(
        (f) => !f.includes("/") && f.toLowerCase() === docName.toLowerCase(),
      );
      if (match) {
        try {
          const docContent = readFileSync(join(root, match), "utf-8").slice(0, 4000);
          foundDocs.push({ name: match, content: docContent });
        } catch {
          // ignore
        }
      }
    }
    if (foundDocs.length > 0) {
      const docBlocks = foundDocs.map((d) => `### ${d.name}\n${d.content}`);
      secDocs = `## Key Documentation\n${docBlocks.join("\n\n")}`;
    }

    // Section 5: Relevant Code Sections
    let secCode = "";
    if (code && code.length > 0) {
      const codeBlocks = code.map(
        (c) => `### ${c.citation ?? c.sourceRef ?? "Code Snippet"}\n${c.content}`,
      );
      secCode = `## Relevant Code Sections\n${codeBlocks.join("\n\n")}`;
    }

    const assemble = (sections: string[]) => {
      const body = sections.filter(Boolean).join("\n\n");
      return body ? `# Repository Briefing\n${body}` : "";
    };

    if (budget === "unlimited") {
      const full = assemble([secIdentity, secDeps, secTree, secDocs, secCode]);
      return redactSecrets(full.trim());
    }

    // Budget enforcement
    const prioritySections = [
      { id: 1, text: secIdentity },
      { id: 2, text: secDeps },
      { id: 3, text: secTree },
      { id: 4, text: secDocs },
      { id: 5, text: secCode },
    ];

    let active = prioritySections.filter((s) => Boolean(s.text));
    let assembled = assemble(active.map((s) => s.text));

    while (active.length > 2 && estimateTokens(assembled.length) > budget) {
      active.pop();
      assembled = assemble(active.map((s) => s.text));
    }

    if (estimateTokens(assembled.length) > budget) {
      const maxChars = budget * 4;
      const suffix = "\n… (briefing truncated to fit the configured token budget)";
      if (assembled.length > maxChars) {
        assembled = assembled.slice(0, Math.max(0, maxChars - suffix.length)) + suffix;
      }
    }

    return redactSecrets(assembled.trim());
  } catch {
    return "";
  }
}