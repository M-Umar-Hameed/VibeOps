import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const srcDir = join(fileURLToPath(import.meta.url), "../../src");

function getAllFiles(dirPath: string, arrayOfFiles: string[] = []) {
  const files = readdirSync(dirPath, { withFileTypes: true });

  for (const file of files) {
    if (file.isDirectory()) {
      arrayOfFiles = getAllFiles(join(dirPath, file.name), arrayOfFiles);
    } else if (file.name.endsWith(".ts") || file.name.endsWith(".tsx")) {
      arrayOfFiles.push(join(dirPath, file.name));
    }
  }

  return arrayOfFiles;
}

type SrcFile = { rel: string; content: string };

function loadSrcFiles(): SrcFile[] {
  return getAllFiles(srcDir).map((path) => ({
    rel: path.slice(srcDir.length + 1).replace(/\\/g, "/"),
    content: readFileSync(path, "utf-8"),
  }));
}

// Strip block and line comments so prose that mentions a banned pattern does
// not trip the audit; real code usages remain.
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

const PATTERNS = [
  { name: "shell:true", re: /shell:\s*true/g },
  { name: "exec(", re: /\bexec\(/g },
  { name: "execSync(", re: /\bexecSync\(/g },
];

// Reviewed, intentional child_process occurrences. The audit still fails for
// any occurrence not listed here (new file, or an extra occurrence in a listed
// file). One entry allows exactly one occurrence.
const ALLOWED: { file: string; pattern: string; reason: string }[] = [
  {
    file: "forge/checks.ts",
    pattern: "shell:true",
    reason: "check commands are operator-authored strings; shell needed to run them",
  },
];

function findViolations(files: SrcFile[]): string[] {
  const out: string[] = [];
  for (const f of files) {
    if (!f.content.includes("node:child_process")) continue;
    const code = stripComments(f.content);
    for (const p of PATTERNS) {
      const count = (code.match(p.re) ?? []).length;
      const allowed = ALLOWED.filter(
        (a) => a.file === f.rel && a.pattern === p.name,
      ).length;
      if (count > allowed) out.push(`${f.rel}: ${p.name} x${count} (allowed ${allowed})`);
    }
  }
  return out;
}

describe("child_process audit", () => {
  it("has no unreviewed shell:true / exec / execSync usage", () => {
    expect(findViolations(loadSrcFiles())).toEqual([]);
  });

  it("still catches a genuine violation", () => {
    const evil: SrcFile[] = [
      { rel: "fake/evil.ts", content: 'import "node:child_process";\nexec("rm -rf /");' },
    ];
    expect(findViolations(evil)).not.toEqual([]);
  });

  it("still catches an extra occurrence in an allowlisted file", () => {
    const doubled: SrcFile[] = [
      {
        rel: "forge/checks.ts",
        content: 'import "node:child_process";\nspawn(a, { shell: true });\nspawn(b, { shell: true });',
      },
    ];
    expect(findViolations(doubled)).not.toEqual([]);
  });
});
