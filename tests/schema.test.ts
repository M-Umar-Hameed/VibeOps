import { expect, test } from "vitest";
import { sql } from "../src/db/client.js";
import { EMBEDDED } from "./helpers/embedded.js";

test.skipIf(EMBEDDED)("all core tables exist", async () => {
  const rows = await sql`
    select table_name from information_schema.tables
    where table_schema = 'public'`;
  const names = rows.map((r) => r.table_name);
  for (const t of ["projects", "actors", "tickets", "comments", "events"]) {
    expect(names).toContain(t);
  }
});

test.skipIf(EMBEDDED)("forge gap columns, tickets.source_key and forge_queue exist", async () => {
  const cols = async (table: string) =>
    (await sql`select column_name from information_schema.columns where table_schema = 'public' and table_name = ${table}`).map((r) => r.column_name);
  const runCols = await cols("forge_runs");
  for (const c of ["cause", "cause_detail", "work_base_sha", "base_branch", "stage_times", "resume_at", "limit_waits", "promote_on_pass", "allow_paths", "gate_only_paths", "gate_only_sha"]) {
    expect(runCols).toContain(c);
  }
  expect(await cols("tickets")).toContain("source_key");
  const queueCols = await cols("forge_queue");
  for (const c of ["id", "ticket_id", "project_id", "picks", "extra_prompt", "after_ticket_ids", "status", "run_id", "error", "position", "created_at"]) {
    expect(queueCols).toContain(c);
  }
  const idx = async (name: string) =>
    (await sql`select indexdef from pg_indexes where schemaname = 'public' and indexname = ${name}`)[0]?.indexdef as string | undefined;
  const srcIdx = await idx("tickets_source_key_uniq");
  expect(srcIdx).toMatch(/UNIQUE INDEX/);
  expect(srcIdx).toMatch(/\(project_id, source_key\)/);
  const qIdx = await idx("forge_queue_queued_ticket_uniq");
  expect(qIdx).toMatch(/UNIQUE INDEX/);
  expect(qIdx).toMatch(/\(ticket_id\) WHERE \(status = 'queued'::text\)/);
});
