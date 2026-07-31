import type { ChildProcess } from "node:child_process";
import type { RelayAgent } from "./config.js";
import { runAgent as runAgentCli, type AgentResult } from "./invoke.js";
import { runAgentSdk } from "./invoke-sdk.js";

// The ONE dispatch point. cli call sites in forge/runs.ts import runAgent from
// here unchanged; sdk agents route to the in-loop lane. onAbort is only wired
// by the work stage (sdk has no ChildProcess for onSpawn/killTree).
export function runAgent(
  agent: RelayAgent, prompt: string, workdir: string,
  onData?: (chunk: string) => void,
  onSpawn?: (child: ChildProcess) => void,
  onAbort?: (abort: () => void) => void,
): Promise<AgentResult> {
  if (agent.type === "sdk") return runAgentSdk(agent, prompt, workdir, onData, onAbort);
  return runAgentCli(agent, prompt, workdir, onData, onSpawn);
}
