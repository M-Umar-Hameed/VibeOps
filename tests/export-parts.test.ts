process.env.EMBED_PROVIDER = "fake";
import { test, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { app } from "../src/api/app.js";
import { buildBrief, buildBriefParts, packSections, MAX_BRIEF_CHARS } from "../src/services/export.js";
import { saveNote } from "../src/services/notes.js";
import { upsertSourceDoc } from "../src/services/knowledge.js";
import { getEmbedder } from "../src/knowledge/embedder.js";
import { createActor } from "../src/services/actors.js";
import { createProject } from "../src/services/projects.js";
import { vibeopsHome } from "../src/runtime/home.js";

const emb = getEmbedder();
const SECRET = "sk-" + "test1234567890abcdefgh"; // built at runtime so the secret gate does not flag the fixture

async function seedProject(key: string, docs: Record<string, string>) {
  const p = await createProject({ key, name: `P ${key}` });
  for (const [name, text] of Object.entries(docs)) {
    await upsertSourceDoc("repo", `${p.id}:${name}`, text, emb);
  }
  return p;
}

const bigDocs = (u: string, n = 4) =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [`docs/${i}.md`, `MARK-D${i}-${u} ` + "x".repeat(70_000)]));

test("packSections: greedy, never splits or drops, oversize alone", () => {
  const a = "a".repeat(60), b = "b".repeat(60), c = "c".repeat(300), d = "d".repeat(10);
  expect(packSections([a, b, c, d], 150, 10)).toEqual([[a, b], [c], [d]]);
});

test("packing order: curated first, docs, auto bullets last; nothing lost", async () => {
  const u = randomUUID().slice(0, 8);
  const { actor } = await createActor({ name: `ep-${u}`, kind: "human", role: "admin" });
  const p = await seedProject(`ep-${u}`, bigDocs(u));
  const mk = (title: string, body: string, extra: object = {}) =>
    saveNote(actor.id, { title, body, scope: "project", refId: p.id, ...extra } as any, emb);
  await mk(`N-${u}`, `MARK-NOTE-${u}`);
  await mk(`D-${u}`, `MARK-DEC-${u}`, { kind: "decision" });
  await mk(`R-${u}`, `MARK-RULE-${u}`, { kind: "rule" });
  await mk(`A1-${u}`, "a1", { kind: "decision", source: "auto" });
  await mk(`A2-${u}`, "a2", { kind: "decision", source: "auto" });
  await mk("", `A3 line one\nline two ${u}`, { kind: "decision", source: "auto" });

  const { parts } = await buildBriefParts("project", p.id);
  expect(parts.length).toBeGreaterThanOrEqual(2);
  const p1 = parts[0];
  const iRule = p1.indexOf(`MARK-RULE-${u}`), iDec = p1.indexOf(`MARK-DEC-${u}`), iNote = p1.indexOf(`MARK-NOTE-${u}`);
  expect(iRule).toBeGreaterThan(-1);
  expect(iRule).toBeLessThan(iDec);
  expect(iDec).toBeLessThan(iNote);
  expect(iNote).toBeLessThan(p1.indexOf("## docs/"));

  const last = parts[parts.length - 1];
  const tail = last.slice(last.indexOf("## Auto-captured notes (3)"));
  expect(tail).toContain(`- A1-${u}\n- A2-${u}\n- A3 line one line two ${u}\n`);

  const all = parts.join("");
  const count = (s: string) => all.split(s).length - 1;
  for (const m of [`MARK-NOTE-${u}`, `MARK-DEC-${u}`, `MARK-RULE-${u}`, ...[0, 1, 2, 3].map((i) => `MARK-D${i}-${u}`)]) {
    expect(count(m)).toBe(1);
  }
  for (const part of parts) expect(part.length).toBeLessThanOrEqual(MAX_BRIEF_CHARS);
});

test("oversize section gets its own part", async () => {
  const u = randomUUID().slice(0, 8);
  const p = await seedProject(`eo-${u}`, { "docs/big.md": "y".repeat(210_000), "docs/small.md": `small-${u}` });
  const { parts } = await buildBriefParts("project", p.id);
  const big = parts.find((x) => x.includes("## docs/big.md"))!;
  expect(big.length).toBeGreaterThan(MAX_BRIEF_CHARS);
  expect(big).not.toContain("## docs/small.md");
  expect(parts.join("")).toContain(`small-${u}`);
});

test("small brief stays one part with the plain header", async () => {
  const u = randomUUID().slice(0, 8);
  const { actor } = await createActor({ name: `es-${u}`, kind: "human", role: "admin" });
  const p = await seedProject(`es-${u}`, { "docs/a.md": "alpha" });
  await saveNote(actor.id, { body: "b", scope: "project", refId: p.id } as any, emb);
  const { parts } = await buildBriefParts("project", p.id);
  expect(parts.length).toBe(1);
  const { markdown } = await buildBrief("project", p.id);
  expect(markdown.startsWith(`# P es-${u} — Repo Knowledge Brief\n`)).toBe(true);
  expect(markdown).not.toContain("(part");
});

