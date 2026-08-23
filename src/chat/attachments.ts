import { existsSync, readFileSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { attachmentsDir } from "../api/forge-routes.js";

const MAX_IMAGES = 6;
const MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
};
const IMAGE_LINK_RE = /!\[[^\]]*\]\(([^)]+)\)/g;

export type ImageAttachment = { path: string; mediaType: string; data: string };

// Finds markdown image links pointing at real files inside attachmentsDir()
// and reads them as base64. External URLs, paths outside the dir, and missing
// files are all filtered out by the same existsSync + prefix check.
export function extractImageAttachments(body: string): ImageAttachment[] {
  const dir = resolve(attachmentsDir());
  const out: ImageAttachment[] = [];
  for (const m of body.matchAll(IMAGE_LINK_RE)) {
    if (out.length >= MAX_IMAGES) break;
    const mediaType = MEDIA_TYPES[extname(m[1].trim()).toLowerCase()];
    if (!mediaType) continue;
    const abs = resolve(dir, m[1].trim());
    if (!abs.startsWith(dir + sep) || !existsSync(abs)) continue;
    out.push({ path: abs, mediaType, data: readFileSync(abs).toString("base64") });
  }
  return out;
}
