export type ParsedCheck = { command: string; code: number };

const STAGE_LABEL: Record<string, string> = {
  plan: "Planning the change",
  work: "Writing and editing code",
  review: "Reviewing the diff and running checks",
};

export function stageLabel(stage: string): string {
  return STAGE_LABEL[stage] ?? (stage ? stage : "Starting");
}

// Parse the deterministic "=== FORGE checks ===" block that formatChecks()
// emits (src/forge/checks.ts): each check is "$ <cmd>\nexit <code>\n<tail>".
// Narration is never parsed — only this fixed, app-generated block.
// ponytail: line-anchored regex; a check whose tail line is literally "$ x\nexit N"
// could false-match. Switch to a fenced block if that ever bites.
export function parseChecks(output: string): ParsedCheck[] {
  const marker = "=== FORGE checks ===";
  const i = output.indexOf(marker);
  if (i === -1) return [];
  const block = output.slice(i + marker.length);
  const re = /^\$ (.+)\nexit (\d+)/gm;
  const checks: ParsedCheck[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) checks.push({ command: m[1], code: Number(m[2]) });
  return checks;
}

export function elapsedLabel(startMs: number, nowMs: number): string {
  const s = Math.max(0, Math.floor((nowMs - startMs) / 1000));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

// Plain-language failure line + what-happens-next, from status alone.
// Returns null for non-terminal / success statuses.
export function failureLine(status: string, error?: string): string | null {
  switch (status) {
    case "failed":
      return "A stage failed before finishing. The work order was returned to planned - open details, then re-run the pipeline.";
    case "rejected":
      return "Review found blocking issues. The work order went back to planned for another pass - see the diff and details.";
    case "stopped":
      return "Run stopped. Nothing was promoted; re-run when ready.";
    case "error":
      return error && error.trim() ? error : "The run could not be started.";
    default:
      return null;
  }
}

// Minute-granularity summary for a settled run's stage breakdown -- distinct
// from elapsedLabel's second-precision live countup, which multi-minute AI
// stages don't need.
export function formatStageDurations(ms: Partial<Record<"plan" | "work" | "checks" | "review", number>>): string {
  return (["plan", "work", "checks", "review"] as const)
    .filter((k) => typeof ms[k] === "number" && ms[k]! > 0)
    .map((k) => `${k} ${Math.max(1, Math.round(ms[k]! / 60_000))}m`)
    .join(" / ");
}
