import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";
import { executeSteps } from "../extension/execute.js";

function dom(html: string) {
  return new JSDOM(html).window.document;
}

function domAt(html: string, url: string) {
  return new JSDOM(html, { url }).window.document;
}

describe("executeSteps", () => {
  it("read returns node text", () => {
    const doc = dom('<button id="b1">Hello</button>');
    const result = executeSteps(doc, [{ verb: "read", ref: "ref1" }]) as any;
    expect(result.results[0]).toEqual({ ok: true, value: "Hello" });
    expect(result.snapshot.nodes).toBeDefined();
    expect(Array.isArray(result.snapshot.nodes)).toBe(true);
  });

  it("trailing snapshot present on failure", () => {
    const doc = dom("<button>X</button>");
    const result = executeSteps(doc, [{ verb: "read", ref: "BOGUS" }]) as any;
    expect(result.results[0].ok).toBe(false);
    expect(result.snapshot).toBeDefined();
    expect(Array.isArray(result.snapshot.nodes)).toBe(true);
  });

  it("stops on first failure (mutation check)", () => {
    const doc = dom("<button>X</button>");
    const result = executeSteps(doc, [
      { verb: "read", ref: "BOGUS" },
      { verb: "read", ref: "ref1" },
    ]);
    // Only first step result, second never runs
    expect(result.results.length).toBe(1);
    expect(result.results[0].ok).toBe(false);
  });

  it("snapshot step returns ok:true", () => {
    const doc = dom("<button>X</button>");
    const result = executeSteps(doc, [{ verb: "snapshot" }]);
    expect(result.results[0]).toEqual({ ok: true });
    expect(result.snapshot).toBeDefined();
  });

  describe("mutating verbs — grant + origin gated", () => {
    it("refuses without a grant, DOM unchanged, names the origin", () => {
      const doc = domAt('<input type="text" value="original">', "https://github.com/");
      const input = doc.querySelector("input");
      const result = executeSteps(doc, [{ verb: "type", ref: "ref1", text: "injected" }], undefined, undefined);
      expect(result.results[0]).toEqual({ ok: false, error: "no act grant for https://github.com" });
      expect(input.value).toBe("original");
    });

    it("refuses on origin mismatch even with grant act (extension-side mutation check)", () => {
      const doc = domAt('<input type="text" value="original">', "https://evil.com/");
      const input = doc.querySelector("input");
      const result = executeSteps(doc, [{ verb: "type", ref: "ref1", text: "injected" }], "act", "https://github.com");
      expect(result.results[0].ok).toBe(false);
      expect(result.results[0].error).toContain("https://evil.com");
      expect(result.results[0].error).toContain("https://github.com");
      expect(input.value).toBe("original");
    });

    it("executes click when grant act and origin matches", () => {
      const doc = domAt('<button id="b1">Go</button>', "https://github.com/");
      let clicked = false;
      doc.querySelector("#b1").addEventListener("click", () => { clicked = true; });
      const result = executeSteps(doc, [{ verb: "click", ref: "ref1" }], "act", "https://github.com");
      expect(result.results[0]).toEqual({ ok: true });
      expect(clicked).toBe(true);
    });

    it("executes type (value + input/change) when grant act and origin matches", () => {
      const doc = domAt('<input type="text" value="">', "https://github.com/");
      const input = doc.querySelector("input");
      let changed = false;
      input.addEventListener("change", () => { changed = true; });
      const result = executeSteps(doc, [{ verb: "type", ref: "ref1", text: "hello" }], "act", "https://github.com");
      expect(result.results[0]).toEqual({ ok: true });
      expect(input.value).toBe("hello");
      expect(changed).toBe(true);
    });
  });

  it("hostile read returns literal value", () => {
    // Use entity-escaped content so the DOM preserves it
    const doc = dom("<button>`$&#123;x&#125;` &lt;script&gt;</button>");
    const result = executeSteps(doc, [{ verb: "read", ref: "ref1" }]) as any;
    // After entity decode, we expect literal backtick, ${x}, and <script>
    expect(result.results[0].value).toBe("`${x}` <script>");
  });

  it("read trims whitespace", () => {
    const doc = dom("<button>  spaced  </button>");
    const result = executeSteps(doc, [{ verb: "read", ref: "ref1" }]) as any;
    expect(result.results[0].value).toBe("spaced");
  });
});
