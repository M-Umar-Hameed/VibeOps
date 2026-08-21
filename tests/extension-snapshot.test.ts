import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";
import { buildSnapshot, collectInteractive } from "../extension/snapshot.js";

function dom(html: string) {
  return new JSDOM(html).window.document;
}

describe("buildSnapshot", () => {
  it("pure-text page yields empty nodes list", () => {
    const doc = dom("<html><body><h1>Title</h1><p>Some paragraph</p></body></html>");
    const snap = buildSnapshot(doc, "inst1");
    expect(snap.nodes.length).toBe(0);
  });

  it("returns interactive elements only", () => {
    const doc = dom(`
      <html><body>
        <h1>Title</h1>
        <p>Text</p>
        <button>Click</button>
        <a href="/foo">Link</a>
        <input type="text" value="test">
        <div>Not interactive</div>
      </body></html>
    `);
    const snap = buildSnapshot(doc, "inst1");
    expect(snap.nodes.length).toBe(3);
    expect(snap.nodes.map((n: any) => n.role).sort()).toEqual(["button", "link", "textbox"]);
  });

  describe("accessible name precedence", () => {
    it("aria-label wins over text content", () => {
      const doc = dom('<button aria-label="A">B</button>');
      const snap = buildSnapshot(doc, "inst1");
      expect(snap.nodes[0].name).toBe("A");
    });

    it("label[for] wins when no aria-label", () => {
      const doc = dom('<label for="x">Email</label><input id="x" type="text">');
      const snap = buildSnapshot(doc, "inst1");
      expect(snap.nodes[0].name).toBe("Email");
    });

    it("text content fallback", () => {
      const doc = dom("<button>Click me</button>");
      const snap = buildSnapshot(doc, "inst1");
      expect(snap.nodes[0].name).toBe("Click me");
    });

    it("aria-label beats label[for]", () => {
      const doc = dom('<label for="x">From label</label><input id="x" aria-label="From aria" type="text">');
      const snap = buildSnapshot(doc, "inst1");
      expect(snap.nodes[0].name).toBe("From aria");
    });
  });

  describe("value and state", () => {
    it("captures input value", () => {
      const doc = dom('<input type="text" value="v">');
      const snap = buildSnapshot(doc, "inst1");
      expect(snap.nodes[0].value).toBe("v");
    });

    it("captures disabled state", () => {
      const doc = dom("<button disabled>Go</button>");
      const snap = buildSnapshot(doc, "inst1");
      expect(snap.nodes[0].state).toContain("disabled");
    });

    it("captures aria-disabled state", () => {
      const doc = dom('<button aria-disabled="true">Go</button>');
      const snap = buildSnapshot(doc, "inst1");
      expect(snap.nodes[0].state).toContain("disabled");
    });

    it("captures checked state for checkbox", () => {
      const doc = dom('<input type="checkbox" checked>');
      const snap = buildSnapshot(doc, "inst1");
      expect(snap.nodes[0].state).toContain("checked");
    });

    it("captures expanded state", () => {
      const doc = dom('<button aria-expanded="true">Menu</button>');
      const snap = buildSnapshot(doc, "inst1");
      expect(snap.nodes[0].state).toContain("expanded");
    });

    it("omits state when empty", () => {
      const doc = dom("<button>Normal</button>");
      const snap = buildSnapshot(doc, "inst1");
      expect(snap.nodes[0].state).toBeUndefined();
    });
  });

  describe("anchor", () => {
    it("builds anchor from landmarks", () => {
      const doc = dom(`
        <main>
          <form aria-label="Login">
            <button>Go</button>
          </form>
        </main>
      `);
      const snap = buildSnapshot(doc, "inst1");
      expect(snap.nodes[0].anchor).toBe("main>form[Login]");
    });

    it("falls back to heading when no landmark", () => {
      const doc = dom(`
        <div>
          <h2>Section Title</h2>
          <button>Action</button>
        </div>
      `);
      const snap = buildSnapshot(doc, "inst1");
      expect(snap.nodes[0].anchor).toBe("h2[Section Title]");
    });

    it("empty anchor when no landmark or heading", () => {
      const doc = dom("<div><button>Orphan</button></div>");
      const snap = buildSnapshot(doc, "inst1");
      expect(snap.nodes[0].anchor).toBe("");
    });
  });

  it("refs assigned in document order starting at ref1", () => {
    const doc = dom(`
      <button>First</button>
      <button>Second</button>
      <button>Third</button>
    `);
    const snap = buildSnapshot(doc, "inst1");
    expect(snap.nodes.map((n: any) => n.ref)).toEqual(["ref1", "ref2", "ref3"]);
  });

  it("identity is null, origin is string", () => {
    const doc = dom("<button>X</button>");
    const snap = buildSnapshot(doc, "inst1");
    expect(snap.identity).toBe(null);
    expect(typeof snap.origin).toBe("string");
  });

  it("hostile page content survives verbatim and nothing evaluates", () => {
    const hostile = `"><script>window.__pwned=1</script> \${x} \`bt\``;
    const doc = dom(`<button aria-label="${hostile.replace(/"/g, "&quot;")}">Safe</button>`);
    const snap = buildSnapshot(doc, "inst1");
    expect(snap.nodes[0].name).toBe(hostile);
    expect((new JSDOM(doc.documentElement.outerHTML).window as any).__pwned).toBeUndefined();
  });
});

describe("T1: rects and viewport metadata", () => {
  it("carries viewport metadata captured with the rects", () => {
    const doc = dom("<html><body><button>Go</button></body></html>");
    const snap = buildSnapshot(doc, "inst1") as any;
    expect(snap.viewport).toBeDefined();
    // dpr is the load-bearing one: captureVisibleTab is physical px, rects are CSS px.
    expect(typeof snap.viewport.dpr).toBe("number");
    expect(snap.viewport.dpr).toBeGreaterThan(0);
    for (const k of ["scrollX", "scrollY", "viewportW", "viewportH"]) {
      expect(typeof snap.viewport[k]).toBe("number");
    }
  });

  it("every node carries a rect field", () => {
    const doc = dom(`<html><body><button>A</button><a href="/x">B</a></body></html>`);
    const snap = buildSnapshot(doc, "inst1") as any;
    expect(snap.nodes.length).toBe(2);
    for (const n of snap.nodes) expect("rect" in n).toBe(true);
  });

  it("a zero-size element records rect null, not a zero box", () => {
    // jsdom gives every element a 0x0 rect, which is exactly the absent case.
    const doc = dom("<html><body><button>Hidden</button></body></html>");
    const snap = buildSnapshot(doc, "inst1") as any;
    expect(snap.nodes[0].rect).toBeNull();
  });

  it("a laid-out element records a page-coordinate box including scroll", () => {
    const doc = dom("<html><body><button>Go</button></body></html>");
    const el = doc.querySelector("button")!;
    (el as any).getBoundingClientRect = () => ({ left: 10, top: 20, width: 30, height: 40 });
    Object.defineProperty(doc.defaultView!, "scrollX", { value: 100, configurable: true });
    Object.defineProperty(doc.defaultView!, "scrollY", { value: 200, configurable: true });
    const snap = buildSnapshot(doc, "inst1") as any;
    expect(snap.nodes[0].rect).toEqual({ x: 110, y: 220, w: 30, h: 40 });
  });
});
