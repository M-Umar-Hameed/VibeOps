import { describe, it, expect } from "vitest";
import { toOpenAiTools } from "../src/chat/openai-tools.js";
import { buildChatTools } from "../src/chat/tools.js";

const fakeActor: any = { id: "a1", name: "tester", role: "admin", kind: "human" };

describe("toOpenAiTools", () => {
  it("converts every real chat tool without throwing", () => {
    const tools = buildChatTools(fakeActor, []);
    const schemas = toOpenAiTools(tools);
    expect(schemas.length).toBe(tools.length);
    for (const s of schemas) {
      expect(s.parameters.type).toBe("object");
    }
  });

  it("marks required vs optional string/number params correctly", () => {
    const tools = buildChatTools(fakeActor, []);
    const knowledge = toOpenAiTools(tools).find((s) => s.name === "knowledge_search")!;
    expect(knowledge.parameters.properties.query).toEqual({ type: "string" });
    expect(knowledge.parameters.required).toEqual(["query"]);

    const board = toOpenAiTools(tools).find((s) => s.name === "board_tickets")!;
    expect(board.parameters.properties.status).toEqual({ type: "string" });
    expect(board.parameters.required).toEqual([]);

    const tabs = toOpenAiTools(tools).find((s) => s.name === "browser_tabs")!;
    expect(tabs.parameters.properties.switchTo).toEqual({ type: "number" });
    expect(tabs.parameters.required).toEqual([]);
  });

  it("browser_act has an array-typed steps param and it is required", () => {
    const tools = buildChatTools(fakeActor, []);
    const act = toOpenAiTools(tools).find((s) => s.name === "browser_act")!;
    expect((act.parameters.properties.steps as any).type).toBe("array");
    expect(act.parameters.required).toContain("steps");
  });

  it("save_decision has domain optional, text and rationale required", () => {
    const tools = buildChatTools(fakeActor, []);
    const dec = toOpenAiTools(tools).find((s) => s.name === "save_decision")!;
    expect(dec.parameters.required).toEqual(expect.arrayContaining(["text", "rationale"]));
    expect(dec.parameters.required).not.toContain("domain");
  });
});
