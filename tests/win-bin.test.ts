import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { resolveBin, winCommand } from "../src/relay/win-bin.js";

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
