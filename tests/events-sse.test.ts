import { expect, test } from "vitest";
import { createActor } from "../src/services/actors.js";
import { app } from "../src/api/app.js";
import { events, emitEvent } from "../src/api/events.js";

function uniq(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// Defensive SSE frame parser: complete frames end in "\n\n"; a trailing partial
// segment or heartbeat comment (line starting ":") is skipped.
function parseFrames(buf: string): { event?: string; data?: string }[] {
  const out: { event?: string; data?: string }[] = [];
  for (const block of buf.split("\n\n")) {
    if (!block.trim() || block.startsWith(":")) continue;
    const f: { event?: string; data?: string } = {};
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) f.event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
    }
    if (dataLines.length) f.data = dataLines.join("\n");
    out.push(f);
  }
  return out;
}

test("/events requires auth (401 without a key)", { timeout: 60_000 }, async () => {
  const res = await app.request("/events");
  expect(res.status).toBe(401);
});

test("closing the client removes its listener", { timeout: 60_000 }, async () => {
  const { apiKey } = await createActor({ name: uniq("sse-clean"), kind: "agent" });
  const base = events.listenerCount("event");
  const res = await app.request("/events", { headers: { Authorization: `Bearer ${apiKey}` } });
  expect(res.status).toBe(200);
  const reader = res.body!.getReader();
  await new Promise((r) => setTimeout(r, 30)); // listener attaches during streamSSE
  expect(events.listenerCount("event")).toBe(base + 1);
  await reader.cancel();
  await new Promise((r) => setTimeout(r, 30));
  expect(events.listenerCount("event")).toBe(base);
});

test("delivers an emitted event as an SSE frame", { timeout: 60_000 }, async () => {
  const { apiKey } = await createActor({ name: uniq("sse-frame"), kind: "agent" });
  const res = await app.request("/events", { headers: { Authorization: `Bearer ${apiKey}` } });
  expect(res.status).toBe(200);
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  await new Promise((r) => setTimeout(r, 30)); // ensure listener attached before emit
  emitEvent("ticket.changed", { id: "abc", status: "open" });

  let buf = "";
  let frame: { event?: string; data?: string } | undefined;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    frame = parseFrames(buf).find((f) => f.event === "ticket.changed");
    if (frame?.data) break;
  }
  await reader.cancel();
  expect(frame?.data).toBeTruthy();
  expect(JSON.parse(frame!.data!)).toEqual({ id: "abc", status: "open" });
});
