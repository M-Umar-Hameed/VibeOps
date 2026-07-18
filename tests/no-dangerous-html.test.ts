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

describe("dangerouslySetInnerHTML audit", () => {
  it("never uses dangerouslySetInnerHTML", () => {
    const files = getAllFiles(appSrcDir);
    let checked = 0;
    for (const file of files) {
      const content = readFileSync(file, "utf-8");
      expect(content).not.toContain("dangerouslySetInnerHTML");
      checked++;
    }
    // We expect there are actually files in app/src
    expect(checked).toBeGreaterThan(0);
  });
});
