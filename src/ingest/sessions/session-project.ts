import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename, dirname } from "node:path";
import { and, eq, isNotNull, inArray, isNull } from "drizzle-orm";
import { db } from "../../db/client.js";
import { embeddings, projects, tickets } from "../../db/schema.js";
import { sandboxRoot } from "../../forge/sandbox.js";
import { getSetting, setSetting } from "../../services/settings.js";
import { readIndexTail, readHead } from "./tail.js";

import { UNTRUSTED_CLAUSE } from "../../relay/prompts.js";

// Claude Code names ~/.claude/projects/<dir> by replacing every non-alphanumeric char of the cwd with "-".
export function encodeClaudeProjectDir(p: string): string {
  return p.replace(/[^a-zA-Z0-9]/g, "-");
}

export type ResolverInput = {
  projects: { id: string; repoPath: string | null }[];
  ticketProject: (ticketId: string) => Promise<string | null>;
  sandboxDir: string;
  realpath?: (p: string) => string | null;
};

export function buildSessionProjectResolver(input: ResolverInput): (folder: string) => Promise<string | null> {
  const cache = new Map<string, string | null>();
  const realpath = input.realpath ?? ((p: string) => {
    try {
      return realpathSync.native(p);
    } catch {
      return null;
    }
  });

  return async (folder: string): Promise<string | null> => {
    const lowerFolder = folder.toLowerCase();
    if (cache.has(lowerFolder)) return cache.get(lowerFolder)!;

    // 1. Sandbox folder
    const sandboxEnc = encodeClaudeProjectDir(input.sandboxDir).toLowerCase();
    if (lowerFolder.startsWith(sandboxEnc + "-")) {
      const remainder = folder.slice(sandboxEnc.length + 1);
      const uuidMatch = remainder.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      if (uuidMatch) {
        const pid = await input.ticketProject(uuidMatch[0]);
        cache.set(lowerFolder, pid);
        return pid;
      }
      cache.set(lowerFolder, null);
      return null;
    }

    // 2. Repo folder
    const candidates: { id: string; encoded: string }[] = [];
    for (const proj of input.projects) {
      if (!proj.repoPath) continue;
      const encoded = encodeClaudeProjectDir(proj.repoPath);
      candidates.push({ id: proj.id, encoded });

      const real = realpath(proj.repoPath);
      if (real && real.toLowerCase() !== proj.repoPath.toLowerCase()) {
        candidates.push({ id: proj.id, encoded: encodeClaudeProjectDir(real) });
      }

      // Junction alias: F--Github → G:\Github
      const folderDrive = folder.match(/^([A-Za-z])--/);
      if (folderDrive) {
        const repoDrive = proj.repoPath.match(/^([A-Za-z]):/);
        if (repoDrive && folderDrive[1].toLowerCase() !== repoDrive[1].toLowerCase()) {
          const alt = folderDrive[1] + proj.repoPath.slice(1);
          const altReal = realpath(alt);
          if (altReal && real && altReal.toLowerCase() === real.toLowerCase()) {
            candidates.push({ id: proj.id, encoded: encodeClaudeProjectDir(alt) });
          }
        }
      }
    }

    let longestMatch: { id: string; len: number } | null = null;
    for (const c of candidates) {
      const cLower = c.encoded.toLowerCase();
      if (lowerFolder === cLower || lowerFolder.startsWith(cLower + "-")) {
        if (!longestMatch || c.encoded.length > longestMatch.len) {
          longestMatch = { id: c.id, len: c.encoded.length };
        }
      }
    }

    const result = longestMatch?.id ?? null;
    cache.set(lowerFolder, result);
    return result;
  };
}

export async function loadSessionProjectResolver(sandboxDir = sandboxRoot()): Promise<(folder: string) => Promise<string | null>> {
  const projs = await db.select({ id: projects.id, repoPath: projects.repoPath })
    .from(projects)
    .where(isNotNull(projects.repoPath));

  const ticketProject = async (ticketId: string): Promise<string | null> => {
    const [t] = await db.select({ projectId: tickets.projectId })
      .from(tickets)
      .where(eq(tickets.id, ticketId))
      .limit(1);
    return t?.projectId ?? null;
  };

  return buildSessionProjectResolver({ projects: projs, ticketProject, sandboxDir });
}

export function defaultSkipDirs(): string[] {
  if (process.platform !== "win32") return [];
  return [join(homedir(), "AppData", "Local", "VibeOps", "resources", "server")];
}

export function isSkippedSessionDir(folder: string, skipDirs: string[]): boolean {
  const encoded = encodeClaudeProjectDir(folder).toLowerCase();
  for (const sd of skipDirs) {
    if (encodeClaudeProjectDir(sd).toLowerCase() === encoded) return true;
  }
  return false;
}

