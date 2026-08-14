// Write-triggered logical export, debounced. A board mutation arms a short
// timer; DEBOUNCE_MS of quiet then triggers one export, so a burst coalesces
// into a single export instead of one per write. FLOOR_MS caps the rate so a
// sustained write load can't produce an export storm.
//
// Why this exists: boot / interval(6h) / clean-shutdown exports leave a hole —
// writes since the last 6-hour tick plus an UNCLEAN exit are lost (up to 6h).
// Arming an export a few minutes after each write shrinks that loss window
// from hours to minutes.
//
// Debounce state is in-memory by design. A crash INSIDE the debounce window
// loses only that window (minutes), which is the entire point versus the
// 6-hour gap — do not engineer around it.

// A few minutes of quiet before exporting: long enough to coalesce a busy
// stretch of writes into one export, short enough that an unclean exit loses
// only minutes of board state. Env-tunable; tests inject a short value.
export const EXPORT_DEBOUNCE_MS = Number(process.env.VIBEOPS_EXPORT_DEBOUNCE_MS ?? 120_000);
// Minimum spacing between two write-triggered exports (~12/hr worst case at
// 5 min). Prevents a storm when writes trickle in just over the debounce gap.
export const EXPORT_FLOOR_MS = Number(process.env.VIBEOPS_EXPORT_FLOOR_MS ?? 300_000);

let exportFn: (() => Promise<void>) | null = null;
let debounceMs = EXPORT_DEBOUNCE_MS;
let floorMs = EXPORT_FLOOR_MS;
let timer: ReturnType<typeof setTimeout> | null = null;
let lastExportAt = -Infinity;

// Wire the export function (embedded mode only) and, for tests, short timings.
// Passing null disarms — non-embedded mode never exports locally.
export function configureExport(
  fn: (() => Promise<void>) | null,
  opts: { debounceMs?: number; floorMs?: number } = {},
): void {
  exportFn = fn;
  debounceMs = opts.debounceMs ?? EXPORT_DEBOUNCE_MS;
  floorMs = opts.floorMs ?? EXPORT_FLOOR_MS;
  if (timer) { clearTimeout(timer); timer = null; }
  lastExportAt = -Infinity;
}

// Arm/re-arm the debounce. Cheap and safe on every mutation: no-op when no
// export function is configured; resets the timer so a burst fires once.
export function armExport(): void {
  if (!exportFn) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(fire, debounceMs);
  timer.unref?.();
}

async function fire(): Promise<void> {
  timer = null;
  const since = Date.now() - lastExportAt;
  if (since < floorMs) {
    // Too soon after the last export: defer to the floor boundary, don't skip.
    timer = setTimeout(fire, floorMs - since);
    timer.unref?.();
    return;
  }
  lastExportAt = Date.now();
  await exportFn!();
}
