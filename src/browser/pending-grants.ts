// Ledger of every MCP browser tool call, so a CLI-lane turn (which reaches
// these tools through its own MCP client, invisible to the server) can
// surface the same trace the SDK lane builds inline. Keyed by the running
// chat turn's session id rather than the calling actor: the desktop app and
// a CLI agent's credentials key are different actors hitting the same MCP
// server, so an actor-keyed ledger never matches on the CLI lane. In memory
// only; entries older than TTL are dropped on read.
export type BrowserCall = {
  actorId: string;
  name: string;
  summary: string;
  grantOrigin?: string;
  at: number;
  sessionId: string | null;
};
const TTL_MS = 30 * 60 * 1000;
const calls: BrowserCall[] = [];

// Ordered (oldest to newest) ids of CLI turns currently running. The last
// entry is the active turn a browser call gets stamped with.
const runningCliTurns: string[] = [];

export function beginCliTurn(sessionId: string): void {
  const i = runningCliTurns.indexOf(sessionId);
  if (i !== -1) runningCliTurns.splice(i, 1);
  runningCliTurns.push(sessionId);
}

export function endCliTurn(sessionId: string): void {
  const i = runningCliTurns.indexOf(sessionId);
  if (i !== -1) runningCliTurns.splice(i, 1);
}

export function currentCliTurn(): string | null {
  return runningCliTurns.length ? runningCliTurns[runningCliTurns.length - 1] : null;
}

export function recordBrowserCall(
  actorId: string,
  entry: { name: string; summary: string; grantOrigin?: string },
  now = Date.now(),
): void {
  calls.push({ actorId, ...entry, at: now, sessionId: currentCliTurn() });
}

// Returns and removes matching calls, in call order. Pass { sessionId } to
// drain a CLI turn's calls regardless of which actor recorded them. Pass
// { actorId, since } as a fallback for calls recorded with no CLI turn
// active (sessionId: null) - the pre-session-keying behaviour.
export function drainBrowserCalls(
  filter: { sessionId: string } | { actorId: string; since: number },
  now = Date.now(),
): BrowserCall[] {
  const keep: BrowserCall[] = [];
  const out: BrowserCall[] = [];
  for (const c of calls) {
    if (now - c.at > TTL_MS) continue;
    const match = "sessionId" in filter
      ? c.sessionId === filter.sessionId
      : c.sessionId === null && c.actorId === filter.actorId && c.at >= filter.since;
    if (match) out.push(c); else keep.push(c);
  }
  calls.length = 0;
  calls.push(...keep);
  return out;
}