// Warmup detection: userTurnTexts extracted from the session
export function userTurnTexts(raw: string): string[] {
  const out: string[] = [];
  for (const line of raw.split("\n")) {
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (d?.type !== "user") continue;
    const content = d.message?.content;
    if (typeof content === "string") {
      const t = content.trim();
      if (t) out.push(t);
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (typeof block === "string") {
        const t = block.trim();
        if (t) out.push(t);
        continue;
      }
      if (block?.type === "text" && typeof block.text === "string") {
        const t = block.text.trim();
        if (t) out.push(t);
      }
    }
  }
  return out;
}

export function isWarmupTranscript(fileName: string, raw: string): boolean {
  if (!/^agent-.*\.jsonl$/i.test(fileName)) return false;
  const t = userTurnTexts(raw);
  return t.length > 0 && t.every((x) => x === "Warmup");
}

export function isForgeAgentTranscript(raw: string): boolean {
  const FORGE_EXTRACTOR_PREFIX = '<UNTRUSTED label="transcript">';
  // UNTRUSTED_CLAUSE from relay/prompts.ts
  const FORGE_CLAUSE = UNTRUSTED_CLAUSE.trim(); // from relay/prompts.js


  const first = userTurnTexts(raw)[0];
  return !!first && (first.startsWith(FORGE_EXTRACTOR_PREFIX) || (first.startsWith("Ticket: ") && first.includes(FORGE_CLAUSE)));
}

export async function backfillSessionKnowledge(opts: {
  projectsDir?: string;
  sandboxDir?: string;
  skipDirs?: string[];
  resolve?: (folder: string) => Promise<string | null>;
} = {}): Promise<{ scanned: number; deleted: number; assigned: number }> {
  const projectsDir = opts.projectsDir ?? join(homedir(), ".claude", "projects");
  const sandboxDir = opts.sandboxDir ?? sandboxRoot();
  const skipDirs = opts.skipDirs ?? defaultSkipDirs();
  const resolve = opts.resolve ?? await loadSessionProjectResolver(sandboxDir);

  const rows = await db.select({ ref: embeddings.sourceRef })
    .from(embeddings)
    .where(eq(embeddings.sourceKind, "session"));

  const distinctRefs = [...new Set(rows.map((r) => r.ref))];
  const scopedRefs = distinctRefs.filter((ref) => {
    const parentDir = dirname(dirname(ref));
    return parentDir.toLowerCase() === projectsDir.toLowerCase();
  });

  const toDelete: string[] = [];
  const toAssign = new Map<string, string[]>();

  for (const ref of scopedRefs) {
    const folder = basename(dirname(ref));

    // Check skip dirs
    if (isSkippedSessionDir(folder, skipDirs)) {
      toDelete.push(ref);
      continue;
    }

    // Check warmup
    let skip = false;
    try {
      const tail = readIndexTail(ref);
      if (tail && isWarmupTranscript(basename(ref), tail.text)) {
        toDelete.push(ref);
        skip = true;
      }
    } catch {
      // file gone or unreadable, keep it indexed
    }
    if (skip) continue;

    // Check Forge agent
    try {
      const head = readHead(ref);
      if (head && isForgeAgentTranscript(head)) {
        toDelete.push(ref);
        skip = true;
      }
    } catch {
      // file gone or unreadable
    }
    if (skip) continue;

    // Assign project
    const pid = await resolve(folder);
    if (pid) {
      if (!toAssign.has(pid)) toAssign.set(pid, []);
      toAssign.get(pid)!.push(ref);
    }
  }

  // Delete in slices of 500
  let deleted = 0;
  for (let i = 0; i < toDelete.length; i += 500) {
    const slice = toDelete.slice(i, i + 500);
    const delRows = await db.delete(embeddings).where(
      and(eq(embeddings.sourceKind, "session"), inArray(embeddings.sourceRef, slice))
    ).returning({ ref: embeddings.sourceRef });
    deleted += new Set(delRows.map((r) => r.ref)).size;
  }

  // Assign in slices of 500 per project
  let assigned = 0;
  for (const [pid, refs] of toAssign) {
    for (let i = 0; i < refs.length; i += 500) {
      const slice = refs.slice(i, i + 500);
      const updRows = await db.update(embeddings)
        .set({ projectId: pid })
        .where(
          and(
            eq(embeddings.sourceKind, "session"),
            inArray(embeddings.sourceRef, slice),
            isNull(embeddings.projectId)
          )
        ).returning({ ref: embeddings.sourceRef });
      assigned += new Set(updRows.map((r) => r.ref)).size;
    }
  }

  return { scanned: scopedRefs.length, deleted, assigned };
}

export async function backfillSessionKnowledgeOnce(): Promise<void> {
  if (await getSetting("knowledge.sessionBackfill") === "v1") return;
  const r = await backfillSessionKnowledge();
  console.log("sessions backfill: " + JSON.stringify(r));
  await setSetting("knowledge.sessionBackfill", "v1");
}
