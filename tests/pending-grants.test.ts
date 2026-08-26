import { describe, it, expect } from "vitest";
import { recordBrowserCall, drainBrowserCalls, beginCliTurn, endCliTurn } from "../src/browser/pending-grants.js";

describe("pending-grants", () => {
  it("stamps a call recorded during a CLI turn with that turn's session id, drainable regardless of actor", () => {
    beginCliTurn("s1");
    recordBrowserCall("some-other-actor", { name: "browser_snapshot", summary: "ok" }, 100);
    expect(drainBrowserCalls({ sessionId: "s1" }, 1000)).toEqual([
      { actorId: "some-other-actor", name: "browser_snapshot", summary: "ok", at: 100, sessionId: "s1" },
    ]);
    endCliTurn("s1");
  });

  it("stamps sessionId: null once the CLI turn has ended", () => {
    beginCliTurn("s1");
    endCliTurn("s1");
    recordBrowserCall("actor", { name: "browser_snapshot", summary: "ok" }, 100);
    expect(drainBrowserCalls({ actorId: "actor", since: 0 }, 1000)).toEqual([
      { actorId: "actor", name: "browser_snapshot", summary: "ok", at: 100, sessionId: null },
    ]);
  });

  it("routes calls to the most recently begun turn, falling back to the prior turn once it ends", () => {
    beginCliTurn("s1");
    beginCliTurn("s2");
    recordBrowserCall("actor", { name: "browser_snapshot", summary: "to s2" }, 100);
    endCliTurn("s2");
    recordBrowserCall("actor", { name: "browser_snapshot", summary: "to s1" }, 200);

    expect(drainBrowserCalls({ sessionId: "s2" }, 1000)).toEqual([
      { actorId: "actor", name: "browser_snapshot", summary: "to s2", at: 100, sessionId: "s2" },
    ]);
    expect(drainBrowserCalls({ sessionId: "s1" }, 1000)).toEqual([
      { actorId: "actor", name: "browser_snapshot", summary: "to s1", at: 200, sessionId: "s1" },
    ]);
    endCliTurn("s1");
  });

  it("drops a call older than the TTL", () => {
    recordBrowserCall("actor", { name: "browser_snapshot", summary: "ok" }, 0);
    const now = 30 * 60 * 1000 + 1;
    expect(drainBrowserCalls({ actorId: "actor", since: 0 }, now)).toEqual([]);
  });
});
