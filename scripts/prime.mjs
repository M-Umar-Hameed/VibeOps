import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";

// SessionStart hook script: must never break a session, so every failure
// path prints nothing and exits 0 rather than throwing.
try {
  const credsPath = join(homedir(), ".vibeops", "credentials.json");
  const { baseUrl, apiKey } = JSON.parse(readFileSync(credsPath, "utf-8"));
  const query = process.argv[2] || basename(process.cwd());
  const res = await fetch(`${baseUrl}/prime?q=${encodeURIComponent(query)}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (res.ok) process.stdout.write(await res.text());
} catch {
  // no creds, server down, network error — silent, exit 0
}
