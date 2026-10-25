import { EventEmitter } from "node:events";
import { describe, it, expect, vi } from "vitest";
import { isSdkTransportClosedError, installSdkTransportGuard } from "../src/relay/invoke-sdk.js";

function sdkErr(code: string, stack: string): Error {
  const e = Object.assign(new Error(`write ${code}`), { code });
  e.stack = stack;
  return e;
}
const SDK_STACK = "Error: write EPIPE\n    at ProcessTransport.write (node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs:7871)";

describe("isSdkTransportClosedError", () => {
  it("true for EPIPE from claude-agent-sdk", () => {
    expect(isSdkTransportClosedError(sdkErr("EPIPE", SDK_STACK))).toBe(true);
  });
  it("true for ECONNRESET and ERR_STREAM_DESTROYED from claude-agent-sdk", () => {
    expect(isSdkTransportClosedError(sdkErr("ECONNRESET", SDK_STACK))).toBe(true);
    expect(isSdkTransportClosedError(sdkErr("ERR_STREAM_DESTROYED", SDK_STACK))).toBe(true);
  });
  it("false for EPIPE from elsewhere", () => {
    expect(isSdkTransportClosedError(sdkErr("EPIPE", "Error: write EPIPE\n    at Socket.write (node:net:1)"))).toBe(false);
  });
  it("false for a TypeError", () => {
    expect(isSdkTransportClosedError(new TypeError("x is not a function"))).toBe(false);
  });
});

describe("installSdkTransportGuard", () => {
  function fakeProc() {
    return Object.assign(new EventEmitter(), { exit: vi.fn() });
  }
  it("swallows SDK EPIPE without exiting", () => {
    const proc = fakeProc();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    installSdkTransportGuard(proc);
    proc.emit("uncaughtException", sdkErr("EPIPE", SDK_STACK));
    expect(proc.exit).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("sdk transport closed: EPIPE");
    warn.mockRestore();
  });
  it("exits 1 on any other error", () => {
    const proc = fakeProc();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    installSdkTransportGuard(proc);
    proc.emit("uncaughtException", new TypeError("boom"));
    expect(proc.exit).toHaveBeenCalledWith(1);
    error.mockRestore();
  });
});
