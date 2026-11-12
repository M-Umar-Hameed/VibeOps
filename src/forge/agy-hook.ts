import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, rmdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const AGY_HOOK_NAME = "vibeops-firewall";
const hookFile = (root: string) => join(root, ".agents", "hooks.json");
const backupFile = (root: string) => join(root, ".forge", "agy-hook-backup.json");
type Backup = { existed: boolean; b64?: string; createdDir: boolean };

export function installAgyHook(root: string, command: string): void {
  restoreAgyHook(root);
  const file = hookFile(root);
  const existed = existsSync(file);
  const createdDir = !existsSync(join(root, ".agents"));
  const orig = existed ? readFileSync(file) : undefined;
  mkdirSync(join(root, ".forge"), { recursive: true });
  writeFileSync(backupFile(root), JSON.stringify({ existed, b64: orig?.toString("base64"), createdDir } satisfies Backup));
  let base: Record<string, unknown> = {};
  try {
    const p: unknown = orig ? JSON.parse(orig.toString("utf8")) : {};
    if (p && typeof p === "object" && !Array.isArray(p)) base = p as Record<string, unknown>;
  } catch { /* unparseable original */ }
  mkdirSync(join(root, ".agents"), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({ ...base, [AGY_HOOK_NAME]: { PreToolUse: [{ matcher: "run_command", hooks: [{ type: "command", command, timeout: 10 }] }] } }, null, 2) + "\n"
  );
}

export function restoreAgyHook(root: string): void {
  const bf = backupFile(root);
  if (!existsSync(bf)) return;
  try {
    const b = JSON.parse(readFileSync(bf, "utf8")) as Backup;
    const file = hookFile(root);
    if (b.existed) {
      writeFileSync(file, Buffer.from(b.b64 ?? "", "base64"));
    } else {
      rmSync(file, { force: true });
      const dir = join(root, ".agents");
      if (b.createdDir && existsSync(dir) && readdirSync(dir).length === 0) {
        rmdirSync(dir);
      }
    }
  } finally {
    rmSync(bf, { force: true });
  }
}
