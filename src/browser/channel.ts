import { randomUUID } from "node:crypto";

// --- Wire shapes (Epic C §1.1-1.2). Page-derived strings live only inside these
// typed fields; they are never interpreted as commands (§1.5). ---
export type ConnectedInstance = {
  instanceId: string;
  browserChannel: string;
  profileId: string;
  profileLabel: string;
  connectedAt: string; // ISO
};

export type ActionStep =
  | { verb: "click"; ref: string }
  | { verb: "type"; ref: string; text: string }
  | { verb: "select"; ref: string; option: string }
  | { verb: "press"; key: string }
  | { verb: "snapshot" }
  | { verb: "screenshot" }
  | { verb: "read"; ref: string }
  | { verb: "navigate"; url: string }
  | { verb: "clickAt"; x: number; y: number };

export type BatchResult = {
  results: Array<{ ok: boolean; value?: string; error?: string }>;
  snapshot: unknown; // Snapshot (§1.1); untrusted page data, stored/returned verbatim, never introspected here
};

export type DeliveredBatch = {
  batchId: string;
  instanceId: string;
  tenant: string;
  steps: ActionStep[];
  grant?: "act";
  targetOrigin?: string;
};

// Transport: HTTP long-poll on the existing Hono server — zero new deps, same
// 127.0.0.1:8787 origin + bearer auth as every route, batches are request/
// response with no streaming need. WS upgrade path: replace nextBatch() and
// submitResult() with a per-instance WebSocket push; the queue/correlation core
// below is unchanged. Do NOT build WS in this slice.

// Named tuning; each constant states its reasoning. Exported as a mutable object
// so tests can shrink the waits without a config system.
// ponytail: test seam over 3 constants, per-request read; not a settings surface.
const STALE_TTL_MS = 60_000; // an instance that has not polled within this window is treated as gone; poll doubles as heartbeat (<25s) so a live extension always refreshes well inside it
const POLL_TIMEOUT_MS = 25_000; // long-poll hold; kept under the ~30s idle cutoffs of proxies and MV3 service-worker keepalive so the extension reconnects before the socket is cut
const BATCH_TIMEOUT_MS = 30_000; // max a /browser/batches caller waits for execute+report; MUST exceed POLL_TIMEOUT so a batch enqueued as one poll expires is still picked up by the next poll
export const BROWSER_TUNING = { ttlMs: STALE_TTL_MS, pollTimeoutMs: POLL_TIMEOUT_MS, batchTimeoutMs: BATCH_TIMEOUT_MS };

type Pending = {
  batchId: string;
  tenant: string;
  steps: ActionStep[];
  grant?: "act";
  targetOrigin?: string;
  resolve: (r: BatchResult | null) => void; // null => batch timeout (route maps to 504)
  timer: ReturnType<typeof setTimeout>;
  settled: boolean;
};

type Instance = {
  meta: ConnectedInstance;
  lastSeen: number;
  queue: Pending[];
  inFlight: Pending | null;
  waiter: { resolve: (b: DeliveredBatch | null) => void; timer: ReturnType<typeof setTimeout> } | null;
};

const instances = new Map<string, Instance>();

function live(inst: Instance | undefined, now: number): Instance | undefined {
  if (!inst) return undefined;
  return now - inst.lastSeen > BROWSER_TUNING.ttlMs ? undefined : inst;
}

export function register(input: { browserChannel: string; profileId: string; profileLabel: string }): string {
  const instanceId = randomUUID();
  const now = Date.now();
  instances.set(instanceId, {
    meta: {
      instanceId,
      browserChannel: input.browserChannel,
      profileId: input.profileId,
      profileLabel: input.profileLabel,
      connectedAt: new Date(now).toISOString(),
    },
    lastSeen: now,
    queue: [],
    inFlight: null,
    waiter: null,
  });
  return instanceId;
}

export function exists(instanceId: string): boolean {
  return !!live(instances.get(instanceId), Date.now());
}

