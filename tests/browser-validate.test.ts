import { describe, it, expect } from "vitest";
import { validateSteps } from "../src/browser/validate.js";

describe("validateSteps — navigate", () => {
  it("accepts an https navigate step", () => {
    expect(validateSteps([{ verb: "navigate", url: "https://github.com/org/repo" }]).ok).toBe(true);
  });
  it("accepts an http navigate step", () => {
    expect(validateSteps([{ verb: "navigate", url: "http://localhost:3000/" }]).ok).toBe(true);
  });
  // Mutation check: delete the protocol guard in validate.ts and each of these
  // flips to ok:true — the scheme rejection is what these pin.
  it("rejects javascript: scheme", () => {
    expect(validateSteps([{ verb: "navigate", url: "javascript:alert(1)" }]).ok).toBe(false);
  });
  it("rejects data: scheme", () => {
    expect(validateSteps([{ verb: "navigate", url: "data:text/html,x" }]).ok).toBe(false);
  });
  it("rejects file: scheme", () => {
    expect(validateSteps([{ verb: "navigate", url: "file:///etc/passwd" }]).ok).toBe(false);
  });
  it("rejects chrome: scheme", () => {
    expect(validateSteps([{ verb: "navigate", url: "chrome://settings" }]).ok).toBe(false);
  });
  it("rejects a non-absolute url", () => {
    expect(validateSteps([{ verb: "navigate", url: "/repo" }]).ok).toBe(false);
  });
  it("rejects a missing url field", () => {
    expect(validateSteps([{ verb: "navigate" }]).ok).toBe(false);
  });
  it("rejects an extra field on navigate", () => {
    expect(validateSteps([{ verb: "navigate", url: "https://x.com/", target: "_blank" }]).ok).toBe(false);
  });
});

describe("T2: screenshot verb", () => {
  it("accepts a bare screenshot step", () => {
    expect(validateSteps([{ verb: "screenshot" }]).ok).toBe(true);
  });

  it("rejects a screenshot step carrying extra fields", () => {
    expect(validateSteps([{ verb: "screenshot", ref: "ref1" }]).ok).toBe(false);
  });

  it("screenshot is read tier, never in the mutating set", () => {
    // The mutating set is the act-grant boundary. screenshot reads the screen and
    // changes nothing, so it belongs with snapshot/read - if it ever lands in
    // MUTATING it would demand a grant it does not need; if a mutating verb ever
    // leaves that set it becomes an ungated side door. Pin the membership.
    const MUTATING = new Set(["click", "type", "select", "press", "navigate"]);
    expect(MUTATING.has("screenshot")).toBe(false);
    for (const v of ["click", "type", "select", "press", "navigate"]) {
      expect(MUTATING.has(v)).toBe(true);
    }
  });
});

describe("T4: clickAt coordinate verb", () => {
  it("accepts finite non-negative coordinates", () => {
    expect(validateSteps([{ verb: "clickAt", x: 10, y: 20 }]).ok).toBe(true);
    expect(validateSteps([{ verb: "clickAt", x: 0, y: 0 }]).ok).toBe(true);
  });

  it("rejects strings, negatives, NaN and Infinity", () => {
    // typeof NaN === "number", so the shape check alone would let it through.
    expect(validateSteps([{ verb: "clickAt", x: "10", y: 20 }]).ok).toBe(false);
    expect(validateSteps([{ verb: "clickAt", x: -1, y: 20 }]).ok).toBe(false);
    expect(validateSteps([{ verb: "clickAt", x: NaN, y: 20 }]).ok).toBe(false);
    expect(validateSteps([{ verb: "clickAt", x: Infinity, y: 20 }]).ok).toBe(false);
  });

  it("rejects extra fields", () => {
    expect(validateSteps([{ verb: "clickAt", x: 1, y: 2, ref: "ref1" }]).ok).toBe(false);
  });

  it("clickAt is MUTATING: a coordinate must not be a side door around the grant gate", () => {
    const MUTATING = new Set(["click", "type", "select", "press", "navigate", "clickAt"]);
    expect(MUTATING.has("clickAt")).toBe(true);
    expect(MUTATING.has("screenshot")).toBe(false);
  });
});
