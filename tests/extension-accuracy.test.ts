// Accuracy baseline for UI automation (browser extension 1/2). Measurement only:
// every known gap is an `it.fails` titled "GAP: ..." - it turns red when the gap
// is closed, and 2/2 flips it to `it`. Each case also has a passing fixture-sanity
// test so a broken fixture cannot hide inside an `it.fails`.
import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildSnapshot, collectInteractive } from "../extension/snapshot.js";
import { executeSteps } from "../extension/execute.js";
import { benchPage } from "../e2e/bench-pages.mjs";

const ORIGIN = "https://app.test";
const FIX = new URL("./fixtures/extension-accuracy/", import.meta.url);
const box = (left: number, top: number, width: number, height: number) =>
  ({ left, top, right: left + width, bottom: top + height, width, height, x: left, y: top });
const RECT = box(10, 20, 100, 40);
const ZERO = box(0, 0, 0, 0);

const load = (name: string): any =>
  new JSDOM(readFileSync(fileURLToPath(new URL(name, FIX)), "utf8"), { url: `${ORIGIN}/` }).window.document;
const nodes = (doc: any): any[] => buildSnapshot(doc, "").nodes;
const names = (doc: any): string[] => nodes(doc).map((n) => n.name);
function refFor(doc: any, name: string): string {
  const n = nodes(doc).find((x) => x.name === name);
  if (!n) throw new Error(`snapshot offers no node named "${name}"`);
  return n.ref;
}
// act grant; target = the document's own origin (an about:blank iframe included)
const run = (doc: any, steps: any[], opts: any = {}): Promise<any> =>
  executeSteps(doc, steps, "act", doc.location?.origin ?? "", opts);
const act = async (doc: any, steps: any[], opts: any = {}): Promise<any> => (await run(doc, steps, opts)).results[0];
const click = (ref: string) => ({ verb: "click", ref });
function frameDoc(doc: any): any {
  const d = doc.getElementById("f").contentDocument;
  if (!d) throw new Error("iframe has no contentDocument");
  d.body.append(d.importNode(doc.getElementById("inner").content, true));
  return d;
}
const track = (el: any, log: string[], tag: string) => el.addEventListener("click", () => log.push(tag));

describe("shadow root", () => {
  function setup() {
    const doc = load("shadow-root.html");
    const root = doc.getElementById("host").attachShadow({ mode: "open" });
    root.append(doc.importNode(doc.getElementById("inner").content, true));
    const hits: string[] = [];
    track(root.querySelector("button"), hits, "shadow");
    return { doc, root, hits };
  }
  it("fixture: shadow root holds the target, light button is listed", () => {
    const { doc, root } = setup();
    expect(root.querySelector("button").textContent).toBe("Shadow target");
    expect(names(doc)).toContain("Light button");
  });
  it("snapshot lists the shadow button", () => {
    expect(names(setup().doc)).toContain("Shadow target");
  });
  it("click on its ref reaches the shadow button", async () => {
    const { doc, hits } = setup();
    const r = await act(doc, [click(refFor(doc, "Shadow target"))]);
    expect(r.ok).toBe(true);
    expect(hits).toEqual(["shadow"]);
  });
});

describe("same-origin iframe", () => {
  function setup() {
    const doc = load("same-origin-iframe.html");
    const fd = frameDoc(doc);
    const hits: string[] = [];
    track(fd.querySelector("button"), hits, "framed");
    return { doc, fd, hits };
  }
  it("fixture: frame document holds the button, top button is listed", () => {
    const { doc, fd } = setup();
    expect(fd.querySelector("button").textContent).toBe("Framed button");
    expect(names(doc)).toContain("Top button");
  });
  it("top-level snapshot lists the framed button", () => {
    expect(names(setup().doc)).toContain("Framed button");
  });
  it("click via a top-level ref reaches the framed button", async () => {
    const { doc, hits } = setup();
    const r = await act(doc, [click(refFor(doc, "Framed button"))]);
    expect(r.ok).toBe(true);
    expect(hits).toEqual(["framed"]);
  });
});

