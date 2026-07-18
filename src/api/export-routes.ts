import { Hono } from "hono";
import { buildBrief } from "../services/export.js";
import type { Actor } from "../db/schema.js";

export function registerExportRoutes(app: Hono<{ Variables: { actor: Actor } }>) {
  app.get("/export/brief", async (c) => {
    const kind = c.req.query("kind") as "ticket" | "council" | "note";
    const id = c.req.query("id");
    if (!kind || !id) return c.json({ error: "Missing kind or id" }, 400);

    const { filename, markdown } = await buildBrief(kind, id);
    c.header("Content-Type", "text/markdown");
    c.header("Content-Disposition", `attachment; filename="${filename}"`);
    return c.text(markdown);
  });
}
