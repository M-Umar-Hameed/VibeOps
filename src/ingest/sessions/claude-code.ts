import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileHashBytes } from "../../services/knowledge.js";
import type { SessionSource, SessionDoc } from "./source.js";

function extractText(raw: string): string {
  const out: string[] = [];
  for (const line of raw.split("\n")) {
    let d: any;
    try { d = JSON.parse(line); } catch { continue; }
    if (d?.type !== "user" && d?.type !== "assistant") continue;
    const content = d.message?.content;
    if (typeof content === "string") { if (content.trim()) out.push(content.trim()); continue; }
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (typeof block === "string") { if (block.trim()) out.push(block.trim()); continue; }
      if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) out.push(block.text.trim());
    }
  }
  return out.join("\n\n");
}

export function makeClaudeCodeSource(
  projectsDir = join(homedir(), ".claude", "projects"),
): SessionSource {
  return {
    source: "claude-code",
    async listSessionDocs(sinceDays: number): Promise<SessionDoc[]> {
      if (!existsSync(projectsDir)) return [];
      const cutoff = Date.now() - sinceDays * 24 * 3600 * 1000;
      const docs: SessionDoc[] = [];
      for (const proj of readdirSync(projectsDir)) {
        const pdir = join(projectsDir, proj);
        let entries: string[];
        try { if (!statSync(pdir).isDirectory()) continue; entries = readdirSync(pdir); } catch { continue; }
        for (const name of entries) {
          if (!name.endsWith(".jsonl")) continue;
          const path = join(pdir, name);
          try {
            if (statSync(path).mtimeMs < cutoff) continue;
            const buf = readFileSync(path);
            const text = extractText(buf.toString("utf8"));
            if (!text) continue;
            docs.push({ ref: path, text, hash: fileHashBytes(buf) });
          } catch (e) {
            console.warn(`transcript skipped ${path}: ${(e as Error).message}`);
          }
        }
      }
      return docs;
    },
  };
}
