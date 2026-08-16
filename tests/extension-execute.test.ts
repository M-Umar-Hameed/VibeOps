import { describe, it, expect, vi } from "vitest";
import { JSDOM } from "jsdom";
import { executeSteps } from "../extension/execute.js";

function dom(html: string) {
  return new JSDOM(html).window.document;
}

function domAt(html: string, url: string) {
  return new JSDOM(html, { url }).window.document;
}

// Replace location.assign with a plain stub so assign() is observable and origin is
// controllable — jsdom's real location.assign is a no-op that never changes href.
function stubLocation(doc: any, origin: string, assign: (u: string) => void) {
  const sym = Object.getOwnPropertySymbols(doc)[0];
  if (sym && doc[sym]?._location) {
    doc[sym]._location.assign = assign;
  }
}

describe("executeSteps", () => {
  it("read returns node text", async () => {
    const doc = dom('<button id="b1">Hello</button>');
    const result = (await executeSteps(doc, [{ verb: "read", ref: "ref1" }])) as any;
    expect(result.results[0]).toEqual({ ok: true, value: "Hello" });
    expect(result.snapshot.nodes).toBeDefined();
    expect(Array.isArray(result.snapshot.nodes)).toBe(true);
  });

  it("trailing snapshot present on failure", async () => {
    const doc = dom("<button>X</button>");
    const result = (await executeSteps(doc, [{ verb: "read", ref: "BOGUS" }])) as any;
    expect(result.results[0].ok).toBe(false);
    expect(result.snapshot).toBeDefined();
    expect(Array.isArray(result.snapshot.nodes)).toBe(true);
  });

  it("stops on first failure (mutation check)", async () => {
    const doc = dom("<button>X</button>");
    const result = await executeSteps(doc, [
      { verb: "read", ref: "BOGUS" },
      { verb: "read", ref: "ref1" },
    ]);
    expect(result.results.length).toBe(1);
    expect(result.results[0].ok).toBe(false);
  });

  it("snapshot step returns ok:true", async () => {
    const doc = dom("<button>X</button>");
    const result = await executeSteps(doc, [{ verb: "snapshot" }]);
    expect(result.results[0]).toEqual({ ok: true });
    expect(result.snapshot).toBeDefined();
  });

  describe("mutating verbs — grant + origin gated", () => {
    it("refuses without a grant, DOM unchanged, names the origin", async () => {
      const doc = domAt('<input type="text" value="original">', "https://github.com/");
      const input = doc.querySelector("input") as any;
      const result = await executeSteps(doc, [{ verb: "type", ref: "ref1", text: "injected" }], undefined, undefined);
      expect(result.results[0]).toEqual({ ok: false, error: "no act grant for https://github.com" });
      expect(input.value).toBe("original");
    });

    it("refuses on origin mismatch even with grant act (extension-side mutation check)", async () => {
      const doc = domAt('<input type="text" value="original">', "https://evil.com/");
      const input = doc.querySelector("input") as any;
      const result = await executeSteps(doc, [{ verb: "type", ref: "ref1", text: "injected" }], "act", "https://github.com");
      expect(result.results[0].ok).toBe(false);
      expect(result.results[0].error).toContain("https://evil.com");
      expect(result.results[0].error).toContain("https://github.com");
      expect(input.value).toBe("original");
    });

    it("executes click when grant act and origin matches", async () => {
      const doc = domAt('<button id="b1">Go</button>', "https://github.com/");
      let clicked = false;
      doc.querySelector("#b1")!.addEventListener("click", () => { clicked = true; });
      const result = await executeSteps(doc, [{ verb: "click", ref: "ref1" }], "act", "https://github.com");
      expect(result.results[0]).toEqual({ ok: true });
      expect(clicked).toBe(true);
    });

    it("executes type (value + input/change) when grant act and origin matches", async () => {
      const doc = domAt('<input type="text" value="">', "https://github.com/");
      const input = doc.querySelector("input") as any;
      let changed = false;
      input.addEventListener("change", () => { changed = true; });
      const result = await executeSteps(doc, [{ verb: "type", ref: "ref1", text: "hello" }], "act", "https://github.com");
      expect(result.results[0]).toEqual({ ok: true });
      expect(input.value).toBe("hello");
      expect(changed).toBe(true);
    });
  });

  describe("navigate — grant + destination-origin gated", () => {
    it("refuses without an act grant, location untouched", async () => {
      const doc = domAt("<button>Go</button>", "https://github.com/");
      const assign = vi.fn();
      stubLocation(doc, "https://github.com", assign);
      const result = await executeSteps(doc, [{ verb: "navigate", url: "https://github.com/x" }], undefined, undefined);
      expect(result.results[0].ok).toBe(false);
      expect(assign).not.toHaveBeenCalled();
    });

    it("refuses when destination origin != targetOrigin, without touching location", async () => {
      const doc = domAt("<button>Go</button>", "https://github.com/");
      const assign = vi.fn();
      stubLocation(doc, "https://github.com", assign);
      const result = await executeSteps(doc, [{ verb: "navigate", url: "https://evil.com/x" }], "act", "https://github.com");
      expect(result.results[0].ok).toBe(false);
      expect(result.results[0].error).toContain("https://evil.com");
      expect(assign).not.toHaveBeenCalled();
    });

    it("granted navigate assigns location; subsequent step runs against the loaded document", async () => {
      const doc = domAt('<button id="start">Start</button>', "https://github.com/");
      const view = doc.defaultView as any;
      const assign = vi.fn((_url: string) => {
        // simulate the destination page loading into the tab, then fire load
        doc.body.innerHTML = '<button id="dest">Repo</button>';
        setTimeout(() => view.dispatchEvent(new view.Event("load")), 0);
      });
      stubLocation(doc, "https://github.com", assign);
      const result = await executeSteps(
        doc,
        [{ verb: "navigate", url: "https://github.com/org/repo" }, { verb: "read", ref: "ref1" }],
        "act",
        "https://github.com",
      );
      expect(assign).toHaveBeenCalledWith("https://github.com/org/repo");
      expect(result.results[0]).toEqual({ ok: true });
      expect(result.results[1]).toEqual({ ok: true, value: "Repo" });
    });
  });

  it("hostile read returns literal value", async () => {
    const doc = dom("<button>`$&#123;x&#125;` &lt;script&gt;</button>");
    const result = (await executeSteps(doc, [{ verb: "read", ref: "ref1" }])) as any;
    expect(result.results[0].value).toBe("`${x}` <script>");
  });

  it("read trims whitespace", async () => {
    const doc = dom("<button>  spaced  </button>");
    const result = (await executeSteps(doc, [{ verb: "read", ref: "ref1" }])) as any;
    expect(result.results[0].value).toBe("spaced");
  });
});
