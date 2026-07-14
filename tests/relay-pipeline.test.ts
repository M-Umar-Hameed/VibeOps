import { expect, test } from "vitest";
import { execFileSync, execSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runPlan, runWork, runReview } from "../src/relay/runner.js";
import type { RelayConfig } from "../src/relay/config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_AGENT = join(__dirname, "fixtures", "fake-agent.mjs");

type Ticket = { id: string; status: string; version: number };
type Comment = { kind: string; body: string };

// Full-pipeline integration test: real embedded server (spawned like
// mcp-http.test.ts), real optimistic-locked DB transitions, real git diff —
// the only fake is the agent process itself (tests/fixtures/fake-agent.mjs).
test("relay pipeline: plan -> work -> review(fail) -> rework -> review(pass) -> closed, plus claim race", { timeout: 120_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "vibeops-relay-pipeline-"));
  const port = 18994;
  const env = { ...process.env, HOME: home, USERPROFILE: home, PORT: String(port), EMBED_PROVIDER: "fake" };
  delete (env as Record<string, unknown>).DATABASE_URL;
  delete (env as Record<string, unknown>).VITEST;
  const child: ChildProcess = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "src/api/server.ts"], { env, stdio: "ignore" });

  const workdir = mkdtempSync(join(tmpdir(), "vibeops-relay-repo-"));
  execFileSync("git", ["init"], { cwd: workdir });

  try {
    let apiKey = "";
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        apiKey = JSON.parse(readFileSync(join(home, ".vibeops", "credentials.json"), "utf-8")).apiKey;
        const ping = await fetch(`http://127.0.0.1:${port}/projects`, { headers: { Authorization: `Bearer ${apiKey}` } });
        if (ping.status === 200) break;
      } catch { /* not up yet */ }
    }
    expect(apiKey).not.toBe("");

    const h = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
    const projRes = await fetch(`http://127.0.0.1:${port}/projects`, {
      method: "POST", headers: h,
      body: JSON.stringify({ key: `relay-pipe-${Date.now()}`, name: "Relay Pipeline" }),
    });
    const project = await projRes.json();

    const config: RelayConfig = {
      workdir, baseUrl: `http://127.0.0.1:${port}`, apiKey,
      agents: { fake: { cmd: [process.execPath, FAKE_AGENT, "{prompt}"], roles: ["plan", "work", "review"] } },
    };

    async function createTicket(title: string): Promise<Ticket> {
      const res = await fetch(`http://127.0.0.1:${port}/tickets`, {
        method: "POST", headers: h, body: JSON.stringify({ projectId: project.id, title }),
      });
      return res.json();
    }
    async function getTicket(id: string): Promise<Ticket> {
      const res = await fetch(`http://127.0.0.1:${port}/tickets/${id}`, { headers: h });
      return res.json();
    }
    async function getComments(id: string): Promise<Comment[]> {
      const res = await fetch(`http://127.0.0.1:${port}/tickets/${id}/comments`, { headers: h });
      return res.json();
    }

    // --- Full pipeline on one ticket ---
    const ticket = await createTicket("Pipeline ticket");

    process.env.FAKE_MODE = "plan";
    await runPlan(config, { agent: "fake", ticket: ticket.id });
    expect((await getTicket(ticket.id)).status).toBe("planned");
    expect((await getComments(ticket.id)).find((c) => c.kind === "plan")?.body).toContain("do the thing");

    process.env.FAKE_MODE = "work";
    await runWork(config, { agent: "fake", ticket: ticket.id });
    expect((await getTicket(ticket.id)).status).toBe("review");
    expect((await getComments(ticket.id)).find((c) => c.kind === "report")?.body).toContain("changed x");

    process.env.FAKE_MODE = "review-fail";
    await runReview(config, { agent: "fake", ticket: ticket.id });
    expect((await getTicket(ticket.id)).status).toBe("planned");
    const failReview = [...(await getComments(ticket.id))].reverse().find((c) => c.kind === "review");
    expect(failReview?.body).toContain("VERDICT: FAIL");
    expect(failReview?.body).toContain("fix y");

    process.env.FAKE_MODE = "work";
    await runWork(config, { agent: "fake", ticket: ticket.id });
    expect((await getTicket(ticket.id)).status).toBe("review");

    process.env.FAKE_MODE = "review-pass";
    await runReview(config, { agent: "fake", ticket: ticket.id });
    expect((await getTicket(ticket.id)).status).toBe("closed");

    // --- Claim race: two concurrent runWork on one planned ticket, exactly one wins ---
    const raceTicket = await createTicket("Race ticket");
    process.env.FAKE_MODE = "plan";
    await runPlan(config, { agent: "fake", ticket: raceTicket.id });
    expect((await getTicket(raceTicket.id)).status).toBe("planned");

    process.env.FAKE_MODE = "work";
    await Promise.all([
      runWork(config, { agent: "fake", ticket: raceTicket.id }),
      runWork(config, { agent: "fake", ticket: raceTicket.id }),
    ]);
    expect((await getTicket(raceTicket.id)).status).toBe("review");
    expect((await getComments(raceTicket.id)).filter((c) => c.kind === "report")).toHaveLength(1);
  } finally {
    child.kill();
    try { execSync(process.platform === "win32" ? `taskkill /pid ${child.pid} /T /F` : `kill -9 ${child.pid}`); } catch { /* already dead */ }
  }
});
