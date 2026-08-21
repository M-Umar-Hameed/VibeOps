import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { toDeviceBox, markableNodes, composeMarks, resolveMark, type Viewport } from "../src/browser/marks.js";

const VP: Viewport = { dpr: 2, scrollX: 100, scrollY: 200, viewportW: 800, viewportH: 600 };

async function pngOf(w: number, h: number): Promise<string> {
  const buf = await sharp({
    create: { width: w, height: h, channels: 3, background: { r: 20, g: 20, b: 20 } },
  }).png().toBuffer();
  return buf.toString("base64");
}

describe("toDeviceBox", () => {
  it("subtracts scroll then scales by dpr", () => {
    // page (150,250) with scroll (100,200) -> viewport (50,50) -> dpr2 -> (100,100)
    expect(toDeviceBox({ x: 150, y: 250, w: 30, h: 40 }, VP))
      .toEqual({ left: 100, top: 100, width: 60, height: 80 });
  });

  it("returns null for an element scrolled above or left of the viewport", () => {
    expect(toDeviceBox({ x: 0, y: 0, w: 10, h: 10 }, VP)).toBeNull();
  });

  it("returns null for an element past the right or bottom edge", () => {
    expect(toDeviceBox({ x: 100 + 800, y: 250, w: 10, h: 10 }, VP)).toBeNull();
    expect(toDeviceBox({ x: 150, y: 200 + 600, w: 10, h: 10 }, VP)).toBeNull();
  });

  it("treats dpr 1 as identity after scroll", () => {
    const vp: Viewport = { ...VP, dpr: 1 };
    expect(toDeviceBox({ x: 150, y: 250, w: 30, h: 40 }, vp))
      .toEqual({ left: 50, top: 50, width: 30, height: 40 });
  });
});

describe("markableNodes", () => {
  it("skips nodes with a null rect and nodes outside the viewport", () => {
    const nodes = [
      { ref: "ref1", rect: { x: 150, y: 250, w: 10, h: 10 } },   // visible
      { ref: "ref2", rect: null },                                // no box
      { ref: "ref3", rect: { x: 0, y: 0, w: 5, h: 5 } },          // scrolled away
    ];
    const out = markableNodes(nodes, VP);
    expect(out.map((m) => m.node.ref)).toEqual(["ref1"]);
  });
});

describe("composeMarks", () => {
  it("numbers the visible nodes and carries role and name in the table", async () => {
    const shot = await pngOf(1600, 1200);
    const nodes = [
      { ref: "refA", role: "button", name: "Submit order", rect: { x: 150, y: 250, w: 40, h: 20 } },
      { ref: "refB", role: "link", name: "Home", rect: { x: 200, y: 300, w: 40, h: 20 } },
      { ref: "refC", role: "button", name: "Offscreen", rect: null },
    ];
    const { annotatedBase64, marks } = await composeMarks(shot, nodes, VP);

    expect(marks).toEqual([
      { mark: 1, ref: "refA", role: "button", name: "Submit order" },
      { mark: 2, ref: "refB", role: "link", name: "Home" },
    ]);
    // A non-vision model can pick from the table alone: role and name are enough.
    expect(marks[0].name).toBe("Submit order");
    // The frame was actually annotated, and stays a decodable PNG of the same size.
    expect(annotatedBase64).not.toBe(shot);
    const meta = await sharp(Buffer.from(annotatedBase64, "base64")).metadata();
    expect(meta.width).toBe(1600);
    expect(meta.height).toBe(1200);
  });

  it("returns the frame untouched when nothing is markable", async () => {
    const shot = await pngOf(200, 100);
    const { marks } = await composeMarks(shot, [{ ref: "r", rect: null }], VP);
    expect(marks).toEqual([]);
  });
});

describe("resolveMark", () => {
  const marks = [{ mark: 1, ref: "refA", role: "button", name: "Go" }];

  it("resolves a listed mark to its ref", () => {
    expect(resolveMark(marks, 1)).toEqual({ ok: true, ref: "refA" });
  });

  it("refuses a mark that is not in the table", () => {
    // The security property: a model cannot name a target that was never offered.
    const r = resolveMark(marks, 99);
    expect(r.ok).toBe(false);
  });

  it("refuses a non-integer mark", () => {
    expect(resolveMark(marks, "refA" as unknown).ok).toBe(false);
    expect(resolveMark(marks, 1.5).ok).toBe(false);
  });
});

describe("T3 any-model: both surfaces, one implementation", () => {
  it("registers browser_marks on the MCP server as well as the chat tools", async () => {
    const mcp = await import("node:fs").then((fs) => fs.readFileSync("src/mcp/server.ts", "utf-8"));
    const chat = await import("node:fs").then((fs) => fs.readFileSync("src/chat/tools.ts", "utf-8"));
    // Owner requirement: not just the Claude SDK lane. Both must expose it, and
    // both must call the SAME runMarks - a forked second implementation would
    // drift, so pin that they share it.
    expect(mcp).toContain('"browser_marks"');
    expect(chat).toContain('"browser_marks"');
    expect(mcp).toContain("runMarks");
    expect(chat).toContain("runMarks");
  });

  it("marksAsText lets a non-vision model choose without the image", async () => {
    const { marksAsText } = await import("../src/browser/marks-run.js");
    const txt = marksAsText(
      [{ mark: 1, ref: "refA", role: "button", name: "Submit order" },
       { mark: 2, ref: "refB", role: "link", name: "Home" }],
      "/tmp/x.png",
    );
    expect(txt).toContain("1. button \"Submit order\"");
    expect(txt).toContain("2. link \"Home\"");
    expect(txt).toContain("/tmp/x.png"); // path for file-capable CLIs
  });
});
