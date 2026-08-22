import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Wires VibeOps memory into Claude Code: SessionStart -> prime.mjs (digest),
// UserPromptSubmit -> recall-hook.mjs (rules/decisions for this prompt).
// Idempotent: re-running adds nothing. Never removes hooks it did not add.
const home = process.env.VIBEOPS_HOOKS_HOME ?? homedir();
const settingsDir = join(home, ".claude");
const settingsPath = join(settingsDir, "settings.json");
const scriptsDir = dirname(fileURLToPath(import.meta.url));
const cmd = (file) => `node "${resolve(scriptsDir, file)}"`;

const WANTED = [
  ["SessionStart", cmd("prime.mjs")],
  ["UserPromptSubmit", cmd("recall-hook.mjs")],
];

mkdirSync(settingsDir, { recursive: true });
let settings = {};
if (existsSync(settingsPath)) {
  const raw = readFileSync(settingsPath, "utf-8");
  try {
    settings = JSON.parse(raw);
  } catch {
    process.stderr.write(`settings.json is not valid JSON, nothing changed: ${settingsPath}\n`);
    process.exit(1);
  }
  copyFileSync(settingsPath, join(settingsDir, "settings.json.bak-vibeops"));
}
settings.hooks ??= {};
const added = [];
for (const [event, command] of WANTED) {
  const groups = (settings.hooks[event] ??= []);
  const present = groups.some((g) => (g.hooks ?? []).some((h) => h.command === command));
  if (present) continue;
  groups.push({ hooks: [{ type: "command", command }] });
  added.push(`${event}: ${command}`);
}
writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
console.log(added.length ? `added:\n  ${added.join("\n  ")}` : "hooks already installed, nothing changed");
console.log("projects are matched to Claude Code sessions by cwd against each project's repoPath; set VIBEOPS_PROJECT to force one");
