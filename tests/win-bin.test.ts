import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { resolveBin, winCommand, unwrapExeShim } from "../src/relay/win-bin.js";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "fixtures");
const onWindows = process.platform === "win32";
const winTest = test.skipIf(!onWindows);

const originalPath = process.env.PATH;
afterEach(() => { process.env.PATH = originalPath; });

winTest("resolveBin finds a bare name that is really a .cmd shim on PATH", () => {
  process.env.PATH = `${FIXTURES};${originalPath}`;
  // PATHEXT is conventionally uppercase, and NTFS is case-insensitive.
  expect(resolveBin("doctor-exit0").toLowerCase()).toBe(join(FIXTURES, "doctor-exit0.cmd").toLowerCase());
});

winTest("resolveBin leaves an unresolvable name alone", () => {
  process.env.PATH = FIXTURES;
  expect(resolveBin("no-such-binary-anywhere")).toBe("no-such-binary-anywhere");
});

test("resolveBin never rewrites an explicit path", () => {
  const explicit = join(FIXTURES, "doctor-exit0.cmd");
  expect(resolveBin(explicit)).toBe(explicit);
});

winTest("a .cmd shim actually spawns, with multi-word and metachar args intact", async () => {
  const shim = join(FIXTURES, "echo-args.cmd");
  const { file, args, verbatim } = winCommand(shim, ["two words", "a&b", 'has"quote']);
  expect(verbatim).toBe(true);
  const { stdout } = await execFileAsync(file, args, { windowsHide: true, windowsVerbatimArguments: verbatim });
  expect(JSON.parse(stdout)).toEqual(["two words", "a&b", 'has"quote']);
});

test("winCommand passes a plain executable through untouched", () => {
  const exe = join(FIXTURES, "fake-agent.mjs");
  expect(winCommand(exe, ["--version"])).toEqual({ file: exe, args: ["--version"], verbatim: false });
});

test("unwrapExeShim returns the .exe an npm native-binary shim launches", () => {
  const dir = mkdtempSync(join(tmpdir(), "shim-"));
  mkdirSync(join(dir, "node_modules", "pkg", "bin"), { recursive: true });
  writeFileSync(join(dir, "node_modules", "pkg", "bin", "tool.exe"), "");
  const shim = join(dir, "tool.CMD");
  writeFileSync(shim, '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%dp0%\\node_modules\\pkg\\bin\\tool.exe"   %*\r\n');
  try {
    expect(unwrapExeShim(shim)).toBe(join(dir, "node_modules", "pkg", "bin", "tool.exe"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unwrapExeShim returns null for a node-script shim and for a missing .exe", () => {
  const dir = mkdtempSync(join(tmpdir(), "shim-"));
  const nodeShim = join(dir, "script.CMD");
  writeFileSync(nodeShim, '@ECHO off\r\nSETLOCAL\r\n"%_prog%"  "%dp0%\\node_modules\\pkg\\cli.js" %*\r\n');
  const missing = join(dir, "missing.CMD");
  writeFileSync(missing, '@ECHO off\r\n"%dp0%\\node_modules\\gone\\bin\\gone.exe"   %*\r\n');
  try {
    expect(unwrapExeShim(nodeShim)).toBeNull();
    expect(unwrapExeShim(missing)).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
