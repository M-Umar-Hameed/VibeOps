import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readJsonlDelta, readHead, TAIL_BYTES, MAX_TAIL_BYTES } from "./tail.js";
import type { SessionSource, SessionDoc } from "./source.js";
import { sandboxRoot, inside } from "../../forge/sandbox.js";
import {

  loadSessionProjectResolver,
  defaultSkipDirs,
  isSkippedSessionDir,

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
  opts: { skipDirs?: string[]; resolveProject?: (folder: string) => Promise<string | null>; tailBytes?: number; windowBytes?: number } = {},
): SessionSource {
  return {
    source: "claude-code",
    async listSessionDocs(sinceDays: number, cursors?: ReadonlyMap<string, number>): Promise<SessionDoc[]> {
      const tailBytes = opts.tailBytes ?? TAIL_BYTES;
      const windowBytes = opts.windowBytes ?? MAX_TAIL_BYTES;
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
            const d = readJsonlDelta(path, cursors?.get(path), tailBytes, windowBytes);
            if (!d) continue; // unchanged since the cursor, unreadable, or no complete line yet
            if (d.texts.some(isLocalModelTranscript)) continue;
            const head = !d.append && st.size <= tailBytes ? d.texts[0] : readHead(path);
            // Forge worker transcripts run inside the sandbox root; they are not user sessions.
            let cwd: string | undefined;
            for (const t of d.texts) { cwd = sessionCwd(t); if (cwd) break; }
            cwd ??= sessionCwd(head);
            if (cwd && inside(cwd, sandboxDir)) continue;
            if (isWarmupTranscript(name, d.append ? head : d.texts[0])) continue;
            if (isForgeAgentTranscript(head)) continue;
            // ponytail: a first user line longer than 1 MB can't be parsed, so the transcript is kept. Raise the head size if that happens.
            let text = d.texts.map(extractText).filter(Boolean).join("\n\n");
            if (!d.append) {
              if (!text) continue;
              // ponytail: first ingest keeps the most recent 200k chars; later growth is appended in full via the cursor.
              if (text.length > 200_000) text = text.slice(-200_000);
            }
            docs.push({ ref: path, text, hash: d.hash, projectId, cursor: { offset: d.offset, size: d.size }, append: d.append });
          } catch (e) {
            console.warn(`transcript skipped ${path}: ${(e as Error).message}`);
          }
        }
      }
      return docs;
    },
  };
}
