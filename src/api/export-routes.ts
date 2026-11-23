import { Hono } from "hono";
import { buildBriefParts, writeBriefFiles } from "../services/export.js";
import { requireAdmin } from "./auth.js";
import type { Actor } from "../db/schema.js";

// Filenames are id-derived today; the sanitizer is defense-in-depth for any
// future title-derived name reaching the header.
export function sanitizeFilename(name: string): string {
  return name.replace(/[\r\n"]/g, "").replace(/[^\x20-\x7e]/g, "");
}

export function registerExportRoutes(app: Hono<{ Variables: { actor: Actor } }>) {
  app.get("/export/brief", async (c) => {
    const kind = c.req.query("kind") as "ticket" | "council" | "note" | "project";
    const id = c.req.query("id");
    if (!kind || !id) return c.json({ error: "Missing kind or id" }, 400);
    // Council reads are admin-only elsewhere (GET /council/:id); the export
    // path must not widen that surface. Tickets/notes are member-readable.
    if (kind === "council" && c.get("actor").role !== "admin") {
      return c.json({ error: "council export requires admin" }, 403);
    }

    const part = Number(c.req.query("part") ?? "1");
    if (!Number.isInteger(part) || part < 1) return c.json({ error: "part must be a positive integer" }, 400);

    const { filename, parts } = await buildBriefParts(kind, id);
    if (part > parts.length) {
      return c.json({ error: `part ${part} out of range: brief has ${parts.length} part(s)` }, 404);
    }
    const name = parts.length > 1 ? filename.replace(/\.md$/, `-part-${String(part).padStart(2, "0")}.md`) : filename;
    // c.text() would stamp text/plain over the header; c.body() keeps it.
    c.header("Content-Type", "text/markdown");
    c.header("Content-Disposition", `attachment; filename="${sanitizeFilename(name)}"`);
    c.header("X-Brief-Parts", String(parts.length));
    return c.body(parts[part - 1]);
  });

  app.post("/export/brief-files", requireAdmin, async (c) => {
    const body = await c.req.json().catch(() => null);
    if (body?.kind !== "project" || typeof body.id !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.id)) {
      return c.json({ error: 'body must be {"kind":"project","id":"<project id>"}' }, 400);
    }
    return c.json(await writeBriefFiles(body.id));
  });
}
