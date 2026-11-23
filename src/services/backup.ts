import { mkdirSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { db } from "../db/client.js";
import { vibeopsHome } from "../runtime/home.js";
import * as schema from "../db/schema.js";
import { projects, actors, tickets, notes, comments, events, settings } from "../db/schema.js";

// Cross-driver handle: app db is PostgresJs, embedded/tests are PGlite; both
// extend PgDatabase. Any-typed so either assigns without `as never` at callsites.
export type Db = PgDatabase<any, typeof schema, any>;

// Durable tables only. Embeddings are EXCLUDED on purpose: derived, rebuildable
// by re-indexing, and ~99% of the bytes. The other non-listed tables (sync_*,
// forge_runs, ai_usage_logs, agent_sessions, project_settings) are out of scope
// for this backup by ticket definition.
export const DURABLE = ["projects", "actors", "tickets", "notes", "comments", "events", "settings"] as const;
export type Counts = Record<(typeof DURABLE)[number], number>;

export type Dump = {
  projects: (typeof projects.$inferSelect)[];
  actors: (typeof actors.$inferSelect)[];
  tickets: (typeof tickets.$inferSelect)[];
  notes: (typeof notes.$inferSelect)[];
  comments: (typeof comments.$inferSelect)[];
  events: (typeof events.$inferSelect)[];
  settings: (typeof settings.$inferSelect)[];
};

export async function dumpDurable(source: Db = db): Promise<Dump> {
  return {
    projects: await source.select().from(projects),
    actors: await source.select().from(actors),
    tickets: await source.select().from(tickets),
    notes: await source.select().from(notes),
    comments: await source.select().from(comments),
    events: await source.select().from(events),
    settings: await source.select().from(settings),
  };
}

export function countDump(d: Dump): Counts {
  return {
    projects: d.projects.length, actors: d.actors.length, tickets: d.tickets.length,
    notes: d.notes.length, comments: d.comments.length, events: d.events.length,
    settings: d.settings.length,
  };
}

export async function countTables(d: Db = db): Promise<Counts> {
  const one = async (t: any) => {
    const [r] = await d.select({ n: sql<number>`count(*)::int` }).from(t);
    return r.n;
  };
  return {
    projects: await one(projects), actors: await one(actors), tickets: await one(tickets),
    notes: await one(notes), comments: await one(comments), events: await one(events),
    settings: await one(settings),
  };
}

// Restore with id remapping. Projects remap by `key`, actors by `name`; a
// pre-existing row (e.g. bootstrap owner, or an Inbox project) is reused and its
// dumped id is rewritten across all FKs — dumped ids are never assumed to survive.
export async function restoreDurable(target: Db, dump: Dump): Promise<Counts> {
  const projectIdMap = new Map<string, string>();
  const actorIdMap = new Map<string, string>();

  const liveActors = await target.select({ id: actors.id, name: actors.name }).from(actors);
  const liveActorByName = new Map(liveActors.map((a) => [a.name, a.id]));
  const actorRows = [];
  for (const a of dump.actors) {
    const live = liveActorByName.get(a.name);
    if (live) { actorIdMap.set(a.id, live); continue; }
    actorIdMap.set(a.id, a.id);
    actorRows.push({ ...a, createdAt: new Date(a.createdAt) });
  }
  if (actorRows.length) await target.insert(actors).values(actorRows);

  const liveProjects = await target.select({ id: projects.id, key: projects.key }).from(projects);
  const liveProjectByKey = new Map(liveProjects.map((p) => [p.key, p.id]));
  const projectRows = [];
  for (const p of dump.projects) {
    const live = liveProjectByKey.get(p.key);
    if (live) { projectIdMap.set(p.id, live); continue; }
    projectIdMap.set(p.id, p.id);
    projectRows.push({ ...p, createdAt: new Date(p.createdAt) });
  }
  if (projectRows.length) await target.insert(projects).values(projectRows);

  const mapActor = (id: string) => actorIdMap.get(id) ?? id;
  const mapProject = (id: string) => projectIdMap.get(id) ?? id;

  // Tickets/notes/comments/events keep their dumped ids (no natural key), so
  // their child FKs stay valid; only project/actor FKs are remapped.
  const ticketRows = dump.tickets.map((t) => ({
    ...t,
    projectId: mapProject(t.projectId),
    assigneeId: t.assigneeId ? mapActor(t.assigneeId) : null,
    createdAt: new Date(t.createdAt),
    updatedAt: new Date(t.updatedAt),
  }));
  if (ticketRows.length) await target.insert(tickets).values(ticketRows);

  const noteRows = dump.notes.map((n) => ({
    ...n,
    actorId: mapActor(n.actorId),
    refId: n.scope === "project" && n.refId ? mapProject(n.refId) : n.refId,
    createdAt: new Date(n.createdAt),
    deletedAt: n.deletedAt ? new Date(n.deletedAt) : null,
  }));
  if (noteRows.length) await target.insert(notes).values(noteRows);

  const commentRows = dump.comments.map((c) => ({
    ...c, authorId: mapActor(c.authorId), createdAt: new Date(c.createdAt),
  }));
  if (commentRows.length) await target.insert(comments).values(commentRows);

  const eventRows = dump.events.map((e) => ({
    ...e, actorId: mapActor(e.actorId), at: new Date(e.at),
  }));
  if (eventRows.length) await target.insert(events).values(eventRows);

  for (const s of dump.settings) {
    await target.insert(settings).values(s).onConflictDoNothing();
  }

  return countTables(target);
}

export type Tiers = { recent: number; days: number; weeks: number };
// Local disk is tight (C: ~14 GB free); offsite keeps months.
export const LOCAL_TIERS: Tiers = { recent: 10, days: 7, weeks: 4 };
export const OFFSITE_TIERS: Tiers = { recent: 24, days: 30, weeks: 26 };

export const EXPORT_RE = /^export-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.json$/;

function exportTime(name: string): number | null {
  const m = EXPORT_RE.exec(name);
  if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]);
  return Number.isNaN(t) ? null : t;
}