describe("hidden elements", () => {
  function setup() {
    const doc = load("hidden.html");
    doc.defaultView.Element.prototype.getBoundingClientRect = function () {
      return this.textContent === "Zero size" ? ZERO : RECT;
    };
    const hits: string[] = [];
    for (const b of doc.querySelectorAll("button")) track(b, hits, b.textContent);
    return { doc, hits };
  }
  it("fixture: Visible is listed and styles are applied", () => {
    const { doc } = setup();
    expect(names(doc)).toContain("Visible");
    const none = [...doc.querySelectorAll("button")].find((b: any) => b.textContent === "Display none");
    expect(doc.defaultView.getComputedStyle(none).display).toBe("none");
  });
  it("display:none is not offered", () => {
    expect(names(setup().doc)).not.toContain("Display none");
  });
  it("visibility:hidden is not offered", () => {
    expect(names(setup().doc)).not.toContain("Visibility hidden");
  });
  it("aria-hidden subtree is not offered", () => {
    expect(names(setup().doc)).not.toContain("Aria hidden");
  });
  // Stays a gap: jsdom reports 0x0 for every element, so a size filter cannot be checked here,
  // and zero-size controls keep the synthetic path (execute.js prepareTrusted).
  it.fails("GAP: zero-size is not offered", () => {
    expect(names(setup().doc)).not.toContain("Zero size");
  });
  it("no ref reaches the display:none button", async () => {
    const { doc, hits } = setup();
    const count = collectInteractive(doc).length;
    for (let i = 1; i <= count + 1; i++) await act(doc, [click(`ref${i}`)]);
    expect(hits).not.toContain("Display none");
  });
});

describe("stale ref", () => {
  const setup = () => {
    const doc = load("stale-ref.html");
    const hits: string[] = [];
    const [save] = doc.querySelectorAll("button");
    track(save, hits, "save");
    return { doc, save, hits };
  };
  it("out-of-range ref returns stale_ref; Save is ref1", async () => {
    const { doc } = setup();
    expect((await act(doc, [click("ref9")])).code).toBe("stale_ref");
    expect(refFor(doc, "Save")).toBe("ref1");
  });
  it("re-rendered element with a resumed refMap returns stale_ref", async () => {
    const { doc, save } = setup();
    const first = await run(doc, [{ verb: "snapshot" }]);
    save.replaceWith(save.cloneNode(true));
    const r = await act(doc, [click("ref1")], { refMap: first.refMap });
    expect(r.code).toBe("stale_ref");
  });
  // Stays a gap: refs are positional and rebuilt per batch; fixing it needs stable ref
  // identity carried between batches (a ref-format change).
  it.fails("GAP: insert before the target, ref1 then targets a different element", async () => {
    const { doc, save, hits } = setup();
    const del = doc.createElement("button");
    del.textContent = "Delete";
    track(del, hits, "delete");
    save.before(del);
    const r = await act(doc, [click("ref1")]);
    expect(r.code === "stale_ref" || hits.join(",") === "save").toBe(true);
  });
});

describe("covered target", () => {
  function setup() {
    const doc = load("covered.html");
    const target = doc.getElementById("target");
    target.getBoundingClientRect = () => RECT;
    return { doc, target, overlay: doc.getElementById("overlay") };
  }
  it("uncovered: trusted click emits a CDP click", async () => {
    const { doc, target } = setup();
    doc.elementFromPoint = () => target;
    const r = await act(doc, [click(refFor(doc, "Pay"))], { trusted: true });
    expect(r.ok).toBe(true);
    expect(r.cdp.verb).toBe("click");
  });
  it("same-document overlay returns not_hittable", async () => {
    const { doc, overlay } = setup();
    doc.elementFromPoint = () => overlay;
    const r = await act(doc, [click(refFor(doc, "Pay"))], { trusted: true });
    expect(r.code).toBe("not_hittable");
  });
  it("outer-document scrim over an iframe returns not_hittable", async () => {
    const { doc } = setup();
    const fd = frameDoc(doc);
    const btn = fd.querySelector("button");
    btn.getBoundingClientRect = () => RECT;
    fd.elementFromPoint = () => btn;
    doc.getElementById("f").getBoundingClientRect = () => box(0, 100, 300, 150);
    doc.elementFromPoint = () => doc.getElementById("frame-overlay");
    const r = await act(fd, [click(refFor(fd, "Framed pay"))], { trusted: true });
    expect(r.code).toBe("not_hittable");
  });
});

