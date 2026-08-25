// Per-actor ledger of every MCP browser tool call, so a CLI-lane turn (which
// reaches these tools through its own MCP client, invisible to the server)
// can surface the same trace the SDK lane builds inline. In memory only;
// entries older than TTL are dropped on read.
export type BrowserCall = { actorId: string; name: string; summary: string; grantOrigin?: string; at: number };
const TTL_MS = 30 * 60 * 1000;
const calls: BrowserCall[] = [];

export function recordBrowserCall(
  actorId: string,
  entry: { name: string; summary: string; grantOrigin?: string },
  now = Date.now(),
): void {
  calls.push({ actorId, ...entry, at: now });
}

// Returns and removes this actor's calls recorded at or after `since`, in call order.
export function drainBrowserCalls(actorId: string, since: number, now = Date.now()): BrowserCall[] {
  const keep: BrowserCall[] = [];
  const out: BrowserCall[] = [];
  for (const c of calls) {
    if (now - c.at > TTL_MS) continue;
    if (c.actorId === actorId && c.at >= since) out.push(c); else keep.push(c);
  }
  calls.length = 0;
  calls.push(...keep);
  return out;
}
