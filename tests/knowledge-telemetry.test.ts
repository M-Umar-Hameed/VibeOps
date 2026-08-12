import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { knowledgeQueryLogs } from "../src/db/schema.js";
import { searchKnowledge, upsertVaultFile } from "../src/services/knowledge.js";
import { getEmbedder } from "../src/knowledge/embedder.js";
import { setSetting, deleteSetting } from "../src/services/settings.js";
import { getKnowledgeUsage } from "../src/services/system.js";
import { randomUUID } from "node:crypto";

process.env.EMBED_PROVIDER = "fake";

describe("knowledge retrieval telemetry", () => {
  it("records telemetry on search without storing query text by default", async () => {
    const callerId = `test-caller-${randomUUID()}`;
    const docText = `unique vault content ${randomUUID()}`;
    await upsertVaultFile(`global/test-${randomUUID()}.md`, docText, getEmbedder());
    
    await searchKnowledge(docText, { limit: 20, caller: callerId });
    
    const logs = await db.select().from(knowledgeQueryLogs).where(eq(knowledgeQueryLogs.caller, callerId));
    expect(logs.length).toBe(1);
    
    const row = logs[0];
    expect(row.projectId).toBeNull();
    expect(row.hitCount).toBe(row.hitKinds.length);
    expect(row.hitKinds.includes("vault")).toBe(true);
    expect(row.queryText).toBeNull();
    expect(row.topScore).not.toBeNull();
    expect(row.topScore!).toBeGreaterThan(0);
  });

  it("redacts query text when logging is enabled", async () => {
    const callerId = `test-caller-redact-${randomUUID()}`;
    const marker = `marker-${randomUUID()}`;
    const secret = "sk-" + "a".repeat(20);
    const query = `Here is a ${marker} and a secret ${secret}`;
    
    try {
      await setSetting("knowledge.logQueryText", "true");
      await searchKnowledge(query, { limit: 5, caller: callerId });
      
      const logs = await db.select().from(knowledgeQueryLogs).where(eq(knowledgeQueryLogs.caller, callerId));
      expect(logs.length).toBe(1);
      
      const row = logs[0];
      expect(row.queryText).not.toBeNull();
      expect(row.queryText).toContain(marker);
      expect(row.queryText).not.toContain(secret);
      expect(row.queryText).toContain("[redacted]");
    } finally {
      await deleteSetting("knowledge.logQueryText");
    }
  });

  it("exposes aggregate usage data", async () => {
    const callerId = `test-caller-agg-${randomUUID()}`;
    const docText = `agg vault content ${randomUUID()}`;
    await upsertVaultFile(`global/test-${randomUUID()}.md`, docText, getEmbedder());
    await searchKnowledge(docText, { limit: 5, caller: callerId });
    
    const usage = await getKnowledgeUsage();
    
    const callerRow = usage.byCaller.find(r => r.caller === callerId);
    expect(callerRow).toBeDefined();
    expect(callerRow!.queries).toBeGreaterThanOrEqual(1);
    
    const vaultKind = usage.byKind.find(k => k.kind === "vault");
    expect(vaultKind).toBeDefined();
    expect(vaultKind!.hits).toBeGreaterThanOrEqual(1);
  });
});
