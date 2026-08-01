import { afterEach, expect, test, vi } from "vitest";
import { setSetting } from "../src/services/settings.js";
import { clearSetting, withSetting, withSettings } from "./helpers/settings.js";
import { fetchDocs } from "../src/knowledge/docs.js";
import { app } from "../src/api/app.js";
import { createActor } from "../src/services/actors.js";
import { db } from "../src/db/client.js";
import { embeddings } from "../src/db/schema.js";
import { and, eq } from "drizzle-orm";

process.env.EMBED_PROVIDER = "fake";

afterEach(async () => {
  vi.unstubAllGlobals();
});

test("fetchDocs: disabled setting returns ok:false and never calls fetch", async () => {
  await withSetting("context7.enabled", "", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchDocs("react");

    expect(result).toEqual({ ok: false, text: "Context7 is disabled; enable it in settings (context7.enabled)." });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

test("fetchDocs: enabled happy path resolves library then fetches docs, no Authorization header without apiKey", async () => {
  await withSetting("context7.enabled", "true", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: "/vercel/next.js" }]), { status: 200 }))
      .mockResolvedValueOnce(new Response("# Next.js docs\ncontent here", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchDocs("next.js", "routing");

    expect(result.ok).toBe(true);
    expect(result.text).toContain("Next.js docs");
    const [searchCall, docsCall] = fetchMock.mock.calls;
    expect(searchCall[0]).toBe("https://context7.com/api/v1/search?query=next.js");
    expect((searchCall[1]?.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(docsCall[0]).toBe("https://context7.com/api/v1//vercel/next.js?tokens=2500&topic=routing");
    expect((docsCall[1]?.headers as Record<string, string>).Authorization).toBeUndefined();
  });
});

test("fetchDocs: includes Authorization header when apiKey setting present", async () => {
  await withSettings({ "context7.enabled": "true", "context7.apiKey": "test-key-123" }, async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: "/foo/bar" }]), { status: 200 }))
      .mockResolvedValueOnce(new Response("docs text", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchDocs("foo");

    const [searchCall, docsCall] = fetchMock.mock.calls;
    expect((searchCall[1]?.headers as Record<string, string>).Authorization).toBe("Bearer test-key-123");
    expect((docsCall[1]?.headers as Record<string, string>).Authorization).toBe("Bearer test-key-123");
  });
});

test("fetchDocs: non-2xx docs response returns ok:false with status", async () => {
  await withSetting("context7.enabled", "true", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: "/x/y" }]), { status: 200 }))
      .mockResolvedValueOnce(new Response("not found", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchDocs("x");

    expect(result).toEqual({ ok: false, text: "Context7 request failed: 404" });
  });
});

test("REST: GET /knowledge/docs 400 when library missing", async () => {
  const { apiKey } = await createActor({ name: "docs-400", kind: "human" });
  const res = await app.request("/knowledge/docs", { headers: { Authorization: `Bearer ${apiKey}` } });
  expect(res.status).toBe(400);
});

test("REST: GET /knowledge/docs returns mocked text and saves when save=1", async () => {
  await withSetting("context7.enabled", "true", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: "/facebook/react" }]), { status: 200 }))
      .mockResolvedValueOnce(new Response("react docs content", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const { apiKey } = await createActor({ name: "docs-route", kind: "human" });
    const res = await app.request("/knowledge/docs?library=react&save=1", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.text).toBe("react docs content");

    const rows = await db.select().from(embeddings)
      .where(and(eq(embeddings.sourceKind, "session"), eq(embeddings.sourceRef, "docs:context7:react")));
    expect(rows.length).toBeGreaterThan(0);
  });
});