// ISO-8601 week key (UTC), e.g. "2026-W53". The Thursday of the week decides its year.
export function isoWeekKey(t: number): string {
  const d = new Date(t);
  const day = (d.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  const thu = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day + 3);
  const y = new Date(thu).getUTCFullYear();
  const week = Math.floor((thu - Date.UTC(y, 0, 1)) / 86_400_000 / 7) + 1;
  return `${y}-W${String(week).padStart(2, "0")}`;
}

// Pure. Returns the export names to KEEP, newest first. Non-matching names are
// never returned. Files dated after `now` (clock skew) are always kept and
// excluded from tier counting.
export function selectExportsToKeep(names: string[], now: number, tiers: Tiers): string[] {
  const parsed = names
    .map((n) => ({ n, t: exportTime(n) }))
    .filter((x): x is { n: string; t: number } => x.t !== null)
    .sort((a, b) => b.t - a.t || (a.n < b.n ? 1 : -1));
  const keep = new Set<string>();
  const past = parsed.filter((x) => { if (x.t > now) { keep.add(x.n); return false; } return true; });
  past.slice(0, Math.max(0, tiers.recent)).forEach((x) => keep.add(x.n));
  const newestPer = (key: (t: number) => string, limit: number) => {
    const seen = new Set<string>();
    for (const x of past) {
      const k = key(x.t);
      if (seen.has(k)) continue;
      if (seen.size >= limit) break;
      seen.add(k); keep.add(x.n);
    }
  };
  newestPer((t) => new Date(t).toISOString().slice(0, 10), Math.max(0, tiers.days));
  newestPer(isoWeekKey, Math.max(0, tiers.weeks));
  return parsed.filter((x) => keep.has(x.n)).map((x) => x.n);
}

export function backupDir(): string {
  return join(vibeopsHome(), ".vibeops", "backups");
}

export async function writeBackup(
  now: string, source: Db = db, dir = backupDir(), tiers: Tiers = LOCAL_TIERS,
): Promise<{ path: string; counts: Counts; offsite: import("./offsite.js").OffsiteExportResult }> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dump = await dumpDurable(source);
  const counts = countDump(dump);
  const path = join(dir, `export-${now}.json`);
  writeFileSync(path, JSON.stringify(dump), { mode: 0o600 });
  pruneBackups(dir, tiers);
  // Never throws: offsite failures are recorded in backup-status.json, not raised.
  const { afterLocalExport } = await import("./offsite.js");
  const offsite = await afterLocalExport(path);
  return { path, counts, offsite };
}

// Deletes only files matching EXPORT_RE and not selected by the tiers.
export function pruneBackups(dir: string, tiers: Tiers, now = Date.now()): void {
  const names = readdirSync(dir).filter((f) => EXPORT_RE.test(f));
  const keep = new Set(selectExportsToKeep(names, now, tiers));
  for (const f of names) if (!keep.has(f)) rmSync(join(dir, f));
}
