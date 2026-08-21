import { writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { submitBatch } from "./channel.js";
import { composeMarks, type Mark, type SnapshotNode, type Viewport } from "./marks.js";

// One implementation behind both the chat SDK tools and the MCP server, so every
// lane gets set-of-marks rather than only the Claude SDK path. See
// docs/browser-control-plan.md (T3, any-model requirement).

export type MarksRun =
  | { ok: true; marks: Mark[]; imagePath: string; annotatedBase64: string }
  | { ok: false; error: string };

const DEFAULT_VIEWPORT: Viewport = { dpr: 1, scrollX: 0, scrollY: 0, viewportW: 0, viewportH: 0 };

/**
 * Snapshot + screenshot in ONE batch, then compose. Same batch matters: rects and
 * the frame must describe the same instant, or the boxes land on a page that has
 * already moved.
 */
export async function runMarks(instanceId: string): Promise<MarksRun> {
  const result = await submitBatch(instanceId, instanceId, [
    { verb: "snapshot" },
    { verb: "screenshot" },
  ]);
  if (!result) return { ok: false, error: "browser batch timed out (no extension response in 30s)" };

  const shot = result.results[1];
  if (!shot?.ok || typeof shot.value !== "string") {
    return { ok: false, error: `screenshot failed: ${shot?.error ?? "no image returned"}` };
  }

  const snap = (result.snapshot ?? {}) as { nodes?: SnapshotNode[]; viewport?: Viewport };
  const nodes = Array.isArray(snap.nodes) ? snap.nodes : [];
  const vp = snap.viewport ?? DEFAULT_VIEWPORT;

  const { annotatedBase64, marks } = await composeMarks(shot.value, nodes, vp);

  // Also write the frame to a file: a CLI lane reads files natively, which is how
  // a non-SDK model gets the image at all. Perception data - never indexed.
  const dir = join(tmpdir(), "vibeops-marks");
  mkdirSync(dir, { recursive: true });
  const imagePath = join(dir, `marks-${randomUUID()}.png`);
  writeFileSync(imagePath, Buffer.from(annotatedBase64, "base64"));

  return { ok: true, marks, imagePath, annotatedBase64 };
}

/** Text rendering of the table, so a model with no vision can still choose. */
export function marksAsText(marks: Mark[], imagePath: string): string {
  if (!marks.length) return `No markable elements on screen. Annotated frame: ${imagePath}`;
  const rows = marks.map((m) => `${m.mark}. ${m.role || "element"}${m.name ? ` "${m.name}"` : ""}`);
  return [
    `Annotated screenshot: ${imagePath}`,
    `${marks.length} marked element(s). Choose one by NUMBER:`,
    ...rows,
  ].join("\n");
}
