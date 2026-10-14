const PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bpa-[A-Za-z0-9_-]{16,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g,
];
const KEY_FIELD = /("(?:apiKey|api_key|token|secret)"\s*:\s*")[^"]+(")/gi;

// Literal values of agent env vars named *_PASSWORD/_TOKEN/_SECRET/_KEY, registered
// at spawn/config load. Values under 4 chars are skipped: masking "1" would shred output.
// ponytail: process-global, capped at 256 (oldest dropped) since every run adds a
// fresh VIBEOPS_RUN_TOKEN; a long-lived process forgets old run tokens first.
const SECRET_ENV_NAME = /_(PASSWORD|TOKEN|SECRET|KEY)$/;
const ENV_CAP = 256;
const envValues = new Set<string>();

export function registerEnvSecrets(env: Record<string, string | undefined> | undefined): void {
  if (!env) return;
  for (const [k, v] of Object.entries(env)) {
    if (!SECRET_ENV_NAME.test(k) || !v || v.length < 4) continue;
    envValues.delete(v);
    envValues.add(v);
    if (envValues.size > ENV_CAP) envValues.delete(envValues.values().next().value!);
  }
}

export function redactSecrets(chunk: string): string {
  let out = chunk;
  for (const v of [...envValues].sort((a, b) => b.length - a.length)) out = out.split(v).join("[redacted]");
  for (const p of PATTERNS) out = out.replace(p, "[redacted]");
  return out.replace(KEY_FIELD, "$1[redacted]$2");
}

// Redacted previews of every secret-pattern hit in `text`. Empty => clean.
// Used by the branch secret scan; redactSecrets() only masks, it can't report.
function preview(s: string): string { return s.slice(0, 8) + "…"; }
export function findSecrets(text: string): string[] {
  const hits: string[] = [];
  for (const p of PATTERNS) for (const m of text.matchAll(p)) hits.push(preview(m[0]));
  for (const m of text.matchAll(KEY_FIELD)) hits.push(preview(m[0]));
  return hits;
}
