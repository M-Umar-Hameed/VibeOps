const PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bpa-[A-Za-z0-9_-]{16,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g,
];
const KEY_FIELD = /("(?:apiKey|api_key|token|secret)"\s*:\s*")[^"]+(")/gi;

export function redactSecrets(chunk: string): string {
  let out = chunk;
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
