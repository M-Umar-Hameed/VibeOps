import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";
import { executeSteps } from "../extension/execute.js";

function dom(html: string) {
  return new JSDOM(html).window.document;
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

  describe("mutating verbs refused and DOM unchanged", () => {
    it("click refused", () => {
      const doc = dom('<input type="text" value="original">');
      const input = doc.querySelector("input");
      const originalValue = input.value;

      const result = executeSteps(doc, [
        { verb: "click", ref: "ref1" },
        { verb: "read", ref: "ref1" },
      ]);

      expect(result.results.length).toBe(1);
      expect(result.results[0]).toEqual({
        ok: false,
        error: "verb not enabled until grants land",
      });
      expect(input.value).toBe(originalValue);
    });

    it("type refused", () => {
      const doc = dom('<input type="text" value="original">');
      const input = doc.querySelector("input");
      const originalValue = input.value;

      const result = executeSteps(doc, [
        { verb: "type", ref: "ref1", text: "injected" },
        { verb: "read", ref: "ref1" },
      ]);

      expect(result.results.length).toBe(1);
      expect(result.results[0]).toEqual({
        ok: false,
        error: "verb not enabled until grants land",
      });
      expect(input.value).toBe(originalValue);
    });

    it("select refused", () => {
      const doc = dom(`
        <select>
          <option value="a">A</option>
          <option value="b" selected>B</option>
        </select>
      `);
      const select = doc.querySelector("select");
      const originalValue = select.value;

      const result = executeSteps(doc, [
        { verb: "select", ref: "ref1", option: "a" },
        { verb: "read", ref: "ref1" },
      ]);

      expect(result.results.length).toBe(1);
      expect(result.results[0]).toEqual({
        ok: false,
        error: "verb not enabled until grants land",
      });
      expect(select.value).toBe(originalValue);
    });

    it("press refused", () => {
      const doc = dom('<input type="text" value="original">');
      const input = doc.querySelector("input");
      const originalValue = input.value;

      const result = executeSteps(doc, [
        { verb: "press", key: "Enter" },
        { verb: "read", ref: "ref1" },
      ]);

      expect(result.results.length).toBe(1);
      expect(result.results[0]).toEqual({
        ok: false,
        error: "verb not enabled until grants land",
      });
      expect(input.value).toBe(originalValue);
    });
  });

  it("hostile read returns literal value", () => {
    // Use entity-escaped content so the DOM preserves it
    const doc = dom("<button>`$&#123;x&#125;` &lt;script&gt;</button>");
    const result = executeSteps(doc, [{ verb: "read", ref: "ref1" }]);
    // After entity decode, we expect literal backtick, ${x}, and <script>
    expect(result.results[0].value).toBe("`${x}` <script>");
  });

  it("read trims whitespace", () => {
    const doc = dom("<button>  spaced  </button>");
    const result = executeSteps(doc, [{ verb: "read", ref: "ref1" }]);
    expect(result.results[0].value).toBe("spaced");
  });
});
