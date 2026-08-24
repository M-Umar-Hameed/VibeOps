import type { ChildProcess } from "node:child_process";
import type { RelayAgent } from "./config.js";
import { runAgent as runAgentCli, type AgentResult } from "./invoke.js";
import { runAgentSdk } from "./invoke-sdk.js";
import { runHttpAgent } from "./http-agent.js";

// The ONE dispatch point. cli call sites in forge/runs.ts import runAgent from
// here unchanged; sdk agents route to the in-loop lane; http agents (plan/review
// only -- config refuses the work role) route to the chat-completion lane.
// onAbort is only wired by the work stage (sdk has no ChildProcess for
// onSpawn/killTree). model is sdk/http-only: cli agents already carry it
// substituted into cmd by resolveCmd.
export function runAgent(
  agent: RelayAgent, prompt: string, workdir: string,
  onData?: (chunk: string) => void,
  onSpawn?: (child: ChildProcess) => void,
  onAbort?: (abort: () => void) => void,
  model?: string,
  logPath?: string,
): Promise<AgentResult> {
  if (agent.type === "sdk") return runAgentSdk(agent, prompt, workdir, onData, onAbort, model);
  if (agent.type === "http") {
    if (!model) return Promise.resolve({ ok: false, output: "[forge: no model saved for this http lane; save at least one model on the lane]" });
    return runHttpAgent(agent, prompt, model, onData);
  }
  return runAgentCli(agent, prompt, workdir, onData, onSpawn, logPath);
}
