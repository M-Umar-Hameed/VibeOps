import { Hono } from "hono";
import { buildBrief } from "../services/export.js";
import type { Actor } from "../db/schema.js";

export function registerExportRoutes(app: Hono<{ Variables: { actor: Actor } }>) {
  function sanitizeFilename(name: string): string {
    return name.replace(/[\r\n"]/g, "").replace(/[^\x20-\x7e]/g, "");
  }
  app.get("/export/brief", async (c) => {
    const kind = c.req.query("kind") as "ticket" | "council" | "note";
    const id = c.req.query("id");
    if (!kind || !id) return c.json({ error: "Missing kind or id" }, 400);

    const { filename, markdown } = await buildBrief(kind, id);
    // c.text() would stamp text/plain over the header; c.body() keeps it.
    c.header("Content-Type", "text/markdown");
    c.header("Content-Disposition", `attachment; filename="${sanitizeFilename(filename)}"`);
    return c.body(markdown);
  });
}
