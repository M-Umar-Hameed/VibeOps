import { beforeEach, expect, test, vi } from "vitest";
import { app } from "../src/api/app.js";
import { createActor } from "../src/services/actors.js";
import { resetMetrics, snapshot } from "../src/services/metrics.js";
import { getSystemLogs } from "../src/services/system.js";

const TOKEN = ["sk", "abcdefghij0123456789"].join("-");
app.get("/__test/boom", () => { throw new Error("boom " + TOKEN); });

beforeEach(() => resetMetrics());

test("unhandled error returns 500 with errorId and logs it redacted", async () => {
  const { apiKey } = await createActor({ name: "err-log", kind: "human", role: "admin" });
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const res = await app.request("/__test/boom?q=secretquery", { headers: { Authorization: `Bearer ${apiKey}` } });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("internal error");
    expect(body.errorId).toMatch(/^[0-9a-f]{8}$/);
    expect(JSON.stringify(body)).not.toContain("boom");

    expect(spy).toHaveBeenCalledTimes(1);
    const line = String(spy.mock.calls[0][0]);
    expect(line).toContain(body.errorId);
    expect(line).toContain("GET /__test/boom");
    expect(line).toContain("[redacted]");
    expect(line).not.toContain(TOKEN);
    expect(line).not.toContain("secretquery");
    expect(line).not.toContain(apiKey);

    expect(snapshot().counters["err.500"]).toBe(1);

    const logs = await getSystemLogs();
    const entry = logs.find((l) => l.level === "error" && l.message.includes(body.errorId));
    expect(entry).toBeDefined();
    expect(entry!.message).not.toContain(TOKEN);
  } finally {
    spy.mockRestore();
  }
});
