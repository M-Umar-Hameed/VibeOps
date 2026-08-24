import { describe, it, expect } from "vitest";
import * as store from "../src/chat/store.js";
import { setChatAgent, runTurn } from "../src/chat/turns.js";
import { createActor } from "../src/services/actors.js";
import { createProject } from "../src/services/projects.js";
import { latestHandoff, HANDOFF_RE } from "../src/services/handoff.js";
import { app } from "../src/api/app.js";
import { UNTRUSTED_CLAUSE } from "../src/relay/prompts.js";
import { saveNote } from "../src/services/notes.js";

process.env.EMBED_PROVIDER = "fake";
const uniq = (p: string) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

describe("*handoff", () => {
  it("saves the free text as a project handoff without invoking the agent, and /prime leads with it", async () => {
    const { actor, apiKey } = await createActor({ name: uniq("handoff"), kind: "human" });
    const project = await createProject({ key: uniq("k"), name: uniq("Handoff") });
    const sess = await store.createSession("Extension work", "sonnet", project.id);
    let called = false;
    setChatAgent(async () => { called = true; return { ok: true, text: "should not run" }; });

    const marker = uniq("left off");
    await runTurn(actor, sess.id, `*handoff ${marker} at the alarm fix`);
    expect(called).toBe(false);

    const h = await latestHandoff(project.id);
    expect(h?.kind).toBe("handoff");
    expect(h?.body).toContain(marker);
    expect(h?.body.startsWith("Extension work:")).toBe(true);

    const msgs = await store.getMessages(sess.id);
    expect(msgs.at(-1)?.role).toBe("assistant");
    expect(msgs.at(-1)?.body).toContain(marker);

    const prime = await (await app.request(`/prime?q=anything&project=${project.id}`, { headers: { Authorization: `Bearer ${apiKey}` } })).text();
    expect(prime).toContain(`<UNTRUSTED label="handoff">`);
    expect(prime).toContain("Handoff (");
    expect(prime).toContain(UNTRUSTED_CLAUSE);
    expect(prime).toContain(marker);
  });

  it("carries the clause exactly once when both a handoff and knowledge hits are present", async () => {
    const { actor, apiKey } = await createActor({ name: uniq("handoff-both"), kind: "human" });
    const project = await createProject({ key: uniq("k"), name: uniq("HandoffBoth") });
    const sess = await store.createSession("Extension work", "sonnet", project.id);
    setChatAgent(async () => { return { ok: true, text: "should not run" }; });

    const marker = uniq("left off");
    await runTurn(actor, sess.id, `*handoff ${marker} at the alarm fix`);

    const noteMarker = uniq("finding");
    await saveNote(actor.id, { body: `${noteMarker} something useful`, scope: "project", refId: project.id });

    const prime = await (await app.request(`/prime?q=anything&project=${project.id}`, { headers: { Authorization: `Bearer ${apiKey}` } })).text();
    expect(prime).toContain(`<UNTRUSTED label="handoff">`);
    expect(prime).toContain(`<UNTRUSTED label="knowledge">`);
    expect(prime).toContain(noteMarker);
    expect(prime.split(UNTRUSTED_CLAUSE).length - 1).toBe(1);
  });

  it("with no free text it hands off the last assistant message", async () => {
    const { actor } = await createActor({ name: uniq("handoff2"), kind: "human" });
    const project = await createProject({ key: uniq("k"), name: uniq("Handoff2") });
    const sess = await store.createSession("Sess", "sonnet", project.id);
    const marker = uniq("assistant said");
    setChatAgent(async () => ({ ok: true, text: marker }));
    await runTurn(actor, sess.id, "do a thing");
    await runTurn(actor, sess.id, "*handoff");
    expect((await latestHandoff(project.id))?.body).toContain(marker);
  });

  it("is refused in a session without a project", async () => {
    const { actor } = await createActor({ name: uniq("handoff3"), kind: "human" });
    const sess = await store.createSession("NoProj", "sonnet");
    setChatAgent(async () => ({ ok: true, text: "nope" }));
    await runTurn(actor, sess.id, "*handoff anything");
    const msgs = await store.getMessages(sess.id);
    expect(msgs.at(-1)?.body).toMatch(/needs a project/i);
  });

  it("HANDOFF_RE matches *handoff (any case) but not *handoffs", () => {
    expect(HANDOFF_RE.test("*handoffs go here")).toBe(false);
    expect(HANDOFF_RE.test("*HandOff now")).toBe(true);
  });
});
