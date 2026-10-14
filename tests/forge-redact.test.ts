import { describe, it, expect } from "vitest";
import { redactSecrets, findSecrets, registerEnvSecrets } from "../src/forge/redact.js";

describe("redactSecrets", () => {
  it("redacts common key shapes", () => {
    expect(redactSecrets("key sk-abcdefghij0123456789 ok")).toBe("key [redacted] ok");
    expect(redactSecrets("voyage pa-AbCd_efgh-ij0123456789")).toBe("voyage [redacted]");
    expect(redactSecrets("Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.x.y")).toBe(
      "Authorization: [redacted]",
    );
    expect(redactSecrets('{"apiKey":"supersecretvalue123"}')).toBe('{"apiKey":"[redacted]"}');
  });
  it("leaves ordinary text alone", () => {
    const s = "git diff --stat shows 3 files, task passed";
    expect(redactSecrets(s)).toBe(s);
  });
});

describe("findSecrets", () => {
  it("returns redacted previews for each pattern hit", () => {
    const sk = "sk-" + "a".repeat(30);
    const pa = "pa-" + "b".repeat(30);
    const bearer = "Bearer " + "c".repeat(30);
    expect(findSecrets(sk).length).toBe(1);
    expect(findSecrets(pa).length).toBe(1);
    expect(findSecrets(bearer).length).toBe(1);
    // key-field pattern
    expect(findSecrets('{"apiKey":"supersecret1234567890"}').length).toBe(1);
  });
  it("preview never contains the full secret", () => {
    const secret = "sk-" + "x".repeat(50);
    const hits = findSecrets(secret);
    expect(hits[0].length).toBeLessThan(secret.length);
    expect(hits[0].endsWith("…")).toBe(true);
    expect(hits[0]).not.toContain(secret);
  });
  it("returns empty for clean text", () => {
    expect(findSecrets("no secrets here")).toEqual([]);
  });
});

describe("registerEnvSecrets", () => {
  it("redacts values of matching env var names and ignores short/non-secret values", () => {
    registerEnvSecrets({ DEMO_SHOP_PASSWORD: "hunter2-demo", API_KEY: "k3y-value", PLAIN: "visible-value", SHORT_TOKEN: "abc" });
    expect(redactSecrets("pw hunter2-demo k3y-value visible-value abc")).toBe("pw [redacted] [redacted] visible-value abc");
  });

  it("handles undefined without throwing", () => {
    expect(() => registerEnvSecrets(undefined)).not.toThrow();
  });

  it("moves re-registered value to newest slot so it survives 300 further registrations", () => {
    registerEnvSecrets({ INITIAL_TOKEN: "kept-token" });
    for (let i = 0; i < 100; i++) registerEnvSecrets({ [`PRE_${i}_TOKEN`]: "tok-" + i });
    registerEnvSecrets({ RE_TOKEN: "kept-token" });
    for (let i = 100; i < 300; i++) registerEnvSecrets({ [`POST_${i}_TOKEN`]: "tok-" + i });
    expect(redactSecrets("kept-token")).toBe("[redacted]");
    expect(redactSecrets("tok-0")).toBe("tok-0");
  });
});
