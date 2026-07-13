import { expect, test } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgents } from "../src/system/agents.js";

function b64url(obj: object): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

test("reads claude + codex accounts and sums their tokens, never leaks secrets", async () => {
  const home = mkdtempSync(join(tmpdir(), "agents-"));

  // Claude account + two transcripts with usage
  writeFileSync(join(home, ".claude.json"), JSON.stringify({
    oauthAccount: { emailAddress: "me@example.com", seatTier: "max", displayName: "Me" },
  }));
  const proj = join(home, ".claude", "projects", "p1");
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, "s1.jsonl"),
    JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 100, output_tokens: 20 } } }) + "\n" +
    JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 50, output_tokens: 10 } } }));

  // Codex account (id_token with email) + rollout with cumulative token_count
  const idToken = `h.${b64url({ email: "codex@example.com" })}.s`;
  mkdirSync(join(home, ".codex", "sessions", "2026", "07", "13"), { recursive: true });
  writeFileSync(join(home, ".codex", "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { id_token: idToken } }));
  writeFileSync(join(home, ".codex", "sessions", "2026", "07", "13", "r.jsonl"),
    JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 900, output_tokens: 77, total_tokens: 977 } } } }) + "\n" +
    JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 1200, output_tokens: 100, total_tokens: 1300 } } } }));

  const { agents } = await getAgents(30, home);
  const claude = agents.find((a) => a.agent === "claude")!;
  const codex = agents.find((a) => a.agent === "codex")!;

  expect(claude.connected).toBe(true);
  expect(claude.account).toBe("me@example.com");
  expect(claude.plan).toBe("max");
  expect(claude.tokens).toEqual({ inputTokens: 150, outputTokens: 30, totalTokens: 180, sessions: 1 });

  expect(codex.connected).toBe(true);
  expect(codex.account).toBe("codex@example.com");
  expect(codex.tokens!.totalTokens).toBe(1300); // MAX cumulative, not summed

  // Secret hygiene: no token material anywhere in the response.
  const blob = JSON.stringify(agents);
  expect(blob).not.toContain(idToken);
  expect(blob).not.toMatch(/id_token|access_token|refresh_token|api_key/i);
});

test("missing auth files → connected:false, tokens null, never throws", async () => {
  const home = mkdtempSync(join(tmpdir(), "agents-empty-"));
  const { agents } = await getAgents(30, home);
  for (const a of agents) {
    // antigravity reads the real machine's %APPDATA%, not homeDir, so its
    // connected status is machine-dependent; only claude/codex are pinned here.
    if (a.agent === "antigravity") continue;
    expect(a.connected).toBe(false);
    expect(a.tokens).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0, sessions: 0 });
  }
});

test("token mtime window excludes old sessions", async () => {
  const home = mkdtempSync(join(tmpdir(), "agents-old-"));
  const proj = join(home, ".claude", "projects", "p");
  mkdirSync(proj, { recursive: true });
  const old = join(proj, "old.jsonl");
  writeFileSync(old, JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 999, output_tokens: 999 } } }));
  const t = new Date(Date.now() - 90 * 24 * 3600 * 1000);
  utimesSync(old, t, t);
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "x@y.z" } }));
  const { agents } = await getAgents(7, home);
  expect(agents.find((a) => a.agent === "claude")!.tokens!.totalTokens).toBe(0);
});
