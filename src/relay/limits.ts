// Usage/rate-limit text each subscription CLI prints when an account runs dry.
// Only the output tail is scanned: failure text comes last, and an agent's own
// work output may talk about rate limits.
const LIMIT_TEXT: Record<string, RegExp> = {
  claude: /usage limit|limit reached|\bresets\s+(?:at\s+)?\d|\b429\b|rate_limit_error|overloaded/i,
  "claude-sdk": /usage limit|limit reached|\bresets\s+(?:at\s+)?\d|\b429\b|rate_limit_error|overloaded/i,
  codex: /usage limit|rate limit|\b429\b|too many requests/i,
  agy: /resource_exhausted|quota|\b429\b|rate limit/i,
};
const TAIL_CHARS = 4000;
const MAX_AHEAD_MS = 8 * 24 * 3_600_000;
const UNIT_MS: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 };
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

// ponytail: clock times ("resets 3pm (Asia/Karachi)") are read in server local
// time; the CLI runs on the same machine, so the zone matches. Upgrade: parse the zone.
export function parseResetTime(text: string, now = new Date()): Date | undefined {
  const sane = (d: Date) => (d.getTime() > now.getTime() && d.getTime() - now.getTime() <= MAX_AHEAD_MS ? d : undefined);
  const epoch = /limit reached\|(\d{10})\b/i.exec(text);
  if (epoch) return sane(new Date(Number(epoch[1]) * 1000));
  const rel = /(?:try again|retry) in\s+((?:\d+(?:\.\d+)?\s*(?:days?|hours?|hrs?|minutes?|mins?|seconds?|secs?|[dhms])(?![a-z])[\s,]*(?:and\s+)?)+)/i.exec(text);
  if (rel) {
    let ms = 0;
    for (const [, n, u] of rel[1].matchAll(/(\d+(?:\.\d+)?)\s*([dhms])/gi)) ms += Number(n) * UNIT_MS[u.toLowerCase()];
    return sane(new Date(now.getTime() + ms));
  }
  const clock = /(?:resets|try again at|reset at)\s+(?:at\s+)?(?:([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:(\d{4}),?\s+)?(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\b/i.exec(text);
  if (!clock) return undefined;
  const [, mon, day, year, hh, mm, ap] = clock;
  const d = new Date(now);
  d.setHours((Number(hh) % 12) + (ap.toLowerCase() === "p" ? 12 : 0), Number(mm ?? 0), 0, 0);
  if (mon) {
    const m = MONTHS.indexOf(mon.toLowerCase());
    if (m === -1) return undefined;
    d.setFullYear(year ? Number(year) : now.getFullYear(), m, Number(day));
    if (!year && d <= now) d.setFullYear(d.getFullYear() + 1);
  } else if (d <= now) d.setDate(d.getDate() + 1);
  return sane(d);
}

export function detectLimit(kind: string | undefined, output: string, now = new Date()): { resetAt?: Date } | undefined {
  const re = kind ? LIMIT_TEXT[kind] : undefined;
  const tail = output.slice(-TAIL_CHARS);
  if (!re || !re.test(tail)) return undefined;
  return { resetAt: parseResetTime(tail, now) };
}
