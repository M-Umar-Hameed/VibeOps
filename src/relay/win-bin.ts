import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

const SHIM_RE = /\.(cmd|bat)$/i;
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

// Windows CreateProcess appends only ".exe", so a bare "claude" that is really
// the npm shim claude.cmd spawns ENOENT -- which read as "CLI not installed"
// in the doctor probe. Resolve the name against PATH x PATHEXT ourselves.
export function resolveBin(cmd0: string): string {
  if (process.platform !== "win32") return cmd0;
  if (cmd0.includes("/") || cmd0.includes("\\")) return cmd0;
  const exts = (process.env.PATHEXT ?? DEFAULT_PATHEXT).split(";").filter(Boolean);
  // An extension the user already wrote is authoritative; appending PATHEXT to
  // it would look for claude.cmd.EXE and miss.
  const named = exts.some((e) => cmd0.toLowerCase().endsWith(e.toLowerCase()));
  const candidates = named ? [cmd0] : exts.map((e) => cmd0 + e);
  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const cand of candidates) {
      const p = join(dir, cand);
      if (existsSync(p)) return p;
    }
  }
  return cmd0;
}

// Each argument is wrapped in quotes with inner quotes doubled: cmd.exe reads a
// quoted span as literal (no & | > parsing) and the MSVC runtime reads "" as one
// literal quote. ponytail: %VAR% still expands inside quotes, so a prompt
// containing %PATH% is corrupted (not injected); switch to a promptFile
// template if that ever bites.
const quote = (s: string) => `"${s.replace(/"/g, '""')}"`;

// Node refuses to spawn .cmd/.bat without a shell (CVE-2024-27980), and
// shell:true joins argv with plain spaces -- a multi-word prompt would shatter
// into separate arguments. Build the cmd.exe command line here and hand it over
// verbatim instead.
export function winCommand(
  cmd0: string, args: string[],
): { file: string; args: string[]; verbatim: boolean } {
  const exe = resolveBin(cmd0);
  if (process.platform !== "win32" || !SHIM_RE.test(exe)) {
    return { file: exe, args, verbatim: false };
  }
  const line = [exe, ...args].map(quote).join(" ");
  // /s strips the outer quote pair and runs the rest as written.
  return { file: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], verbatim: true };
}
