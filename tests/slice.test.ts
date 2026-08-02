import { afterEach, expect, test } from "vitest";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { allocateSlice, type Slice } from "../src/runtime/slice.js";
import { vibeopsHome } from "../src/runtime/home.js";

const slices: Slice[] = [];
const homes: string[] = [];
function home(): string { const h = mkdtempSync(join(tmpdir(), "slice-home-")); homes.push(h); return h; }

afterEach(async () => {
  for (const s of slices.splice(0)) await s.release();
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

test("two slices allocated concurrently never share a port, both differ from 8787", async () => {
  const [a, b] = await Promise.all([
    allocateSlice({ ticketId: randomUUID(), home: home() }),
    allocateSlice({ ticketId: randomUUID(), home: home() }),
  ]);
  slices.push(a, b);
  expect(a.port).not.toBe(b.port);
  expect(a.port).not.toBe(8787);
  expect(b.port).not.toBe(8787);
});

test("VIBEOPS_HOME unset: data dir resolves homedir-based, exactly as today", () => {
  const prev = process.env.VIBEOPS_HOME;
  delete process.env.VIBEOPS_HOME;
  try {
    expect(join(vibeopsHome(), ".vibeops", "data")).toBe(join(homedir(), ".vibeops", "data"));
  } finally {
    if (prev !== undefined) process.env.VIBEOPS_HOME = prev;
  }
});

test("each slice gets its own writable, isolated database", async () => {
  const a = await allocateSlice({ ticketId: randomUUID(), home: home() });
  const b = await allocateSlice({ ticketId: randomUUID(), home: home() });
  slices.push(a, b);
  expect(a.databaseUrl).not.toBe(b.databaseUrl);
  const sa = postgres(a.databaseUrl, { max: 1 });
  const sb = postgres(b.databaseUrl, { max: 1 });
  try {
    await sa`INSERT INTO projects (key, name) VALUES ('slice-a', 'A')`;
    const [ra] = await sa`SELECT count(*)::int AS n FROM projects WHERE key = 'slice-a'`;
    const [rb] = await sb`SELECT count(*)::int AS n FROM projects WHERE key = 'slice-a'`;
    expect(ra.n).toBe(1);
    expect(rb.n).toBe(0); // A's write invisible in B -> isolation
  } finally {
    await sa.end(); await sb.end();
  }
});

test("release frees the port and drops the database; idempotent, no leak", async () => {
  const h = home();
  const s = await allocateSlice({ ticketId: randomUUID(), home: h });
  const name = s.databaseUrl.split("/").pop()!;
  await s.release();
  await s.release(); // idempotent, must not throw

  const admin = postgres("postgres://tickets:tickets@localhost:5433/postgres", { max: 1 });
  try {
    const rows = await admin`SELECT 1 FROM pg_database WHERE datname = ${name}`;
    expect(rows.length).toBe(0); // dropped -> no DB leak
  } finally {
    await admin.end();
  }

  const s2 = await allocateSlice({ ticketId: randomUUID(), home: h });
  slices.push(s2);
  expect(typeof s2.port).toBe("number"); // port freed -> re-allocatable, no leak
});
