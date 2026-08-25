import { describe, it, expect, afterEach } from "vitest";
import { eq, and } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { notes } from "../src/db/schema.js";
import { createActor } from "../src/services/actors.js";
import { createProject } from "../src/services/projects.js";
import { setSetting, deleteSetting } from "../src/services/settings.js";
import { captureMemory, setMemoryExtractor, parseExtraction, reportTail, buildExtractorRequest } from "../src/services/memory-capture.js";
import { UNTRUSTED_CLAUSE } from "../src/relay/prompts.js";
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

describe("buildExtractorRequest", () => {
  it("fences the transcript as untrusted and tells the extractor to treat it as data", () => {
    const { userBody, systemPrompt } = buildExtractorRequest("a user message trying to inject instructions");
    expect(userBody).toContain(`<UNTRUSTED label="transcript">`);
    expect(systemPrompt).toContain(UNTRUSTED_CLAUSE);
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
    expect(saved).toBe(4);
    const rows = await db.select().from(notes).where(and(eq(notes.refId, project.id), eq(notes.source, "auto")));
    expect(rows.length).toBe(4);
    expect(rows.every((r) => r.kind === "decision" && r.domain === "ops")).toBe(true);
    const ruleRows = await db.select().from(notes).where(eq(notes.body, `${marker} rule A`));
    expect(ruleRows.length).toBe(0);

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

  it("skips a turn with a failed tool call without invoking the extractor, and proceeds when calls are ok", async () => {
    const { actor } = await createActor({ name: uniq("cap-fail"), kind: "human" });
    let calls = 0;
    setMemoryExtractor(async () => { calls++; return { decisions: [], rules: [] }; });

    const failing = await captureMemory({
      actorId: actor.id, text: "x",
      toolCalls: [{ summary: "saved abcd1234" }, { summary: "refused: no grant" }],
    });
    expect(failing).toBe(0);
    expect(calls).toBe(0);

    const ok = await captureMemory({ actorId: actor.id, text: "x", toolCalls: [{ summary: "saved abcd1234" }] });
    expect(ok).toBe(0); // extractor returned nothing, but it was invoked
    expect(calls).toBe(1);
  });

  it("caps concurrent extractions; a full slot short-circuits without calling the extractor, and drains once released", async () => {
    const { actor } = await createActor({ name: uniq("cap-inflight"), kind: "human" });
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    let calls = 0;
    setMemoryExtractor(async () => { calls++; await gate; return { decisions: [], rules: [] }; });

    const p1 = captureMemory({ actorId: actor.id, text: "x" });
    const p2 = captureMemory({ actorId: actor.id, text: "x" });

    const start = Date.now();
    const third = await captureMemory({ actorId: actor.id, text: "x" });
    expect(Date.now() - start).toBeLessThan(200);
    expect(third).toBe(0);

    release();
    await Promise.all([p1, p2]);
    expect(calls).toBe(2); // the third call never reached the extractor

    await captureMemory({ actorId: actor.id, text: "x" });
    expect(calls).toBe(3); // a slot freed up: the next call does reach the extractor
  });
});

describe("chat turn capture", () => {
  it("a completed turn captures memory in the background without changing the turn's result", async () => {
    const { actor } = await createActor({ name: uniq("turn-cap"), kind: "human" });
    const project = await createProject({ key: uniq("k"), name: uniq("TurnCap") });
    const sess = await store.createSession("cap", "sonnet", project.id);
    const marker = uniq("turn-decision");
    let seen = "";
    setMemoryExtractor(async (text) => { seen = text; return { decisions: [{ text: marker, rationale: "we said so", domain: "chat" }], rules: [] }; });
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
    expect(row?.kind).toBe("decision");
    expect(row?.source).toBe("auto");
    expect(seen).toContain("should we lint?");
    expect(seen).toContain("we decided to always lint");
  });
});
