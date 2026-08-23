import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractImageAttachments } from "../src/chat/attachments.js";

// 1x1 transparent PNG
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  "base64",
);

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "attach-")); process.env.VIBEOPS_ATTACHMENTS_DIR = dir; });
afterEach(() => { delete process.env.VIBEOPS_ATTACHMENTS_DIR; rmSync(dir, { recursive: true, force: true }); });

describe("extractImageAttachments", () => {
  it("returns [] for a body with no links", () => {
    expect(extractImageAttachments("just some text")).toEqual([]);
  });

  it("extracts real in-dir images, ignoring a path outside the dir", () => {
    const p1 = join(dir, "one.png");
    const p2 = join(dir, "two.png");
    writeFileSync(p1, PNG);
    writeFileSync(p2, PNG);
    const outside = join(tmpdir(), "outside.png");
    writeFileSync(outside, PNG);

    const body = `here\n![one](${p1.replace(/\\/g, "/")})\n![two](${p2.replace(/\\/g, "/")})\n![outside](${outside.replace(/\\/g, "/")})`;
    const found = extractImageAttachments(body);

    expect(found.length).toBe(2);
    for (const f of found) {
      expect(f.mediaType).toBe("image/png");
      expect(Buffer.from(f.data, "base64").equals(PNG)).toBe(true);
    }
  });

  it("ignores an external URL and a missing file", () => {
    const body = `![ext](https://example.com/x.png)\n![gone](${join(dir, "nope.png").replace(/\\/g, "/")})`;
    expect(extractImageAttachments(body)).toEqual([]);
  });

  it("caps at 6 images and skips the rest", () => {
    const links: string[] = [];
    for (let i = 0; i < 8; i++) {
      const p = join(dir, `img${i}.png`);
      writeFileSync(p, PNG);
      links.push(`![i${i}](${p.replace(/\\/g, "/")})`);
    }
    const found = extractImageAttachments(links.join("\n"));
    expect(found.length).toBe(6);
  });
});
