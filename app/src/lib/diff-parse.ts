export type DiffRow = { left: number | null; right: number | null; type: "add" | "del" | "ctx" | "binary"; text: string };
export type DiffHunk = { header: string; rows: DiffRow[] };
export type DiffFile = { path: string; additions: number; deletions: number; binary?: boolean; hunks: DiffHunk[] };

export function parseUnifiedDiff(text: string): { files: DiffFile[] } {
  const lines = text.split(/\r?\n/);
  const files: DiffFile[] = [];
  let currentFile: DiffFile | null = null;
  let currentHunk: DiffHunk | null = null;
  let leftLine = 0;
  let rightLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith("diff --git")) {
      const parts = line.split(" ");
      let path = parts[parts.length - 1];
      if (path.startsWith("b/")) path = path.slice(2);
      
      currentFile = { path, additions: 0, deletions: 0, hunks: [] };
      files.push(currentFile);
      currentHunk = null;
      continue;
    }

    if (!currentFile) continue;

    if (line.startsWith("Binary files")) {
      currentFile.binary = true;
      continue;
    }

    if (line.startsWith("--- ") || line.startsWith("+++ ")) continue;

    if (line.startsWith("@@ ")) {
      // @@ -leftStart,leftCount +rightStart,rightCount @@
      const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (match) {
        leftLine = parseInt(match[1], 10);
        rightLine = parseInt(match[2], 10);
      }
      currentHunk = { header: line, rows: [] };
      currentFile.hunks.push(currentHunk);
      continue;
    }

    if (!currentHunk && !currentFile.binary) continue;

    if (line.startsWith("+")) {
      currentFile.additions++;
      if (currentHunk) {
        currentHunk.rows.push({ left: null, right: rightLine++, type: "add", text: line.slice(1) });
      }
    } else if (line.startsWith("-")) {
      currentFile.deletions++;
      if (currentHunk) {
        currentHunk.rows.push({ left: leftLine++, right: null, type: "del", text: line.slice(1) });
      }
    } else if (line.startsWith(" ")) {
      if (currentHunk) {
        currentHunk.rows.push({ left: leftLine++, right: rightLine++, type: "ctx", text: line.slice(1) });
      }
    } else if (line === "") {
      // blank context line
      if (currentHunk) {
        currentHunk.rows.push({ left: leftLine++, right: rightLine++, type: "ctx", text: "" });
      }
    }
  }

  return { files };
}
