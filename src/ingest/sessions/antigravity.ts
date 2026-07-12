import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileHashBytes } from "../../services/knowledge.js";
import type { SessionSource, SessionDoc } from "./source.js";

// Antigravity's Agent Manager writes markdown artifacts (plans, task lists,
// walkthroughs) under brain/<conversation>/; conversations proper are cloud-side.
// Empty dirs are the normal state until an agent runs — stay silent then.
const SUBDIRS = ["brain", "conversations"];
const EXTS = [".md", ".txt"];

function* walkText(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    let st;
    try { st = statSync(path); } catch { continue; }
    if (st.isDirectory()) yield* walkText(path);
    else if (EXTS.some((e) => name.endsWith(e))) yield path;
  }
}

export function makeAntigravitySource(
  rootDir = join(homedir(), ".gemini", "antigravity"),
): SessionSource {
  return {
    source: "antigravity",
    async listSessionDocs(sinceDays: number): Promise<SessionDoc[]> {
      const cutoff = Date.now() - sinceDays * 24 * 3600 * 1000;
      const docs: SessionDoc[] = [];
      for (const sub of SUBDIRS) {
        const dir = join(rootDir, sub);
        if (!existsSync(dir)) continue;
        for (const path of walkText(dir)) {
          try {
            if (statSync(path).mtimeMs < cutoff) continue;
            const buf = readFileSync(path);
            let text = buf.toString("utf8").trim();
            if (!text) continue;
            if (text.length > 200_000) text = text.slice(-200_000);
            docs.push({ ref: path, text, hash: fileHashBytes(buf) });
          } catch (e) {
            console.warn(`antigravity artifact skipped ${path}: ${(e as Error).message}`);
          }
        }
      }
      return docs;
    },
  };
}
