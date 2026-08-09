import { expect, test } from "vitest";
import { createActor } from "../src/services/actors.js";
import { app } from "../src/api/app.js";
import { withSetting, clearSetting } from "./helpers/settings.js";

const ORIGIN = "http://localhost:1421";
const OTHER = "http://evil.example";

function uniq(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

test("CORS off by default: no allow-origin header even with a valid key", { timeout: 60_000 }, async () => {
  await clearSetting("cors.origins");
  const { apiKey } = await createActor({ name: uniq("cors-off"), kind: "agent" });
  const res = await app.request("/projects", {
    headers: { Authorization: `Bearer ${apiKey}`, Origin: ORIGIN },
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("access-control-allow-origin")).toBeNull();
});

test("CORS allowlisted origin: preflight + GET + POST all echo the origin", { timeout: 60_000 }, async () => {
  await withSetting("cors.origins", ORIGIN, async () => {
    // preflight (no auth header, carries Authorization request-header)
    const pre = await app.request("/projects", {
      method: "OPTIONS",
      headers: {
        Origin: ORIGIN,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization,content-type",
      },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect((pre.headers.get("access-control-allow-headers") ?? "").toLowerCase()).toContain("authorization");

    const { apiKey } = await createActor({ name: uniq("cors-on"), kind: "agent" });

    const get = await app.request("/projects", {
      headers: { Authorization: `Bearer ${apiKey}`, Origin: ORIGIN },
    });
    expect(get.status).toBe(200);
    expect(get.headers.get("access-control-allow-origin")).toBe(ORIGIN);

    const post = await app.request("/projects", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, Origin: ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ key: uniq("cors-key"), name: uniq("cors project") }),
    });
    expect(post.status).toBe(201);
    expect(post.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  });
});

test("CORS non-allowlisted origin refused while allowlist is non-empty", { timeout: 60_000 }, async () => {
  await withSetting("cors.origins", ORIGIN, async () => {
    const { apiKey } = await createActor({ name: uniq("cors-other"), kind: "agent" });
    const res = await app.request("/projects", {
      headers: { Authorization: `Bearer ${apiKey}`, Origin: OTHER },
    });
    // Server still processes the request; the browser blocks it because no
    // Access-Control-Allow-Origin is returned for the disallowed origin.
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});
