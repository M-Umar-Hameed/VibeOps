import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { assertTicketId, sandboxPathIn } from "../forge/sandbox.js";

// One allocation primitive. A run asks for a slice and receives an isolated
// port (held until release), a home dir (VIBEOPS_HOME), its sandbox path, and a
// dedicated test database. Everything downstream reads from the slice instead
// of hardcoding 8787 / homedir() / the shared :5433 test DB.

// ponytail: the per-run DB lives in the test Postgres only -- the concurrency
// problem is suite-vs-suite contention on :5433. Override the instance via
// VIBEOPS_TEST_PG_BASE if the test DB moves; default is the compose port.
// Upgrade path: derive from DATABASE_URL's host if the base ever varies per env.
const PG_BASE = process.env.VIBEOPS_TEST_PG_BASE ?? "postgres://tickets:tickets@localhost:5433";
const TEMPLATE = "vibeops_test_template";
const TEMPLATE_LOCK = 918273; // fixed advisory-lock key: serialize template build

export type Slice = {
  port: number;
  home: string;
  sandbox: string;
  databaseUrl: string;
  env: Record<string, string>;
  freePort: () => void;
  release: () => Promise<void>;
};

// Bind port 0 and HOLD the listener so the OS cannot hand the same port to a
// concurrently-allocated slice. No scan-and-hope: genuinely free, stays
// reserved until freePort()/release().
function reservePort(): Promise<{ port: number; server: Server }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") resolve({ port: addr.port, server });
      else { server.close(); reject(new Error("port reservation failed")); }
    });
  });
}

async function ensureTemplate(admin: ReturnType<typeof postgres>): Promise<void> {
  await admin`SELECT pg_advisory_lock(${TEMPLATE_LOCK})`;
  try {
    const [row] = await admin`SELECT 1 AS ok FROM pg_database WHERE datname = ${TEMPLATE}`;
    if (row) return;
    await admin.unsafe(`CREATE DATABASE ${TEMPLATE}`);
    const tsql = postgres(`${PG_BASE}/${TEMPLATE}`, { max: 1 });
    try {
      await tsql`CREATE EXTENSION IF NOT EXISTS vector`;
      await migrate(drizzle(tsql), { migrationsFolder: "drizzle" });
    } finally {
      await tsql.end();
    }
  } finally {
    await admin`SELECT pg_advisory_unlock(${TEMPLATE_LOCK})`;
  }
}

async function provisionDatabase(): Promise<{ url: string; drop: () => Promise<void> }> {
  const name = `vibeops_run_${randomUUID().replace(/-/g, "")}`;
  const admin = postgres(`${PG_BASE}/postgres`, { max: 1 });
  try {
    await ensureTemplate(admin);
    await admin.unsafe(`CREATE DATABASE ${name} TEMPLATE ${TEMPLATE}`);
  } finally {
    await admin.end();
  }
  const drop = async () => {
    const a = postgres(`${PG_BASE}/postgres`, { max: 1 });
    try {
      await a.unsafe(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${name}' AND pid <> pg_backend_pid()`,
      );
      await a.unsafe(`DROP DATABASE IF EXISTS ${name}`);
    } finally {
      await a.end();
    }
  };
  return { url: `${PG_BASE}/${name}`, drop };
}

export async function allocateSlice(opts: { ticketId: string; home: string }): Promise<Slice> {
  assertTicketId(opts.ticketId);
  const { port, server } = await reservePort();
  let db: { url: string; drop: () => Promise<void> };
  try {
    db = await provisionDatabase();
  } catch (e) {
    server.close();
    throw e; // fail the request with a clear message; no queue, no wait (non-goal)
  }
  const sandbox = sandboxPathIn(join(opts.home, ".vibeops", "sandbox"), opts.ticketId);

  let portClosed = false;
  const freePort = () => { if (!portClosed) { portClosed = true; server.close(); } };
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    freePort();
    await db.drop();
  };

  return {
    port,
    home: opts.home,
    sandbox,
    databaseUrl: db.url,
    env: {
      PORT: String(port),
      VIBEOPS_HOME: opts.home,
      USERPROFILE: opts.home,
      HOME: opts.home,
      DATABASE_URL: db.url,
    },
    freePort,
    release,
  };
}
