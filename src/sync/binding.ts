export function normalizeBinding(value: string): string {
  return value
    .trim()
    .replace(/^https?:\/\/[^/]+\//, "") // drop scheme + host
    .replace(/\.git$/, "")               // drop trailing .git
    .replace(/\/+$/, "");                // drop trailing slash(es)
}
