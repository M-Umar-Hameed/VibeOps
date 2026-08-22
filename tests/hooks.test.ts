import { expect, test } from "vitest";
import { spawnSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { app } from "../src/api/app.js";
import { createActor } from "../src/services/actors.js";
import { createProject } from "../src/services/projects.js";
import { saveNote } from "../src/services/notes.js";
import { UNTRUSTED_CLAUSE } from "../src/relay/prompts.js";

const uniq = (p: string) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const ROOT = resolve(import.meta.dirname, "..");

// spawnSync blocks the parent's event loop, so it cannot be used to invoke a
// script that fetches back into an http.Server running in this same process
// (the server would never get to accept the request). Async spawn instead.
function runHook(env: NodeJS.ProcessEnv, input: string): Promise<{ status: number | null; stdout: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [join(ROOT, "scripts/recall-hook.mjs")], { env });
    let stdout = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.on("error", reject);
    child.on("close", (status) => resolvePromise({ status, stdout }));
    child.stdin.end(input);
  });
}

test("GET /recall returns the memory block for the caller's query and project", async () => {
  const { apiKey, actor } = await createActor({ name: uniq("recall-route"), kind: "agent" });
  const project = await createProject({ key: uniq("k"), name: uniq("Hooks") });
  const rule = `${uniq("rule")} always run hooks tests`;
  await saveNote(actor.id, { body: rule, scope: "project", refId: project.id, kind: "rule" });
  const res = await app.request(`/recall?q=anything&project=${project.id}`, { headers: { Authorization: `Bearer ${apiKey}` } });
  expect(res.status).toBe(200);
  const body = await res.text();
  expect(body).toContain(rule);
  expect(body).toContain(`<UNTRUSTED label="memory">`);
  expect(body).toContain(UNTRUSTED_CLAUSE);
});

test("recall-hook.mjs prints the server's block for the prompt on stdin, and nothing when the server is dead", async () => {
  const srv = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(`BLOCK for ${decodeURIComponent(new URL(req.url!, "http://x").searchParams.get("q") ?? "")}`);
  });
  // server.address() is null until the "listening" event fires (Node docs); on
  // this machine listen() does not bind synchronously, so we must wait for it.
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const port = (srv.address() as { port: number }).port;
  const dir = mkdtempSync(join(tmpdir(), "hook-"));
  const creds = join(dir, "credentials.json");
  writeFileSync(creds, JSON.stringify({ baseUrl: `http://127.0.0.1:${port}`, apiKey: "k" }));
  try {
    const ok = await runHook({ ...process.env, VIBEOPS_CREDENTIALS: creds }, JSON.stringify({ prompt: "deploy payments" }));
    expect(ok.status).toBe(0);
    expect(ok.stdout).toBe("BLOCK for deploy payments");

    writeFileSync(creds, JSON.stringify({ baseUrl: "http://127.0.0.1:1", apiKey: "k" }));
    const dead = await runHook({ ...process.env, VIBEOPS_CREDENTIALS: creds }, JSON.stringify({ prompt: "x" }));
    expect(dead.status).toBe(0);
    expect(dead.stdout).toBe("");
  } finally {
    srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("install-hooks.mjs adds both hooks once, backs up, and keeps unrelated hooks", () => {
  const home = mkdtempSync(join(tmpdir(), "hooks-home-"));
  const settingsDir = join(home, ".claude");
  mkdirSync(settingsDir);
  const settingsPath = join(settingsDir, "settings.json");
  writeFileSync(settingsPath, JSON.stringify({
    theme: "dark",
    hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo keep-me" }] }] },
  }));
  try {
    const run = () => spawnSync(process.execPath, [join(ROOT, "scripts/install-hooks.mjs")], {
      env: { ...process.env, VIBEOPS_HOOKS_HOME: home }, encoding: "utf8",
    });
    const first = run();
    expect(first.status).toBe(0);
    expect(existsSync(join(settingsDir, "settings.json.bak-vibeops"))).toBe(true);
    const after1 = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(after1.theme).toBe("dark");
    const starts = after1.hooks.SessionStart.flatMap((g: any) => g.hooks.map((h: any) => h.command));
    expect(starts).toContain("echo keep-me");
    expect(starts.some((c: string) => c.includes("prime.mjs"))).toBe(true);
    const prompts = after1.hooks.UserPromptSubmit.flatMap((g: any) => g.hooks.map((h: any) => h.command));
    expect(prompts.some((c: string) => c.includes("recall-hook.mjs"))).toBe(true);

    const second = run();
    expect(second.status).toBe(0);
    const after2 = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(after2).toEqual(after1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("install-hooks.mjs refuses to touch a settings.json that is not valid JSON", () => {
  const home = mkdtempSync(join(tmpdir(), "hooks-home-"));
  const settingsDir = join(home, ".claude");
  mkdirSync(settingsDir);
  const settingsPath = join(settingsDir, "settings.json");
  const bad = "{ not json";
  writeFileSync(settingsPath, bad);
  try {
    const result = spawnSync(process.execPath, [join(ROOT, "scripts/install-hooks.mjs")], {
      env: { ...process.env, VIBEOPS_HOOKS_HOME: home }, encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(readFileSync(settingsPath, "utf8")).toBe(bad);
    expect(existsSync(join(settingsDir, "settings.json.bak-vibeops"))).toBe(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
