// In-process, non-persistent metrics. Module state; resets only on process
// restart (or resetMetrics() in tests). No classes, no I/O.
const counters: Record<string, number> = {};
const timings: Record<string, { count: number; totalMs: number }> = {};

export function bump(name: string, n = 1): void {
  counters[name] = (counters[name] ?? 0) + n;
}

export function timing(name: string, ms: number): void {
  const t = timings[name] ?? (timings[name] = { count: 0, totalMs: 0 });
  t.count += 1;
  t.totalMs += ms;
}

export function snapshot(): { counters: Record<string, number>; timings: Record<string, { count: number; totalMs: number }> } {
  return {
    counters: { ...counters },
    timings: Object.fromEntries(Object.entries(timings).map(([k, v]) => [k, { ...v }])),
  };
}

// Test seam only.
export function resetMetrics(): void {
  for (const k of Object.keys(counters)) delete counters[k];
  for (const k of Object.keys(timings)) delete timings[k];
}
