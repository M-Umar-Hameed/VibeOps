import { describe, it, expect, afterEach } from "vitest";
import { eq, and } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { notes } from "../src/db/schema.js";
import { createActor } from "../src/services/actors.js";
import { createProject } from "../src/services/projects.js";
import { setSetting, deleteSetting } from "../src/services/settings.js";
import { captureMemory, setMemoryExtractor, parseExtraction, reportTail } from "../src/services/memory-capture.js";
import * as store from "../src/chat/store.js";
import { setChatAgent, runTurn } from "../src/chat/turns.js";

process.env.EMBED_PROVIDER = "fake";
const uniq = (p: string) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

afterEach(async () => { setMemoryExtractor(null); await deleteSetting("memory.autoCapture"); });

describe("parseExtraction", () => {
  it("accepts bare JSON and fenced JSON, rejects anything else", () => {
    const good = { decisions: [{ text: "a", rationale: "b", domain: "D" }], rules: [{ text: "r", domain: "x" }] };
    expect(parseExtraction(JSON.stringify(good))).toEqual(good);
    expect(parseExtraction("```json\n" + JSON.stringify(good) + "\n```")).toEqual(good);
    expect(parseExtraction("not json")).toBeNull();
    expect(parseExtraction(JSON.stringify({ decisions: "nope" }))).toBeNull();
  });
});

describe("reportTail", () => {
  it("slices from the last REPORT: marker, or the last 12k chars when absent", () => {
    expect(reportTail("noise\nREPORT:\nfindings")).toBe("REPORT:\nfindings");
    const noMarker = "x".repeat(20_000);
    expect(reportTail(noMarker)).toBe(noMarker.slice(-12_000));
  });
});

describe("captureMemory", () => {
  it("saves extracted items as auto-sourced typed notes, dedupes, and caps at 5", async () => {
    const { actor } = await createActor({ name: uniq("cap"), kind: "human" });
    const project = await createProject({ key: uniq("k"), name: uniq("Cap") });
    const marker = uniq("m");
    setMemoryExtractor(async () => ({
      decisions: Array.from({ length: 4 }, (_, i) => ({ text: `${marker} decision ${i}`, rationale: "why", domain: "Ops" })),
      rules: [{ text: `${marker} rule A`, domain: "ops" }, { text: `${marker} rule B`, domain: "ops" }, { text: `${marker} rule C`, domain: "ops" }],
    }));
    const saved = await captureMemory({ actorId: actor.id, text: "irrelevant", projectId: project.id });
    expect(saved).toBe(5);
    const rows = await db.select().from(notes).where(and(eq(notes.refId, project.id), eq(notes.source, "auto")));
    expect(rows.length).toBe(5);
    expect(rows.every((r) => r.domain === "ops")).toBe(true);

    const again = await captureMemory({ actorId: actor.id, text: "irrelevant", projectId: project.id });
    expect(again).toBe(0); // every item already exists
  });

  it("is a no-op when memory.autoCapture is off, and when the extractor fails", async () => {
    const { actor } = await createActor({ name: uniq("cap-off"), kind: "human" });
    await setSetting("memory.autoCapture", "off");
    setMemoryExtractor(async () => ({ decisions: [{ text: uniq("d"), rationale: "r" }], rules: [] }));
    expect(await captureMemory({ actorId: actor.id, text: "x" })).toBe(0);
    await deleteSetting("memory.autoCapture");
    setMemoryExtractor(async () => { throw new Error("model down"); });
    expect(await captureMemory({ actorId: actor.id, text: "x" })).toBe(0);
  });
});

describe("chat turn capture", () => {
  it("a completed turn captures memory in the background without changing the turn's result", async () => {
    const { actor } = await createActor({ name: uniq("turn-cap"), kind: "human" });
    const project = await createProject({ key: uniq("k"), name: uniq("TurnCap") });
    const sess = await store.createSession("cap", "sonnet", project.id);
    const marker = uniq("turn-rule");
    let seen = "";
    setMemoryExtractor(async (text) => { seen = text; return { decisions: [], rules: [{ text: marker, domain: "chat" }] }; });
    setChatAgent(async () => ({ ok: true, text: "we decided to always lint" }));
    await runTurn(actor, sess.id, "should we lint?");
    const msgs = await store.getMessages(sess.id);
    expect(msgs.at(-1)?.body).toBe("we decided to always lint");
    // background: poll briefly for the note
    let row: any;
    for (let i = 0; i < 40 && !row; i++) {
      [row] = await db.select().from(notes).where(eq(notes.body, marker));
      if (!row) await new Promise((r) => setTimeout(r, 50));
    }
    expect(row?.kind).toBe("rule");
    expect(row?.source).toBe("auto");
    expect(seen).toContain("should we lint?");
    expect(seen).toContain("we decided to always lint");
  });
});
