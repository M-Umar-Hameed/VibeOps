import { expect, test, vi } from "vitest";

const apiFetch = vi.fn().mockResolvedValue([]);
vi.mock("./client.js", () => ({ apiFetch: (...a: any[]) => apiFetch(...a) }));

import { knowledge } from "./knowledge.js";

test("search sends project when given", async () => {
  await knowledge.search("x", 5, "p1");
  expect(apiFetch).toHaveBeenCalledWith("/knowledge", { query: { q: "x", limit: "5", project: "p1" } });
});

test("search leaves limit and project undefined when omitted", async () => {
  await knowledge.search("x");
  expect(apiFetch).toHaveBeenCalledWith("/knowledge", { query: { q: "x", limit: undefined, project: undefined } });
});
