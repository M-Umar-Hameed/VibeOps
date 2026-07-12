import { expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";

// Regression test for the hono global-Response hazard (commit 102f4e7): hono's
// default global object swap replaces globalThis.Response with a lightweight
// stand-in, which breaks transformers.js model caching (`response instanceof
// Response` fails during cold-start model download). No model download here —
// this only proves overrideGlobalObjects:false keeps the native Response intact.
test("overrideGlobalObjects: false leaves globalThis.Response untouched", async () => {
  const NativeResponse = globalThis.Response;
  const app = new Hono();
  app.get("/", (c) => c.text("ok"));

  let server: ServerType | undefined;
  try {
    await new Promise<void>((resolve) => {
      server = serve({ fetch: app.fetch, port: 0, overrideGlobalObjects: false }, () => resolve());
    });
    expect(globalThis.Response).toBe(NativeResponse);
  } finally {
    server?.close();
  }
});

// Drift guard: the real entrypoint must keep passing overrideGlobalObjects: false.
test("src/api/server.ts still sets overrideGlobalObjects: false", () => {
  const source = readFileSync("src/api/server.ts", "utf-8");
  expect(source).toContain("overrideGlobalObjects: false");
});
