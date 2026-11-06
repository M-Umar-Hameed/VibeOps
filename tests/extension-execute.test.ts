import { describe, it, expect, vi } from "vitest";
import { JSDOM } from "jsdom";
import { executeSteps, WAIT_TUNING } from "../extension/execute.js";

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
      expect(result.results[0]).toEqual({ ok: false, error: "no act grant for https://github.com", code: "no_grant" });
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

    it("executes type through prototype value setter on tracked inputs", async () => {
      const doc = domAt('<input type="text" value="">', "https://github.com/");
      const view = doc.defaultView as any;
      const input = doc.querySelector("input") as any;
      const native = Object.getOwnPropertyDescriptor(view.HTMLInputElement.prototype, "value")!;
      let tracked = "";
      Object.defineProperty(input, "value", {
        configurable: true,
        get() { return native.get!.call(this); },
        set(v) { tracked = v; native.set!.call(this, v); },
      });
      let seen: string | null = null;
      input.addEventListener("input", () => {
        if (input.value !== tracked) seen = input.value;
      });
      await executeSteps(doc, [{ verb: "type", ref: "ref1", text: "hello" }], "act", "https://github.com");
      expect(seen).toBe("hello");
      expect(doc.activeElement).toBe(input);
    });

    it("executes type on a non-contenteditable role=textbox div without throwing", async () => {
      const doc = domAt('<div role="textbox"></div>', "https://github.com/");
      const div = doc.querySelector("div") as any;
      let changed = false;
      div.addEventListener("change", () => { changed = true; });
      const result = await executeSteps(doc, [{ verb: "type", ref: "ref1", text: "hello" }], "act", "https://github.com");
      expect(result.results[0]).toEqual({ ok: true });
      expect(div.value).toBe("hello");
      expect(changed).toBe(true);
    });

    it("executes clickAt when grant act and origin matches", async () => {
      const doc = domAt('<button id="b">Go</button>', "https://github.com/");
      (doc as any).elementFromPoint = () => doc.querySelector("#b");
      let clicked = false;
      doc.querySelector("#b")!.addEventListener("click", () => { clicked = true; });
      const result = await executeSteps(doc, [{ verb: "clickAt", x: 1, y: 1 }], "act", "https://github.com");
      expect(result.results[0]).toEqual({ ok: true });
      expect(clicked).toBe(true);
    });

    it("refuses clickAt without a grant with no_grant, not unsupported_verb", async () => {
      const doc = domAt('<button id="b">Go</button>', "https://github.com/");
      const result = await executeSteps(doc, [{ verb: "clickAt", x: 1, y: 1 }], undefined, undefined);
      expect(result.results[0].code).toBe("no_grant");
    });

    it("executes click on role=option with mousedown, mouseup, and click events", async () => {
      const doc = domAt('<div role="option">Free</div>', "https://github.com/");
      const opt = doc.querySelector('[role="option"]') as any;
      const events: string[] = [];
      for (const t of ["mousedown", "mouseup", "click"]) {
        opt.addEventListener(t, () => events.push(t));
      }
      const result = await executeSteps(doc, [{ verb: "click", ref: "ref1" }], "act", "https://github.com");
      expect(result.results[0]).toEqual({ ok: true });
      expect(events).toEqual(["mousedown", "mouseup", "click"]);
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

describe("rich editors and real key events", () => {
  it("type into a contenteditable editor inserts the text and fires input", async () => {
    const doc = domAt('<div id="ed" contenteditable="true" role="textbox"></div>', "https://github.com");
    const seen: string[] = [];
    doc.getElementById("ed")!.addEventListener("input", (e: any) => seen.push(e.inputType ?? "input"));
    const result = (await executeSteps(doc, [{ verb: "type", ref: "ref1", text: "what is vibeops" }], "act", "https://github.com")) as any;
    expect(result.results[0]).toEqual({ ok: true });
    expect(doc.getElementById("ed")!.textContent).toBe("what is vibeops");
    expect(seen.length).toBeGreaterThan(0);
  });

  it("press dispatches keydown, keypress and keyup with code and keyCode on the focused element", async () => {
    const doc = domAt('<div id="ed" contenteditable="true" role="textbox"></div>', "https://github.com");
    const ed = doc.getElementById("ed") as any;
    ed.focus();
    const events: any[] = [];
    for (const t of ["keydown", "keypress", "keyup"]) ed.addEventListener(t, (e: any) => events.push({ t, key: e.key, code: e.code, keyCode: e.keyCode }));
    const result = (await executeSteps(doc, [{ verb: "press", key: "Enter" }], "act", "https://github.com")) as any;
    expect(result.results[0]).toEqual({ ok: true });
    expect(events.map((e) => e.t)).toEqual(["keydown", "keypress", "keyup"]);
    expect(events[0]).toMatchObject({ key: "Enter", code: "Enter", keyCode: 13 });
  });

  it("press Enter inside a form input submits the form when nobody prevents it", async () => {
    const doc = domAt('<form id="f"><input id="q" type="text" /></form>', "https://github.com");
    const form = doc.getElementById("f") as any;
    let submitted = 0;
    form.requestSubmit = () => { submitted++; };
    (doc.getElementById("q") as any).focus();
    await executeSteps(doc, [{ verb: "press", key: "Enter" }], "act", "https://github.com");
    expect(submitted).toBe(1);
  });

  it("press Enter does not submit when a handler prevents the keydown", async () => {
    const doc = domAt('<form id="f"><input id="q" type="text" /></form>', "https://github.com");
    const form = doc.getElementById("f") as any;
    let submitted = 0;
    form.requestSubmit = () => { submitted++; };
    const q = doc.getElementById("q") as any;
    q.addEventListener("keydown", (e: any) => e.preventDefault());
    q.focus();
    await executeSteps(doc, [{ verb: "press", key: "Enter" }], "act", "https://github.com");
    expect(submitted).toBe(0);
  });
  it("failures carry stable codes", async () => {
    const doc = domAt("<button>X</button>", "https://github.com/");
    const stale = (await executeSteps(doc, [{ verb: "read", ref: "BOGUS" }])) as any;
    expect(stale.results[0].code).toBe("stale_ref");
    const noGrant = (await executeSteps(doc, [{ verb: "click", ref: "ref1" }])) as any;
    expect(noGrant.results[0].code).toBe("no_grant");
    const unknown = (await executeSteps(doc, [{ verb: "bogusverb" }], "act", "https://github.com")) as any;
    expect(unknown.results[0].code).toBe("unsupported_verb");
    expect(unknown.results[0].error).toBe(
      'this extension build does not support the action "bogusverb" - update the extension from the latest release'
    );
  });
  it("wait succeeds when text appears and times out with a code otherwise", async () => {
    const saved = { ...WAIT_TUNING };
    WAIT_TUNING.timeoutMs = 300;
    WAIT_TUNING.pollMs = 20;
    try {
      const doc = dom("<body><p>Loading</p></body>");
      setTimeout(() => { doc.body.append("Done"); }, 50);
      const ok = (await executeSteps(doc, [{ verb: "wait", text: "Done" }])) as any;
      expect(ok.results[0]).toEqual({ ok: true });
      const never = (await executeSteps(dom("<body>x</body>"), [{ verb: "wait", text: "Nope" }])) as any;
      expect(never.results[0].ok).toBe(false);
      expect(never.results[0].code).toBe("wait_timeout");
    } finally {
      Object.assign(WAIT_TUNING, saved);
    }
  });
});

describe("scroll verb and scrollIntoView centering", () => {
  it("scroll by ref calls scrollIntoView with center block", async () => {
    const doc = dom('<button id="b">A</button>');
    const btn = doc.querySelector("#b") as any;
    btn.scrollIntoView = vi.fn();
    const result = await executeSteps(doc, [{ verb: "scroll", ref: "ref1" }]);
    expect(result.results[0]).toEqual({ ok: true });
    expect(btn.scrollIntoView).toHaveBeenCalledWith({ block: "center" });
  });

  it("scroll by dy calls scrollBy with 0, dy", async () => {
    const doc = dom('<button id="b">A</button>');
    const view = doc.defaultView as any;
    view.scrollBy = vi.fn();
    const result = await executeSteps(doc, [{ verb: "scroll", dy: 500 }]);
    expect(result.results[0]).toEqual({ ok: true });
    expect(view.scrollBy).toHaveBeenCalledWith(0, 500);
  });

  it("scroll with stale ref returns stale_ref", async () => {
    const doc = dom('<button id="b">A</button>');
    const result = await executeSteps(doc, [{ verb: "scroll", ref: "BOGUS" }]);
    expect(result.results[0].code).toBe("stale_ref");
  });

  it("click and type call scrollIntoView({ block: 'center' }) on target", async () => {
    const doc = domAt('<button id="b">Go</button><input id="i" type="text">', "https://github.com/");
    const btn = doc.querySelector("#b") as any;
    const input = doc.querySelector("#i") as any;
    btn.scrollIntoView = vi.fn();
    input.scrollIntoView = vi.fn();
    await executeSteps(doc, [{ verb: "click", ref: "ref1" }], "act", "https://github.com");
    expect(btn.scrollIntoView).toHaveBeenCalledWith({ block: "center" });
    await executeSteps(doc, [{ verb: "type", ref: "ref2", text: "hi" }], "act", "https://github.com");
    expect(input.scrollIntoView).toHaveBeenCalledWith({ block: "center" });
  });
});

describe("trusted mode (CDP prepare)", () => {
  it("click prepares CDP coordinates, does not call click listener, stops early, and returns null snapshot", async () => {
    const doc = domAt('<button id="b1">Go</button><button id="b2">Read me</button>', "https://github.com/");
    const btn = doc.querySelector("#b1") as any;
    (doc as any).elementFromPoint = () => btn;
    btn.getBoundingClientRect = () => ({ left: 10, top: 20, width: 100, height: 40 });
    let clicked = false;
    btn.addEventListener("click", () => { clicked = true; });
    const out = (await executeSteps(
      doc,
      [{ verb: "click", ref: "ref1" }, { verb: "read", ref: "ref2" }],
      "act",
      "https://github.com",
      { trusted: true }
    )) as any;
    expect(out.results.length).toBe(1);
    expect(out.results[0]).toEqual({ ok: true, cdp: { verb: "click", x: 60, y: 40 } });
    expect(clicked).toBe(false);
    expect(out.snapshot).toBeNull();
  });

  it("covered target returns not_hittable and does not fire click listener", async () => {
    const doc = domAt('<button id="b1">Go</button><div id="overlay">Over</div>', "https://github.com/");
    const btn = doc.querySelector("#b1") as any;
    const overlay = doc.querySelector("#overlay") as any;
    (doc as any).elementFromPoint = () => overlay;
    btn.getBoundingClientRect = () => ({ left: 10, top: 20, width: 100, height: 40 });
    let clicked = false;
    btn.addEventListener("click", () => { clicked = true; });
    const out = (await executeSteps(
      doc,
      [{ verb: "click", ref: "ref1" }],
      "act",
      "https://github.com",
      { trusted: true }
    )) as any;
    expect(out.results.length).toBe(1);
    expect(out.results[0]).toEqual({
      ok: false,
      error: "element ref1 is covered at (60,40) by <div> - scroll, close the overlay, or take a fresh snapshot",
      code: "not_hittable",
    });
    expect(out.results[0].cdp).toBeUndefined();
    expect(clicked).toBe(false);
  });

  it("hit on a child element counts as hittable and returns cdp", async () => {
    const doc = domAt('<button id="b1"><span id="s1">Go</span></button>', "https://github.com/");
    const btn = doc.querySelector("#b1") as any;
    const span = doc.querySelector("#s1") as any;
    (doc as any).elementFromPoint = () => span;
    btn.getBoundingClientRect = () => ({ left: 10, top: 20, width: 100, height: 40 });
    const out = (await executeSteps(
      doc,
      [{ verb: "click", ref: "ref1" }],
      "act",
      "https://github.com",
      { trusted: true }
    )) as any;
    expect(out.results.length).toBe(1);
    expect(out.results[0]).toEqual({ ok: true, cdp: { verb: "click", x: 60, y: 40 } });
  });

  it("elementFromPoint returning null returns not_hittable", async () => {
    const doc = domAt('<button id="b1">Go</button>', "https://github.com/");
    const btn = doc.querySelector("#b1") as any;
    (doc as any).elementFromPoint = () => null;
    btn.getBoundingClientRect = () => ({ left: 10, top: 20, width: 100, height: 40 });
    const out = (await executeSteps(
      doc,
      [{ verb: "click", ref: "ref1" }],
      "act",
      "https://github.com",
      { trusted: true }
    )) as any;
    expect(out.results.length).toBe(1);
    expect(out.results[0]).toEqual({
      ok: false,
      error: "element ref1 is covered at (60,40) - scroll, close the overlay, or take a fresh snapshot",
      code: "not_hittable",
    });
  });

  it("click with zero-size rect falls back to synthetic", async () => {
    const doc = domAt('<button id="b1">Go</button>', "https://github.com/");
    const btn = doc.querySelector("#b1") as any;
    let clicked = false;
    btn.addEventListener("click", () => { clicked = true; });
    const out = (await executeSteps(
      doc,
      [{ verb: "click", ref: "ref1" }],
      "act",
      "https://github.com",
      { trusted: true }
    )) as any;
    expect(clicked).toBe(true);
    expect(out.results[0]).toEqual({ ok: true });
    expect(out.results[0].cdp).toBeUndefined();
  });

  it("type into input prepares CDP type, focuses element, selects content, keeps value", async () => {
    const doc = domAt('<input type="text" value="old">', "https://github.com/");
    const input = doc.querySelector("input") as any;
    const out = (await executeSteps(
      doc,
      [{ verb: "type", ref: "ref1", text: "new" }],
      "act",
      "https://github.com",
      { trusted: true }
    )) as any;
    expect(out.results[0]).toEqual({ ok: true, cdp: { verb: "type", text: "new" } });
    expect(doc.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(3);
    expect(input.value).toBe("old");
  });

  it("trusted type without grant returns no_grant without cdp field and leaves value unchanged", async () => {
    const doc = domAt('<input type="text" value="old">', "https://github.com/");
    const input = doc.querySelector("input") as any;
    const out = (await executeSteps(
      doc,
      [{ verb: "type", ref: "ref1", text: "new" }],
      undefined,
      undefined,
      { trusted: true }
    )) as any;
    expect(out.results[0].code).toBe("no_grant");
    expect(out.results[0].cdp).toBeUndefined();
    expect(input.value).toBe("old");
  });

  it("trusted click on origin mismatch returns origin_mismatch without cdp", async () => {
    const doc = domAt('<button id="b1">Go</button>', "https://evil.com/");
    const btn = doc.querySelector("#b1") as any;
    btn.getBoundingClientRect = () => ({ left: 10, top: 20, width: 100, height: 40 });
    const out = (await executeSteps(
      doc,
      [{ verb: "click", ref: "ref1" }],
      "act",
      "https://github.com",
      { trusted: true }
    )) as any;
    expect(out.results[0].code).toBe("origin_mismatch");
    expect(out.results[0].cdp).toBeUndefined();
  });

  it("press Enter prepares CDP press without dispatching keydown", async () => {
    const doc = domAt('<input type="text">', "https://github.com/");
    const input = doc.querySelector("input") as any;
    input.focus();
    let keydownDispatched = false;
    input.addEventListener("keydown", () => { keydownDispatched = true; });
    const out = (await executeSteps(
      doc,
      [{ verb: "press", key: "Enter" }],
      "act",
      "https://github.com",
      { trusted: true }
    )) as any;
    expect(out.results[0]).toEqual({ ok: true, cdp: { verb: "press", key: "Enter" } });
    expect(keydownDispatched).toBe(false);
  });

  it("scroll dy prepares CDP scroll while scroll ref returns ok:true without cdp", async () => {
    const doc = domAt('<button id="b1">Go</button>', "https://github.com/");
    const view = doc.defaultView as any;
    const outDy = (await executeSteps(
      doc,
      [{ verb: "scroll", dy: 300 }],
      "act",
      "https://github.com",
      { trusted: true }
    )) as any;
    expect(outDy.results[0]).toEqual({
      ok: true,
      cdp: { verb: "scroll", dy: 300, w: view.innerWidth, h: view.innerHeight },
    });

    const outRef = (await executeSteps(
      doc,
      [{ verb: "scroll", ref: "ref1" }],
      "act",
      "https://github.com",
      { trusted: true }
    )) as any;
    expect(outRef.results[0]).toEqual({ ok: true });
    expect(outRef.results[0].cdp).toBeUndefined();
  });

  it("clickAt outside the viewport returns out_of_viewport in trusted mode", async () => {
    const doc = domAt("<body></body>", "https://github.com/");
    const view = doc.defaultView as any;
    view.innerWidth = 800;
    view.innerHeight = 600;
    const out = (await executeSteps(
      doc,
      [{ verb: "clickAt", x: 9999, y: 9999 }],
      "act",
      "https://github.com",
      { trusted: true }
    )) as any;
    expect(out.results[0].code).toBe("out_of_viewport");
    expect(out.results[0].cdp).toBeUndefined();
  });

  it("refMap reuse resolves against initial snapshot map across DOM changes", async () => {
    const doc = domAt('<div id="container"><button id="a">A</button></div>', "https://github.com/");
    const initial = (await executeSteps(
      doc,
      [{ verb: "read", ref: "ref1" }],
      "act",
      "https://github.com"
    )) as any;
    expect(initial.refMap.get("ref1").id).toBe("a");

    const btnZ = doc.createElement("button");
    btnZ.id = "z";
    btnZ.textContent = "Z";
    doc.querySelector("#container")!.insertBefore(btnZ, doc.querySelector("#a"));

    const reused = (await executeSteps(
      doc,
      [{ verb: "read", ref: "ref1" }],
      "act",
      "https://github.com",
      { refMap: initial.refMap }
    )) as any;
    expect(reused.results[0].value).toBe("A");
  });
});
