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

describe("child_process audit", () => {
  it("never uses shell: true or exec/execSync", () => {
    const files = getAllFiles(srcDir);
    for (const file of files) {
      const content = readFileSync(file, "utf-8");
      if (content.includes("node:child_process")) {
        expect(content).not.toMatch(/shell:\s*true/);
        expect(content).not.toMatch(/\bexec\(/);
        expect(content).not.toMatch(/\bexecSync\(/);
      }
    }
  });
});
