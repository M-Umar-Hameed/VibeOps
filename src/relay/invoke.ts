import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RelayAgent } from "./config.js";

const OUTPUT_CAP = 100_000;
const DEFAULT_TIMEOUT_MS = 30 * 60_000;

// Pure: only replaces placeholders present as keys in `vars`; anything else
// in the cmd array passes through untouched.
export function substituteCmd(cmd: string[], vars: Record<string, string>): string[] {
  return cmd.map((part) =>
    Object.entries(vars).reduce((acc, [key, value]) => acc.split(`{${key}}`).join(value), part),
  );
}

function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
  } else {
    child.kill("SIGKILL");
  }
}

export async function runAgent(
  agent: RelayAgent, prompt: string, workdir: string,
  onData?: (chunk: string) => void,
): Promise<{ ok: boolean; output: string }> {
  const promptFile = join(tmpdir(), `vibeops-relay-${randomUUID()}.txt`);
  const needsFile = agent.cmd.some((p) => p.includes("{promptFile}"));
  if (needsFile) await writeFile(promptFile, prompt, { encoding: "utf-8", mode: 0o600 });

  const [cmd0, ...rest] = substituteCmd(agent.cmd, { prompt, promptFile, workdir });

  try {
    return await new Promise((resolve) => {
      // stdin ignored: headless CLIs (codex exec) otherwise block reading it.
      const child = spawn(cmd0, rest, { cwd: workdir, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      let settled = false;

      const timer = setTimeout(() => killTree(child), agent.timeoutMs ?? DEFAULT_TIMEOUT_MS);

      const capture = (chunk: Buffer) => {
        const s = chunk.toString("utf-8");
        if (output.length < OUTPUT_CAP) output += s;
        onData?.(s);
      };
      child.stdout?.on("data", capture);
      child.stderr?.on("data", capture);

      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok, output: output.slice(0, OUTPUT_CAP) });
      };
      child.on("close", (code) => finish(code === 0));
      child.on("error", () => finish(false));
    });
  } finally {
    if (needsFile) await unlink(promptFile).catch(() => {});
  }
}
