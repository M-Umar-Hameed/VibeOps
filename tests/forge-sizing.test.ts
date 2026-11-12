import { describe, it, expect, vi } from "vitest";
import { isSlmWorker, heuristicSizing, evaluateTaskSizing, atomicDirective } from "../src/forge/sizing.js";

describe("isSlmWorker", () => {
  it("identifies known SLM agents and model names", () => {
    expect(isSlmWorker("deepseek", "deepseek-9b")).toBe(true);
    expect(isSlmWorker("qwen", "qwen3.6-35b-a3b")).toBe(true);
    expect(isSlmWorker("qwen", "laguna-xs-2.1")).toBe(true);
    expect(isSlmWorker("custom", "llama-3-8b-instruct")).toBe(true);
    expect(isSlmWorker("ollama", "mistral-7b")).toBe(true);
    expect(isSlmWorker("local", "qwen-14b")).toBe(true);
  });

  it("identifies frontier models as non-SLM", () => {
    expect(isSlmWorker("agy", "gemini-3.8-flash-high")).toBe(false);
    expect(isSlmWorker("claude", "Opus")).toBe(false);
    expect(isSlmWorker("claude", "Sonnet")).toBe(false);
    expect(isSlmWorker("codex", "gpt-5.6-sol")).toBe(false);
    expect(isSlmWorker("argon", "gemini-4-argon")).toBe(false);
  });
});

describe("heuristicSizing", () => {
  it("sizes single-file focused tickets as atomic", () => {
    const res = heuristicSizing({
      title: "Fix instant scroll in execute.js",
      body: "Change prepareTrusted to call scrollIntoView with instant behavior in extension/execute.js.",
    });
    expect(res.isTooBig).toBe(false);
    expect(res.reason).toContain("bounded");
  });

  it("sizes tickets touching > 2 distinct files as too big", () => {
    const res = heuristicSizing({
      title: "Browser agent fixes",
      body: "Fix scroll in extension/execute.js, dedupe in extension/worker.js, and drain in src/api/shutdown.ts.",
    });
    expect(res.isTooBig).toBe(true);
    expect(res.reason).toContain("distinct files");
  });

  it("sizes tickets with >= 3 numbered tasks as too big", () => {
    const res = heuristicSizing({
      title: "Multiple bug fixes",
      body: "1. Fix click\n2. Fix typing\n3. Add new tests\n4. Update docs",
    });
    expect(res.isTooBig).toBe(true);
    expect(res.reason).toContain("separate tasks");
  });
});

describe("atomicDirective", () => {
  it("returns empty string when task is not too big", () => {
    expect(atomicDirective({ isTooBig: false, reason: "ok" })).toBe("");
  });

  it("returns atomic SLM directive when task is too big", () => {
    const directive = atomicDirective({ isTooBig: true, reason: "touches 3 files" });
    expect(directive).toContain("ATOMIC SLM WORKER DIRECTIVE");
    expect(directive).toContain("touches 3 files");
    expect(directive).toContain("ONE source file");
  });
});

describe("evaluateTaskSizing", () => {
  it("skips LFM and returns false when worker is a frontier model", async () => {
    const res = await evaluateTaskSizing(
      { title: "Big refactor across many files", body: "a.ts, b.ts, c.ts, d.ts" },
      null,
      "claude",
      "Opus",
    );
    expect(res.isTooBig).toBe(false);
    expect(res.reason).toContain("Frontier model");
  });

  it("falls back to heuristic sizing on endpoint network error", async () => {
    const originalEndpoint = process.env.VIBEOPS_SIZING_ENDPOINT;
    process.env.VIBEOPS_SIZING_ENDPOINT = "http://127.0.0.1:59999/unreachable";
    try {
      const res = await evaluateTaskSizing(
        { title: "Fix scroll in execute.js", body: "Single file fix in execute.js" },
        null,
        "deepseek",
        "deepseek-9b",
      );
      expect(res.isTooBig).toBe(false);
    } finally {
      if (originalEndpoint) process.env.VIBEOPS_SIZING_ENDPOINT = originalEndpoint;
      else delete process.env.VIBEOPS_SIZING_ENDPOINT;
    }
  });
});
