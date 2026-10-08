import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readIndexTail } from "./tail.js";
import type { SessionSource, SessionDoc } from "./source.js";

// Rollout jsonl: clean conversation text lives in event_msg lines with
// payload.type user_message/agent_message; everything else is tool/reasoning noise.
function extractText(raw: string): string {
  const out: string[] = [];
  for (const line of raw.split("\n")) {
    let d: any;
    try { d = JSON.parse(line); } catch { continue; }
    if (d?.type !== "event_msg") continue;
    const p = d.payload;
    if (p?.type !== "user_message" && p?.type !== "agent_message") continue;
    if (typeof p.message === "string" && p.message.trim()) out.push(p.message.trim());
  }
  return out.join("\n\n");
}

function* walkJsonl(dir: string): Generator<string> {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    const path = join(dir, name);
    let st;
    try { st = statSync(path); } catch { continue; }
    if (st.isDirectory()) yield* walkJsonl(path);
    else if (name.endsWith(".jsonl")) yield path;
  }
}

export function makeCodexSource(
  sessionsDir = join(homedir(), ".codex", "sessions"),
): SessionSource {
  return {
    source: "codex",
    async listSessionDocs(sinceDays: number): Promise<SessionDoc[]> {
      if (!existsSync(sessionsDir)) return [];
      const cutoff = Date.now() - sinceDays * 24 * 3600 * 1000;
      const docs: SessionDoc[] = [];
      for (const path of walkJsonl(sessionsDir)) {
        try {
          if (statSync(path).mtimeMs < cutoff) continue;
          const t = readIndexTail(path);
          if (!t) continue;
          let text = extractText(t.text);
          if (!text) continue;
          if (text.length > 200_000) text = text.slice(-200_000);
          docs.push({ ref: path, text, hash: t.hash });
        } catch (e) {
          console.warn(`codex session skipped ${path}: ${(e as Error).message}`);
        }
      }
      return docs;
    },
  };
}
