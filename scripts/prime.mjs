import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";

// SessionStart hook script: must never break a session, so every failure
// path prints nothing and exits 0 rather than throwing.
try {
  const credsPath = process.env.VIBEOPS_CREDENTIALS ?? join(homedir(), ".vibeops", "credentials.json");
  const { baseUrl, apiKey } = JSON.parse(readFileSync(credsPath, "utf-8"));
  // SessionStart hook payloads carry cwd on stdin; fail-open so a session with
  // no stdin, empty stdin, or non-JSON stdin primes exactly as before. On a
  // TTY there is nothing piped in, so reading stdin would block forever —
  // skip the read and proceed without cwd.
  let input = {};
  if (!process.stdin.isTTY) {
    try { input = JSON.parse(readFileSync(0, "utf-8")); } catch { /* proceed without cwd */ }
  }
  const query = process.argv[2] || basename(process.cwd());
  const params = new URLSearchParams({ q: query });
  if (typeof input.cwd === "string" && input.cwd) params.set("cwd", input.cwd);
  if (process.env.VIBEOPS_PROJECT) params.set("project", process.env.VIBEOPS_PROJECT);
  const res = await fetch(`${baseUrl}/prime?${params}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (res.ok) process.stdout.write(await res.text());
} catch {
  // no creds, server down, network error — silent, exit 0
}
