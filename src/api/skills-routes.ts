import type { Hono } from "hono";
import type { Actor } from "../db/schema.js";
import { requireAdmin } from "./auth.js";
import { ConflictError, NotFoundError } from "../services/errors.js";
import {
  addMarketplace, listMarketplaces, removeMarketplace,
  installSkill, uninstallSkill, listInstalled, listLocalSkillDirs,
  searchRegistry, installFromRegistry,
} from "../skills/marketplace.js";

type AppEnv = { Variables: { actor: Actor } };

export function registerSkillsRoutes(app: Hono<AppEnv>): void {
  app.get("/skills/marketplaces", requireAdmin, async (c) => c.json(await listMarketplaces()));

  // Search the public skills.sh registry. Returns ranked results whose source
  // repo and name feed the existing /skills/marketplaces + /skills/install path.
  app.post("/skills/registry/install", requireAdmin, async (c) => {
    const { source, name } = await c.req.json().catch(() => ({}));
    if (typeof source !== "string" || !source) return c.json({ error: "source required" }, 400);
    if (typeof name !== "string" || !name) return c.json({ error: "name required" }, 400);
    try {
      return c.json(await installFromRegistry(source, name), 201);
    } catch (e) {
      if (e instanceof ConflictError || e instanceof NotFoundError) throw e;
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  app.get("/skills/registry/search", requireAdmin, async (c) => {
    const q = c.req.query("q");
    if (!q) return c.json({ error: "q required" }, 400);
    const owner = c.req.query("owner") || undefined;
    const limit = Number(c.req.query("limit")) || undefined;
    try {
      return c.json({ skills: await searchRegistry(q, { owner, limit }) });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 502);
    }
  });

  app.post("/skills/marketplaces", requireAdmin, async (c) => {
    const { url } = await c.req.json().catch(() => ({}));
    if (typeof url !== "string" || !url) return c.json({ error: "url required" }, 400);
    try {
      const skills = await addMarketplace(url);
      return c.json({ url, skills });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  app.delete("/skills/marketplaces", requireAdmin, async (c) => {
    const { url } = await c.req.json().catch(() => ({}));
    if (typeof url !== "string" || !url) return c.json({ error: "url required" }, 400);
    await removeMarketplace(url);
    return c.json({ ok: true });
  });

  app.post("/skills/install", requireAdmin, async (c) => {
    const { url, dir } = await c.req.json().catch(() => ({}));
    if (typeof url !== "string" || !url) return c.json({ error: "url required" }, 400);
    if (typeof dir !== "string" || !dir) return c.json({ error: "dir required" }, 400);
    try {
      const entry = await installSkill(url, dir);
      return c.json(entry, 201);
    } catch (e) {
      if (e instanceof ConflictError || e instanceof NotFoundError) throw e;
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  app.post("/skills/uninstall", requireAdmin, async (c) => {
    const { name } = await c.req.json().catch(() => ({}));
    if (typeof name !== "string" || !name) return c.json({ error: "name required" }, 400);
    await uninstallSkill(name);
    return c.json({ ok: true });
  });

  app.get("/skills/installed", requireAdmin, async (c) => c.json(await listInstalled()));

  // Skills already on disk (hand-written or installed by other tools): listed
  // read-only so the tab shows where the agents' current skills come from.
  app.get("/skills/local", requireAdmin, async (c) => {
    const managed = new Set((await listInstalled()).map((e) => e.dir));
    return c.json(listLocalSkillDirs().map((name) => ({ name, managed: managed.has(name) })));
  });
}