describe("accessible name", () => {
  it("label[for] names the input", () => {
    expect(names(load("accessible-name.html"))).toContain("Email");
  });
  it("wrapping label names the input", () => {
    expect(names(load("accessible-name.html"))).toContain("Search");
  });
  it("type on each textbox ref reaches its input", async () => {
    const doc = load("accessible-name.html");
    const boxes = nodes(doc).filter((n) => n.role === "textbox");
    expect(boxes).toHaveLength(3);
    for (const [i, n] of boxes.entries()) {
      expect((await act(doc, [{ verb: "type", ref: n.ref, text: `v${i}` }])).ok).toBe(true);
    }
    expect([...doc.querySelectorAll("input")].map((el: any) => el.value)).toEqual(["v0", "v1", "v2"]);
  });
  it("aria-labelledby names an input", () => {
    expect(nodes(load("accessible-name.html")).filter((n) => n.role === "textbox")[1].name).toBe("Password");
  });
  it("aria-labelledby names a role=button", () => {
    expect(nodes(load("accessible-name.html")).find((n) => n.role === "button").name).toBe("Go now");
  });
});

describe("snapshot operation count (jsdom)", () => {
  const LANDMARK = "main,nav,header,footer,aside,form,section,[role=main],[role=navigation],[role=banner],[role=contentinfo],[role=complementary],[role=region],[role=form],[role=search]";
  // Collection is one tree walk (0 doc.querySelectorAll); the label[for] map and the
  // heading list are each built once, only if some element needs them.
  function expectedQsa(doc: any) {
    const items = collectInteractive(doc);
    const labels = items.some(({ element }) => !(element.getAttribute("aria-label") || "").trim() && element.getAttribute("id"));
    const headings = items.some(({ element }) => !element.parentElement?.closest(LANDMARK));
    return (labels ? 1 : 0) + (headings ? 1 : 0);
  }
  async function countOps(doc: any, fn: () => unknown) {
    const view = doc.defaultView, proto = view.Element.prototype;
    const origQsa = doc.querySelectorAll, origRect = proto.getBoundingClientRect, origStyle = view.getComputedStyle;
    const counts = { querySelectorAll: 0, layoutReads: 0, computedStyle: 0 };
    doc.querySelectorAll = function (s: string) { counts.querySelectorAll++; return origQsa.call(doc, s); };
    proto.getBoundingClientRect = function () { counts.layoutReads++; return origRect.call(this); };
    view.getComputedStyle = function (...a: any[]) { counts.computedStyle++; return origStyle.apply(view, a); };
    try { return { result: (await fn()) as any, counts }; }
    finally { delete doc.querySelectorAll; proto.getBoundingClientRect = origRect; view.getComputedStyle = origStyle; }
  }
  // Pins of the measured counts after the 2/2 optimisations.
  it.each([50, 2000])("buildSnapshot and snapshot step on a %i-element page", async (n) => {
    const doc = new JSDOM(benchPage(n), { url: `${ORIGIN}/` }).window.document;
    const want = expectedQsa(doc);
    const snap = await countOps(doc, () => buildSnapshot(doc, ""));
    const step = await countOps(doc, () => executeSteps(doc, [{ verb: "snapshot" }], "read", ORIGIN));
    console.log(JSON.stringify({ snapshotOps: { elements: n, nodes: snap.result.nodes.length, buildSnapshot: snap.counts, snapshotStep: step.counts } }));
    expect(snap.result.nodes.length).toBe(n);
    expect(snap.counts.querySelectorAll).toBe(want);
    expect(snap.counts.layoutReads).toBe(n);
    expect(step.counts.querySelectorAll).toBe(want); // buildRefMap adds no query
    expect(step.counts.layoutReads).toBe(n);
  }, 60_000);
});
