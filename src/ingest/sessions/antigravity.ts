import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readIndexTail } from "./tail.js";
import type { SessionSource, SessionDoc } from "./source.js";

// Antigravity's Agent Manager writes markdown artifacts (plans, task lists) under brain/<conversation>/
// and conversation transcripts under brain/<conversation>/.system_generated/logs/transcript.jsonl
const SUBDIRS = ["brain", "conversations"];
const EXTS = [".md", ".txt"];

function* walkFiles(dir: string): Generator<string> {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    const path = join(dir, name);
    let st;
    try { st = statSync(path); } catch { continue; }
    if (st.isDirectory()) {
      yield* walkFiles(path);
    } else {
      if (EXTS.some((e) => name.endsWith(e))) yield path;
      if (name === "transcript.jsonl") yield path; // Add local transcripts!
    }
  }
}

function parseTranscript(raw: string): string {
  const lines = raw.trim().split("\n");
  let out = "";
  for (const line of lines) {
    if (!line) continue;
    try {
      const step = JSON.parse(line);
      if (step.type === "USER_INPUT") {
        out += `\n### User\n${step.content}\n`;
      } else if (step.type === "PLANNER_RESPONSE") {
        out += `\n### Antigravity\n${step.content}\n`;
      }
    } catch {
      // ignore parse errors
    }
  }
  return out.trim();
}

export function makeAntigravitySource(
  rootDirs = [
    join(homedir(), ".gemini", "antigravity"),
    join(homedir(), ".gemini", "antigravity-cli"),
    join(homedir(), ".gemini", "antigravity-ide")
  ]
): SessionSource {
  return {
    source: "antigravity",
    async listSessionDocs(sinceDays: number): Promise<SessionDoc[]> {
      const cutoff = Date.now() - sinceDays * 24 * 3600 * 1000;
      const docs: SessionDoc[] = [];
      
      for (const rootDir of rootDirs) {
        for (const sub of SUBDIRS) {
          const dir = join(rootDir, sub);
        if (!existsSync(dir)) continue;
        for (const path of walkFiles(dir)) {
          try {
            if (statSync(path).mtimeMs < cutoff) continue;
            const t = readIndexTail(path);
            if (!t) continue;

            let text = "";
            if (path.endsWith("transcript.jsonl")) {
              text = parseTranscript(t.text);
            } else {
              text = t.text.trim();
            }

            if (!text) continue;
            if (text.length > 200_000) text = text.slice(-200_000);
            docs.push({ ref: path, text, hash: t.hash });
          } catch (e) {
            console.warn(`antigravity artifact skipped ${path}: ${(e as Error).message}`);
          }
        }
      }
    }
    return docs;
  },
  };
}
