import sharp from "sharp";

// Set-of-marks: overlay numbered boxes from the accessibility snapshot onto a
// screenshot, so a vision model can point at a MARK rather than invent a
// coordinate. The mark table resolves server-side back to a ref, and the click
// that follows is an ordinary grant-gated ref click — a model never supplies a
// ref or a pixel. See docs/browser-control-plan.md (T3).

export type SnapshotNode = {
  ref: string;
  role?: string;
  name?: string;
  rect?: { x: number; y: number; w: number; h: number } | null;
};

export type Viewport = {
  dpr: number; scrollX: number; scrollY: number; viewportW: number; viewportH: number;
};

export type Mark = { mark: number; ref: string; role: string; name: string };

/** Page-CSS rect -> physical-pixel box within the captured frame, or null when
 *  the element is not inside the visible viewport. captureVisibleTab returns
 *  PHYSICAL pixels; rects are CSS pixels and page-relative. Subtract scroll to
 *  reach viewport space, then scale by dpr. Getting this wrong puts every mark
 *  on the wrong element, which is the whole failure mode this tier must avoid. */
export function toDeviceBox(
  rect: { x: number; y: number; w: number; h: number },
  vp: Viewport,
): { left: number; top: number; width: number; height: number } | null {
  const dpr = vp.dpr > 0 ? vp.dpr : 1;
  const vx = rect.x - vp.scrollX;
  const vy = rect.y - vp.scrollY;
  if (rect.w <= 0 || rect.h <= 0) return null;
  // Fully outside the viewport in any direction -> not on the captured frame.
  if (vx + rect.w <= 0 || vy + rect.h <= 0) return null;
  if (vp.viewportW > 0 && vx >= vp.viewportW) return null;
  if (vp.viewportH > 0 && vy >= vp.viewportH) return null;
  return { left: vx * dpr, top: vy * dpr, width: rect.w * dpr, height: rect.h * dpr };
}

/** Nodes that can carry a mark: has a ref and a box inside the viewport. */
export function markableNodes(nodes: SnapshotNode[], vp: Viewport): Array<{ node: SnapshotNode; box: NonNullable<ReturnType<typeof toDeviceBox>> }> {
  const out: Array<{ node: SnapshotNode; box: NonNullable<ReturnType<typeof toDeviceBox>> }> = [];
  for (const node of nodes) {
    if (!node?.ref || !node.rect) continue;
    const box = toDeviceBox(node.rect, vp);
    if (box) out.push({ node, box });
  }
  return out;
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c] as string));
}

/**
 * Compose the annotated frame and its mark table.
 *
 * The table is ALWAYS returned, with role and accessible name, so a model with
 * no vision can still choose a mark from text alone — set-of-marks degrades to a
 * better-organised snapshot rather than requiring an image.
 */
export async function composeMarks(
  screenshotBase64: string,
  nodes: SnapshotNode[],
  vp: Viewport,
): Promise<{ annotatedBase64: string; marks: Mark[] }> {
  const png = Buffer.from(screenshotBase64, "base64");
  const meta = await sharp(png).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;

  const markable = markableNodes(nodes, vp);
  const marks: Mark[] = markable.map((m, i) => ({
    mark: i + 1,
    ref: m.node.ref,
    role: m.node.role ?? "",
    name: m.node.name ?? "",
  }));

  if (!markable.length || width === 0 || height === 0) {
    return { annotatedBase64: png.toString("base64"), marks };
  }

  const shapes = markable.map((m, i) => {
    const { left, top, width: w, height: h } = m.box;
    const label = String(i + 1);
    const lw = 10 + label.length * 9;
    return (
      `<rect x="${left}" y="${top}" width="${w}" height="${h}" fill="none" stroke="#ff2d95" stroke-width="2"/>` +
      `<rect x="${left}" y="${Math.max(0, top - 18)}" width="${lw}" height="18" fill="#ff2d95"/>` +
      `<text x="${left + 4}" y="${Math.max(12, top - 5)}" font-family="monospace" font-size="13" fill="#fff">${escapeXml(label)}</text>`
    );
  }).join("");

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${shapes}</svg>`;
  const annotated = await sharp(png)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .png()
    .toBuffer();

  return { annotatedBase64: annotated.toString("base64"), marks };
}

/** Resolve a model-chosen mark to its ref, from the server's own table. An
 *  out-of-table mark is a refusal: a model cannot name a target that was never
 *  offered, which is what keeps execution deterministic. */
export function resolveMark(marks: Mark[], mark: unknown): { ok: true; ref: string } | { ok: false; error: string } {
  if (typeof mark !== "number" || !Number.isInteger(mark)) {
    return { ok: false, error: "mark must be an integer" };
  }
  const hit = marks.find((m) => m.mark === mark);
  if (!hit) return { ok: false, error: `mark ${mark} is not in the table (1-${marks.length})` };
  return { ok: true, ref: hit.ref };
}
