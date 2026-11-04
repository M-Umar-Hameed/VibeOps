import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename, dirname } from "node:path";
import { readIndexTail, readHead, TAIL_BYTES } from "./tail.js";
import type { SessionSource, SessionDoc } from "./source.js";
import { sandboxRoot, inside } from "../../forge/sandbox.js";
import {
  encodeClaudeProjectDir,
  loadSessionProjectResolver,
  defaultSkipDirs,
  isSkippedSessionDir,
  userTurnTexts,
  isWarmupTranscript,
  isForgeAgentTranscript,
} from "./session-project.js";

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

export function sessionCwd(raw: string): string | undefined {
  for (const line of raw.split("\n")) {
    if (!line.includes('"cwd"')) continue;
    let d: any;
    try { d = JSON.parse(line); } catch { continue; }
    if (typeof d?.cwd === "string" && d.cwd) return d.cwd;
  }
  return undefined;
}

export { userTurnTexts, isWarmupTranscript, isForgeAgentTranscript } from "./session-project.js";

export function makeClaudeCodeSource(
  projectsDir = join(homedir(), ".claude", "projects"),
  sandboxDir = sandboxRoot(),
  opts: { skipDirs?: string[]; resolveProject?: (folder: string) => Promise<string | null> } = {},
): SessionSource {
  return {
    source: "claude-code",
    async listSessionDocs(sinceDays: number): Promise<SessionDoc[]> {
      if (!existsSync(projectsDir)) return [];
      const cutoff = Date.now() - sinceDays * 24 * 3600 * 1000;
      const docs: SessionDoc[] = [];
      const skipDirs = opts.skipDirs ?? defaultSkipDirs();
      let resolveProject: ((folder: string) => Promise<string | null>) | undefined;
      const projectIdByFolder = new Map<string, string | null>();

      for (const proj of readdirSync(projectsDir)) {
        if (isSkippedSessionDir(proj, skipDirs)) continue;

        const pdir = join(projectsDir, proj);
        let entries: string[];
        try {
          if (!statSync(pdir).isDirectory()) continue;
          entries = readdirSync(pdir);
        } catch {
          continue;
        }

        let projectId: string | null | undefined = undefined;
        if (!projectIdByFolder.has(proj)) {
          if (!resolveProject) {
            resolveProject = opts.resolveProject ?? await loadSessionProjectResolver(sandboxDir);
          }
          projectId = await resolveProject(proj);
          projectIdByFolder.set(proj, projectId);
        } else {
          projectId = projectIdByFolder.get(proj)!;
        }

        for (const name of entries) {
          if (!name.endsWith(".jsonl")) continue;
          const path = join(pdir, name);
          try {
            const st = statSync(path);
            if (st.mtimeMs < cutoff) continue;
            const t = readIndexTail(path);
            if (!t || isLocalModelTranscript(t.text)) continue;
            // Forge worker transcripts run inside the sandbox root; they are not user sessions.
            const cwd = sessionCwd(t.text);
            if (cwd && inside(cwd, sandboxDir)) continue;

            // Warmup check
            if (isWarmupTranscript(name, t.text)) continue;

            // Forge agent check (needs head if file > TAIL_BYTES)
            const head = st.size <= TAIL_BYTES ? t.text : readHead(path);
            if (isForgeAgentTranscript(head)) continue;
            // ponytail: a first user line longer than 1 MB can't be parsed, so the transcript is kept. Raise the head size if that happens.

            let text = extractText(t.text);
            if (!text) continue;
            // ponytail: cap to the most recent 200k chars per session — full multi-MB
            // transcripts bloat the index by GBs for little retrieval value; raise if needed.
            if (text.length > 200_000) text = text.slice(-200_000);
            docs.push({ ref: path, text, hash: t.hash, projectId });
          } catch (e) {
            console.warn(`transcript skipped ${path}: ${(e as Error).message}`);
          }
        }
      }
      return docs;
    },
  };
}
