import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// UserPromptSubmit hook: Claude Code pipes {"prompt": "..."} on stdin; whatever
// we print is injected as context. Must never break a session: every failure
// prints nothing and exits 0, same contract as prime.mjs.
try {
  const credsPath = process.env.VIBEOPS_CREDENTIALS ?? join(homedir(), ".vibeops", "credentials.json");
  const { baseUrl, apiKey } = JSON.parse(readFileSync(credsPath, "utf-8"));
  const input = JSON.parse(readFileSync(0, "utf-8"));
  const prompt = typeof input.prompt === "string" ? input.prompt : "";
  if (!prompt.trim()) process.exit(0);
  const params = new URLSearchParams({ q: prompt.slice(0, 2000) });
  if (process.env.VIBEOPS_PROJECT) params.set("project", process.env.VIBEOPS_PROJECT);
  const res = await fetch(`${baseUrl}/recall?${params}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(3000),
  });
  if (res.ok) process.stdout.write(await res.text());
} catch {
  // no creds, server down, bad stdin: silent, exit 0
}
