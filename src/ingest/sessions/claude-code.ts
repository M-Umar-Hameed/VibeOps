import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readIndexTail } from "./tail.js";
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
      // Bare-string array elements: no current format emits these; kept defensively.
      // Do NOT extend this to structured blocks — only {type:"text"} may pass below.
      if (typeof block === "string") { if (block.trim()) out.push(block.trim()); continue; }
      if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) out.push(block.text.trim());
    }
  }
  return out.join("\n\n");
}

// A session Claude Code ran against a local model through a proxy (e.g. qwen via Ollama)
// records that model's id; its guesses and dead ends must not become retrievable knowledge.
export function isLocalModelTranscript(raw: string): boolean {
  for (const line of raw.split("\n")) {
    if (!line.includes('"assistant"')) continue;
    let d: any;
    try { d = JSON.parse(line); } catch { continue; }
    const model = d?.type === "assistant" ? d.message?.model : undefined;
    if (typeof model === "string" && !/^(claude-|<synthetic>)/.test(model)) return true;
  }
  return false;
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
            const t = readIndexTail(path);
            if (!t || isLocalModelTranscript(t.text)) continue;
            let text = extractText(t.text);
            if (!text) continue;
            // ponytail: cap to the most recent 200k chars per session — full multi-MB
            // transcripts bloat the index by GBs for little retrieval value; raise if needed.
            if (text.length > 200_000) text = text.slice(-200_000);
            docs.push({ ref: path, text, hash: t.hash });
          } catch (e) {
            console.warn(`transcript skipped ${path}: ${(e as Error).message}`);
          }
        }
      }
      return docs;
    },
  };
}