test("GET /export/brief part and X-Brief-Parts", async () => {
  const u = randomUUID().slice(0, 8);
  const { apiKey } = await createActor({ name: `er-${u}`, kind: "human", role: "member" });
  const p = await seedProject(`er-${u}`, bigDocs(u));
  const { parts } = await buildBriefParts("project", p.id);
  const n = parts.length;
  const get = (q: string) => app.request(`/export/brief?kind=project&id=${p.id}${q}`, { headers: { Authorization: `Bearer ${apiKey}` } });

  const r1 = await get("");
  expect(r1.status).toBe(200);
  expect(r1.headers.get("X-Brief-Parts")).toBe(String(n));
  expect((await r1.text()).startsWith(`# P er-${u} - Repo Knowledge Brief (part 1 of ${n})`)).toBe(true);
  const r2 = await get("&part=2");
  expect(r2.status).toBe(200);
  expect(await r2.text()).toContain(`(part 2 of ${n})`);
  expect(r2.headers.get("Content-Disposition")).toContain("-part-02.md");
  const r3 = await get(`&part=${n + 1}`);
  expect(r3.status).toBe(404);
  expect(((await r3.json()) as any).error).toMatch(/out of range/);
  expect((await get("&part=0")).status).toBe(400);

  const { actor } = await createActor({ name: `ern-${u}`, kind: "human", role: "member" });
  const note = await saveNote(actor.id, { body: "nb", scope: "global" } as any, emb);
  const rn = await app.request(`/export/brief?kind=note&id=${note.id}`, { headers: { Authorization: `Bearer ${apiKey}` } });
  expect(rn.headers.get("X-Brief-Parts")).toBe("1");
});

test("redaction applies to every part", async () => {
  const u = randomUUID().slice(0, 8);
  const { actor } = await createActor({ name: `ed-${u}`, kind: "human", role: "admin" });
  const docs = bigDocs(u);
  docs["docs/3.md"] += ` ${SECRET}`;
  const p = await seedProject(`ed-${u}`, docs);
  await saveNote(actor.id, { body: `n ${SECRET}`, scope: "project", refId: p.id } as any, emb);
  const { parts } = await buildBriefParts("project", p.id);
  expect(parts.length).toBeGreaterThanOrEqual(2);
  expect(parts.join("")).toContain("[redacted]");
  for (const part of parts) expect(part).not.toContain(SECRET);
});

test("POST /export/brief-files writes parts, replaces stale, sanitises key", async () => {
  const u = randomUUID().slice(0, 8);
  const { apiKey } = await createActor({ name: `ef-${u}`, kind: "human", role: "admin" });
  const key = `../evil key/${u}`;
  const p = await seedProject(key, bigDocs(u));
  const base = resolve(join(vibeopsHome(), ".vibeops", "exports", "notebooklm"));
  const expected = join(base, `.._evil_key_${u}`);
  mkdirSync(expected, { recursive: true });
  writeFileSync(join(expected, "part-07.md"), "stale");
  writeFileSync(join(expected, "keep.txt"), "keep");

  const res = await app.request("/export/brief-files", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "project", id: p.id }),
  });
  expect(res.status).toBe(200);
  const out = (await res.json()) as any;
  expect(out.dir).toBe(resolve(expected));
  expect(out.dir.startsWith(base + sep)).toBe(true);
  const { parts } = await buildBriefParts("project", p.id);
  expect(out.parts).toBe(parts.length);
  expect(out.parts).toBeGreaterThanOrEqual(2);
  out.files.forEach((f: any, i: number) => {
    expect(f.name).toBe(`part-${String(i + 1).padStart(2, "0")}.md`);
    expect(f.chars).toBe(readFileSync(join(out.dir, f.name), "utf8").length);
  });
  expect(out.files.length).toBe(out.parts);
  expect(existsSync(join(expected, "part-07.md"))).toBe(false);
  expect(readFileSync(join(expected, "keep.txt"), "utf8")).toBe("keep");
});

test("POST /export/brief-files errors", async () => {
  const u = randomUUID().slice(0, 8);
  const { apiKey: admin } = await createActor({ name: `efa-${u}`, kind: "human", role: "admin" });
  const { apiKey: member } = await createActor({ name: `efm-${u}`, kind: "human", role: "member" });
  const empty = await createProject({ key: `efe-${u}`, name: "E" });
  const post = (key: string, body: unknown) => app.request("/export/brief-files", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  expect((await post(member, { kind: "project", id: empty.id })).status).toBe(403);
  const r409 = await post(admin, { kind: "project", id: empty.id });
  expect(r409.status).toBe(409);
  expect(((await r409.json()) as any).error).toMatch(/no indexed repo docs/);
  expect((await post(admin, { kind: "project", id: randomUUID() })).status).toBe(404);
  expect((await post(admin, { kind: "note", id: randomUUID() })).status).toBe(400);
  expect((await post(admin, { kind: "project", id: "x" })).status).toBe(400);
});
