import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { loadRelayConfig, type RelayAgent, type RelayConfig } from "./config.js";
import { composePlanPrompt, composeWorkPrompt, composeReviewPrompt, parseVerdict } from "./prompts.js";
import { runAgent } from "./invoke.js";
import { listTickets, getTicket, getComments, updateTicket, addComment, getKnowledge } from "./api.js";
import type { Ticket, Comment } from "../db/schema.js";

const DIFF_CAP = 150_000;

type RunOpts = { agent: string; ticket?: string };

function getAgent(config: RelayConfig, name: string, role: string): RelayAgent {
  const agent = config.agents[name];
  if (!agent) throw new Error(`relay config has no agent "${name}"`);
  if (!agent.roles.includes(role)) throw new Error(`agent "${name}" is not configured for role "${role}"`);
  return agent;
}

function oldest(tickets: Ticket[]): Ticket | undefined {
  return [...tickets].sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt))[0];
}

function latestByKind(comments: Comment[], kind: string): Comment | undefined {
  return [...comments].reverse().find((c) => c.kind === kind);
}

function gitDiff(workdir: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn("git", ["diff"], { cwd: workdir });
    let out = "";
    child.stdout?.on("data", (d: Buffer) => {
      if (out.length < DIFF_CAP) out += d.toString("utf-8");
    });
    child.on("close", () => resolve(out.slice(0, DIFF_CAP)));
    child.on("error", () => resolve(""));
  });
}

export async function runPlan(config: RelayConfig, opts: RunOpts): Promise<void> {
  const agent = getAgent(config, opts.agent, "plan");
  const ticket = opts.ticket ? await getTicket(config, opts.ticket) : oldest(await listTickets(config, "open"));
  if (!ticket) { console.log("relay plan: no ticket available"); return; }

  const knowledge = await getKnowledge(config, ticket.title, 5);
  const prompt = composePlanPrompt({ ticket, knowledge });
  const result = await runAgent(agent, prompt, config.workdir);
  if (!result.ok) {
    console.error(`relay plan: agent failed for ticket ${ticket.id}; leaving it open`);
    return;
  }

  await addComment(config, ticket.id, result.output, "plan");
  const updated = await updateTicket(config, ticket.id, ticket.version, { status: "planned" });
  if ("conflict" in updated) console.warn(`relay plan: ticket ${ticket.id} changed before status update`);
}

export async function runWork(config: RelayConfig, opts: RunOpts): Promise<void> {
  const agent = getAgent(config, opts.agent, "work");
  const candidates = opts.ticket
    ? [await getTicket(config, opts.ticket)]
    : [...(await listTickets(config, "planned"))].sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt));

  let claimed: Ticket | undefined;
  for (const t of candidates) {
    const res = await updateTicket(config, t.id, t.version, { status: "in_progress" });
    if (!("conflict" in res)) { claimed = res; break; }
  }
  if (!claimed) { console.log("relay work: no ticket available"); return; }

  const plan = latestByKind(await getComments(config, claimed.id), "plan");
  const knowledge = await getKnowledge(config, claimed.title, 5);
  const prompt = composeWorkPrompt({
    ticket: claimed, plan: plan?.body ?? "", knowledge, workdir: config.workdir,
  });
  const result = await runAgent(agent, prompt, config.workdir);

  if (result.ok) {
    await addComment(config, claimed.id, result.output, "report");
    await updateTicket(config, claimed.id, claimed.version, { status: "review" });
  } else {
    // Never leave a claimed ticket stuck in in_progress: report the failure
    // and bounce it back for another planning/work pass.
    await addComment(config, claimed.id, `relay: worker failed\n\n${result.output}`, "report");
    await updateTicket(config, claimed.id, claimed.version, { status: "planned" });
  }
}

export async function runReview(config: RelayConfig, opts: RunOpts): Promise<void> {
  const agent = getAgent(config, opts.agent, "review");
  const ticket = opts.ticket ? await getTicket(config, opts.ticket) : oldest(await listTickets(config, "review"));
  if (!ticket) { console.log("relay review: no ticket available"); return; }

  const comments = await getComments(config, ticket.id);
  const plan = latestByKind(comments, "plan");
  const report = latestByKind(comments, "report");
  const diff = await gitDiff(config.workdir);
  const prompt = composeReviewPrompt({ ticket, plan: plan?.body ?? "", report: report?.body ?? "", diff });
  const result = await runAgent(agent, prompt, config.workdir);
  const verdict = parseVerdict(result.output);

  await addComment(config, ticket.id, verdict.raw, "review");
  await updateTicket(config, ticket.id, ticket.version, { status: verdict.pass ? "closed" : "planned" });
}

const ROLE_FNS = { plan: runPlan, work: runWork, review: runReview };

function parseArgs(argv: string[]): { role: keyof typeof ROLE_FNS; agent: string; ticket?: string; watch: boolean; config?: string } {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  const role = get("--role");
  const agent = get("--agent");
  if (role !== "plan" && role !== "work" && role !== "review") throw new Error("--role must be plan|work|review");
  if (!agent) throw new Error("--agent is required");
  return { role, agent, ticket: get("--ticket"), watch: argv.includes("--watch"), config: get("--config") };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function main(): Promise<void> {
  if (process.argv.includes("--version")) {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf-8"));
    console.log(pkg.version);
    return;
  }
  const args = parseArgs(process.argv.slice(2));
  const config = loadRelayConfig(args.config);
  const fn = ROLE_FNS[args.role];
  const opts: RunOpts = { agent: args.agent, ticket: args.ticket };

  if (!args.watch) {
    await fn(config, opts);
    return;
  }
  // Watch loop survives individual ticket failures; it never exits on its own.
  for (;;) {
    try {
      await fn(config, opts);
    } catch (e) {
      console.error(`relay ${args.role} error:`, (e as Error).message);
    }
    await sleep(config.pollMs ?? 30_000);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
