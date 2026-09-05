import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMcpConfig, installClientConfig } from "../src/mcp/clients.js";

const URL = "http://127.0.0.1:8787/mcp";
const KEY = "test-key-123";

describe("buildMcpConfig", () => {
  it("builds the three client materials", () => {
    const c = buildMcpConfig(URL, KEY);
    expect(c.url).toBe(URL);
    expect(c.claudeCode.command).toBe(
      `claude mcp add --transport http vibeops ${URL} --header "Authorization: Bearer ${KEY}"`);
    expect(c.cursor.snippet).toEqual(
      { mcpServers: { vibeops: { url: URL, headers: { Authorization: `Bearer ${KEY}` } } } });
    expect(c.gemini.snippet).toEqual(
      { mcpServers: { vibeops: { httpUrl: URL, headers: { Authorization: `Bearer ${KEY}` } } } });
    expect(c.cursor.path.replace(/\\/g, "/")).toContain(".cursor/mcp.json");
    expect(c.gemini.path.replace(/\\/g, "/")).toContain(".gemini/settings.json");
    expect(c.agy.snippet).toEqual(
      { mcpServers: { vibeops: { httpUrl: URL, headers: { Authorization: `Bearer ${KEY}` } } } });
    expect(c.agy.path.replace(/\\/g, "/")).toContain(".gemini/antigravity-cli/settings.json");
  });
});

describe("installClientConfig", () => {
  it("creates a fresh cursor config", () => {
    const home = mkdtempSync(join(tmpdir(), "vibeops-mcp-"));
    const r = installClientConfig("cursor", URL, KEY, home);
    expect(r.backedUp).toBe(false);
    const written = JSON.parse(readFileSync(r.path, "utf-8"));
    expect(written.mcpServers.vibeops.url).toBe(URL);
  });

  it("merges into an existing gemini settings file, preserving unrelated keys, and backs up", () => {
    const home = mkdtempSync(join(tmpdir(), "vibeops-mcp-"));
    mkdirSync(join(home, ".gemini"), { recursive: true });
    const p = join(home, ".gemini", "settings.json");
    writeFileSync(p, JSON.stringify({ theme: "dark", mcpServers: { other: { command: "x" } } }));
    const r = installClientConfig("gemini", URL, KEY, home);
    expect(r.backedUp).toBe(true);
    expect(existsSync(p + ".vibeops-backup")).toBe(true);
    const written = JSON.parse(readFileSync(p, "utf-8"));
    expect(written.theme).toBe("dark");
    expect(written.mcpServers.other.command).toBe("x");
    expect(written.mcpServers.vibeops.httpUrl).toBe(URL);
  });

  it("overwrites a prior vibeops entry on re-install", () => {
    const home = mkdtempSync(join(tmpdir(), "vibeops-mcp-"));
    installClientConfig("cursor", URL, "old-key", home);
    const r = installClientConfig("cursor", URL, KEY, home);
    const written = JSON.parse(readFileSync(r.path, "utf-8"));
    expect(written.mcpServers.vibeops.headers.Authorization).toBe(`Bearer ${KEY}`);
  });

  it("refuses to touch an unparseable file", () => {
    const home = mkdtempSync(join(tmpdir(), "vibeops-mcp-"));
    mkdirSync(join(home, ".cursor"), { recursive: true });
    const p = join(home, ".cursor", "mcp.json");
    writeFileSync(p, "{not json");
    expect(() => installClientConfig("cursor", URL, KEY, home)).toThrow(/unparseable/);
    expect(readFileSync(p, "utf-8")).toBe("{not json");
    expect(existsSync(p + ".vibeops-backup")).toBe(false);
  });

  it("refuses mcpServers shape that is an array", () => {
    const home = mkdtempSync(join(tmpdir(), "vibeops-mcp-"));
    mkdirSync(join(home, ".cursor"), { recursive: true });
    const p = join(home, ".cursor", "mcp.json");
    writeFileSync(p, JSON.stringify({ mcpServers: [] }));
    expect(() => installClientConfig("cursor", URL, KEY, home)).toThrow(/unexpected mcpServers shape/);
    expect(JSON.parse(readFileSync(p, "utf-8"))).toEqual({ mcpServers: [] });
    expect(existsSync(p + ".vibeops-backup")).toBe(false);
  });

  it("refuses mcpServers shape that is a string", () => {
    const home = mkdtempSync(join(tmpdir(), "vibeops-mcp-"));
    mkdirSync(join(home, ".cursor"), { recursive: true });
    const p = join(home, ".cursor", "mcp.json");
    writeFileSync(p, JSON.stringify({ mcpServers: "oops" }));
    expect(() => installClientConfig("cursor", URL, KEY, home)).toThrow(/unexpected mcpServers shape/);
    expect(JSON.parse(readFileSync(p, "utf-8"))).toEqual({ mcpServers: "oops" });
    expect(existsSync(p + ".vibeops-backup")).toBe(false);
  });

  it("preserves original backup content on re-install", () => {
    const home = mkdtempSync(join(tmpdir(), "vibeops-mcp-"));
    mkdirSync(join(home, ".cursor"), { recursive: true });
    const p = join(home, ".cursor", "mcp.json");
    const original = { theme: "light", mcpServers: {} };
    writeFileSync(p, JSON.stringify(original));

    // First install
    const r1 = installClientConfig("cursor", URL, "key-1", home);
    expect(r1.backedUp).toBe(true);
    const backupAfterFirst = JSON.parse(readFileSync(p + ".vibeops-backup", "utf-8"));
    expect(backupAfterFirst).toEqual(original);

    // Modify the file directly
    const modified = JSON.parse(readFileSync(p, "utf-8"));
    modified.theme = "dark";
    writeFileSync(p, JSON.stringify(modified));

    // Second install
    const r2 = installClientConfig("cursor", URL, "key-2", home);
    expect(r2.backedUp).toBe(true);
    const backupAfterSecond = JSON.parse(readFileSync(p + ".vibeops-backup", "utf-8"));
    expect(backupAfterSecond).toEqual(original); // Should still match original
  });

  it("creates a fresh agy config at the antigravity-cli settings path", () => {
    const home = mkdtempSync(join(tmpdir(), "vibeops-mcp-"));
    const r = installClientConfig("agy", URL, KEY, home);
    expect(r.path.replace(/\\/g, "/")).toContain(".gemini/antigravity-cli/settings.json");
    const written = JSON.parse(readFileSync(r.path, "utf-8"));
    expect(written.mcpServers.vibeops.httpUrl).toBe(URL);
  });

  it("merges agy into an existing antigravity settings file, preserving unrelated keys", () => {
    const home = mkdtempSync(join(tmpdir(), "vibeops-mcp-"));
    mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
    const p = join(home, ".gemini", "antigravity-cli", "settings.json");
    writeFileSync(p, JSON.stringify({ editor: "vim", mcpServers: { other: { httpUrl: "y" } } }));
    const r = installClientConfig("agy", URL, KEY, home);
    expect(r.backedUp).toBe(true);
    const written = JSON.parse(readFileSync(r.path, "utf-8"));
    expect(written.editor).toBe("vim");
    expect(written.mcpServers.other.httpUrl).toBe("y");
    expect(written.mcpServers.vibeops.httpUrl).toBe(URL);
  });
});
