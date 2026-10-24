import { describe, it, expect } from "vitest";
import { detectLimit, parseResetTime } from "../src/relay/limits.js";

describe("relay-limits", () => {
  const now = new Date(2026, 9, 24, 10, 0, 0);

  it("claude: epoch reset", () => {
    const epoch = Math.floor(now.getTime() / 1000) + 3600;
    const text = `Claude AI usage limit reached|${epoch}`;
    const hit = detectLimit("claude", text, now);
    expect(hit).toBeDefined();
    expect(hit?.resetAt?.getTime()).toBe(epoch * 1000);
  });

  it("claude: clock time 3pm", () => {
    const text = "5-hour limit reached ∙ resets 3pm";
    const hit = detectLimit("claude", text, now);
    expect(hit).toBeDefined();
    expect(hit?.resetAt).toEqual(new Date(2026, 9, 24, 15, 0));
  });

  it("claude: clock time 9am tomorrow", () => {
    const text = "You've hit your limit · resets 9am (Asia/Karachi)";
    const hit = detectLimit("claude", text, now);
    expect(hit).toBeDefined();
    expect(hit?.resetAt).toEqual(new Date(2026, 9, 25, 9, 0));
  });

  it("claude: 429 rate_limit_error", () => {
    const text = 'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"rate limit"}}';
    const hit = detectLimit("claude", text, now);
    expect(hit).toBeDefined();
    expect(hit?.resetAt).toBeUndefined();
  });

  it("claude-sdk: overloaded", () => {
    const text = 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';
    const hit = detectLimit("claude-sdk", text, now);
    expect(hit).toBeDefined();
    expect(hit?.resetAt).toBeUndefined();
  });

  it("codex: clock time with minutes", () => {
    const text = "■ You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), or try again at 3:04 PM.";
    const hit = detectLimit("codex", text, now);
    expect(hit).toBeDefined();
    expect(hit?.resetAt).toEqual(new Date(2026, 9, 24, 15, 4));
  });

  it("codex: full date clock time", () => {
    const text = "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Oct 27th, 2026 9:00 AM.";
    const hit = detectLimit("codex", text, now);
    expect(hit).toBeDefined();
    expect(hit?.resetAt).toEqual(new Date(2026, 9, 27, 9, 0));
  });

  it("codex: relative time", () => {
    const text = "You've hit your usage limit. Try again in 2 hours 5 minutes.";
    const hit = detectLimit("codex", text, now);
    expect(hit).toBeDefined();
    expect(hit?.resetAt?.getTime()).toBe(now.getTime() + 7_500_000);
  });

  it("codex: 429 stream error", () => {
    const text = "stream error: exceeded retry limit, last status: 429 Too Many Requests";
    const hit = detectLimit("codex", text, now);
    expect(hit).toBeDefined();
    expect(hit?.resetAt).toBeUndefined();
  });

  it("agy: resource_exhausted with seconds", () => {
    const text = "Error: [429 Too Many Requests] RESOURCE_EXHAUSTED: Quota exceeded for quota metric 'Generate Content API requests per minute'. Please retry in 34.5s.";
    const hit = detectLimit("agy", text, now);
    expect(hit).toBeDefined();
    expect(hit?.resetAt?.getTime()).toBe(now.getTime() + 34_500);
  });

  it("agy: quota exhausted", () => {
    const text = "You have exhausted your daily quota on this model.";
    const hit = detectLimit("agy", text, now);
    expect(hit).toBeDefined();
    expect(hit?.resetAt).toBeUndefined();
  });

  it("negative: spawn error", () => {
    expect(detectLimit("claude", "Error: spawn claude ENOENT", now)).toBeUndefined();
  });

  it("negative: outside tail", () => {
    const text = "usage limit" + "x".repeat(5000);
    expect(detectLimit("codex", text, now)).toBeUndefined();
  });

  it("negative: undefined kind", () => {
    expect(detectLimit(undefined, "usage limit reached", now)).toBeUndefined();
  });

  it("negative: epoch in past", () => {
    const epoch = Math.floor(now.getTime() / 1000) - 86400;
    const text = `limit reached|${epoch}`;
    const hit = detectLimit("claude", text, now);
    expect(hit).toBeDefined();
    expect(hit?.resetAt).toBeUndefined();
  });

  it("parseResetTime: resets vs retry", () => {
    expect(parseResetTime("resets 1h2m", now)).toBeUndefined();
    expect(parseResetTime("retry in 1h2m", now)?.getTime()).toBe(now.getTime() + 3_720_000);
  });

  it("parseResetTime: clock time before now", () => {
    const morning = new Date(2026, 9, 24, 8, 0);
    expect(parseResetTime("resets 9am", morning)).toEqual(new Date(2026, 9, 24, 9, 0));
  });
});
