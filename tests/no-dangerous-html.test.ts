import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const appSrcDir = join(fileURLToPath(import.meta.url), "../../app/src");

function getAllFiles(dirPath: string, arrayOfFiles: string[] = []) {
  if (!existsSync(dirPath)) return arrayOfFiles;
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

function loadAppFiles(): SrcFile[] {
  return getAllFiles(appSrcDir).map((path) => ({
    rel: path.slice(appSrcDir.length + 1).replace(/\\/g, "/"),
    content: readFileSync(path, "utf-8"),
  }));
}

// Strip block and line comments so a mention of the API in prose is safe, while
// a real dangerouslySetInnerHTML={...} usage in code still fails.
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

function findDangerous(files: SrcFile[]): string[] {
  return files
    .filter((f) => stripComments(f.content).includes("dangerouslySetInnerHTML"))
    .map((f) => f.rel);
}

describe("dangerouslySetInnerHTML audit", () => {
  it("never uses dangerouslySetInnerHTML in app source", () => {
    const files = loadAppFiles();
    expect(files.length).toBeGreaterThan(0);
    expect(findDangerous(files)).toEqual([]);
  });

  it("still catches a real usage but ignores comment mentions", () => {
    expect(
      findDangerous([
        { rel: "real.tsx", content: '<div dangerouslySetInnerHTML={{ __html: h }} />' },
      ]),
    ).toEqual(["real.tsx"]);
    expect(
      findDangerous([
        { rel: "line.tsx", content: "// discusses dangerouslySetInnerHTML in prose" },
        { rel: "block.tsx", content: "/* note: dangerouslySetInnerHTML avoided */" },
      ]),
    ).toEqual([]);
  });
});
