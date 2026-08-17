import { expect, test } from "vitest";
import { createActor } from "../src/services/actors.js";
import { app } from "../src/api/app.js";

function uniq(p: string) { return `${p}-${Date.now()}-${Math.random().toString(36).slice(2)}`; }

test("/events accepts the key as a query param", { timeout: 60_000 }, async () => {
  const { apiKey } = await createActor({ name: uniq("ev-qp"), kind: "agent" });
  const res = await app.request(`/events?access_token=${encodeURIComponent(apiKey)}`);
  expect(res.status).toBe(200);
  await res.body!.getReader().cancel();
});

test("query-param key is rejected on non-/events routes", { timeout: 60_000 }, async () => {
  const { apiKey } = await createActor({ name: uniq("ev-qp2"), kind: "agent" });
  const res = await app.request(`/tickets?access_token=${encodeURIComponent(apiKey)}`);
  expect(res.status).toBe(401);
});
