import { expect, test } from "vitest";
import { createActor } from "../src/services/actors.js";
import { app } from "../src/api/app.js";

process.env.EMBED_PROVIDER = "fake";

test("REST: save a note then retrieve it via /knowledge", async () => {
  const { apiKey } = await createActor({ name: "kapi", kind: "human" });
  const h = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };

  const unauth = await app.request("/notes", { method: "POST", body: "{}" });
  expect(unauth.status).toBe(401);

  // FakeEmbedder has no semantic ranking (hash-seeded vectors), and the embeddings
  // table is shared across test runs, so the body must be unique per run: querying
  // with that exact text guarantees a distance-0 top hit instead of relying on
  // semantic similarity between differently-phrased query and note text.
  const uniq = `run-${Date.now()}-${Math.round(performance.now() * 1000)}`;
  const body = `deploy runbook lives in confluence ${uniq}`;

  const created = await app.request("/notes", {
    method: "POST", headers: h,
    body: JSON.stringify({ body, scope: "global" }),
  });
  expect(created.status).toBe(201);

  const res = await app.request(`/knowledge?q=${encodeURIComponent(body)}`, { headers: h });
  expect(res.status).toBe(200);
  const hits = await res.json();
  expect(Array.isArray(hits)).toBe(true);
  expect(hits.length).toBeGreaterThan(0);
  expect(hits[0].content).toContain(uniq);
});

test("REST: retrieve knowledge source via /knowledge/source", async () => {
  const { apiKey } = await createActor({ name: "ksource", kind: "human" });
  const h = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };

  const uniq = `source-${Date.now()}-${Math.round(performance.now() * 1000)}`;
  const body = `test source content ${uniq}`;

  const created = await app.request("/notes", {
    method: "POST", headers: h,
    body: JSON.stringify({ body, scope: "global" }),
  });
  const note = await created.json();
  console.log("NOTE:", note);

  const res = await app.request(`/knowledge/source?kind=note&ref=${note.id}`, { headers: h });
  if (res.status !== 200) {
    console.log("ERR:", await res.text());
  }
  expect(res.status).toBe(200);
  const data = await res.json();
  expect(data.text).toBe(body);
});