export function list(): ConnectedInstance[] {
  const now = Date.now();
  const out: ConnectedInstance[] = [];
  for (const inst of instances.values()) if (live(inst, now)) out.push(inst.meta);
  return out;
}

// Deliver a queued batch to a waiting poller when nothing is in flight
// (one in-flight batch per instance).
function pump(inst: Instance): void {
  if (inst.inFlight || !inst.waiter || inst.queue.length === 0) return;
  const batch = inst.queue.shift()!;
  inst.inFlight = batch;
  const w = inst.waiter;
  inst.waiter = null;
  clearTimeout(w.timer);
  w.resolve({ batchId: batch.batchId, instanceId: inst.meta.instanceId, tenant: batch.tenant, steps: batch.steps, grant: batch.grant, targetOrigin: batch.targetOrigin });
}

// GET /browser/poll: next batch for this instance, or null on ~25s timeout (204).
// Poll also refreshes lastSeen — it is the heartbeat.
export function nextBatch(instanceId: string): Promise<DeliveredBatch | null> {
  const inst = live(instances.get(instanceId), Date.now());
  if (!inst) return Promise.resolve(null); // route 404s unknown instance before calling
  inst.lastSeen = Date.now();
  return new Promise<DeliveredBatch | null>((resolve) => {
    if (!inst.inFlight && inst.queue.length > 0) {
      const batch = inst.queue.shift()!;
      inst.inFlight = batch;
      resolve({ batchId: batch.batchId, instanceId, tenant: batch.tenant, steps: batch.steps, grant: batch.grant, targetOrigin: batch.targetOrigin });
      return;
    }
    // Single poller per instance (MVP): retire any prior waiter as a 204.
    if (inst.waiter) {
      clearTimeout(inst.waiter.timer);
      inst.waiter.resolve(null);
      inst.waiter = null;
    }
    const timer = setTimeout(() => {
      if (inst.waiter && inst.waiter.timer === timer) inst.waiter = null;
      resolve(null);
    }, BROWSER_TUNING.pollTimeoutMs);
    inst.waiter = { resolve, timer };
  });
}

// POST /browser/batches: enqueue and await the extension's result, or null on
// batch timeout (route maps to 504). Timeout leaves the queue consistent.
export function submitBatch(
  instanceId: string,
  tenant: string,
  steps: ActionStep[],
  delivery?: { grant: "act"; targetOrigin: string },
): Promise<BatchResult | null> {
  const inst = live(instances.get(instanceId), Date.now());
  if (!inst) return Promise.resolve(null); // route guarantees existence; defensive only
  return new Promise<BatchResult | null>((resolve) => {
    const batch: Pending = {
      batchId: randomUUID(),
      tenant,
      steps,
      grant: delivery?.grant,
      targetOrigin: delivery?.targetOrigin,
      resolve,
      settled: false,
      timer: setTimeout(() => {
        if (batch.settled) return;
        batch.settled = true;
        if (inst.inFlight === batch) inst.inFlight = null;
        else {
          const i = inst.queue.indexOf(batch);
          if (i >= 0) inst.queue.splice(i, 1);
        }
        resolve(null);
        pump(inst); // let the next queued batch flow
      }, BROWSER_TUNING.batchTimeoutMs),
    };
    inst.queue.push(batch);
    pump(inst);
  });
}

// POST /browser/results: match an extension result to its in-flight batch.
// Returns false for unknown/already-timed-out batches (route 404s); queue stays consistent.
export function submitResult(batchId: string, result: BatchResult): boolean {
  const now = Date.now();
  for (const inst of instances.values()) {
    const b = inst.inFlight;
    if (b && b.batchId === batchId && !b.settled) {
      b.settled = true;
      clearTimeout(b.timer);
      inst.inFlight = null;
      inst.lastSeen = now;
      b.resolve(result);
      pump(inst);
      return true;
    }
  }
  return false;
}
