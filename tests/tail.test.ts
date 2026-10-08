import { expect, test } from "vitest";
import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readIndexTail, TAIL_BYTES, MAX_TAIL_BYTES } from "../src/ingest/sessions/tail.js";

test("larger-than-cap file returns only the tail, starting at a line boundary", () => {
  const dir = mkdtempSync(join(tmpdir(), "tail-"));
  const path = join(dir, "big.jsonl");
  const lines = [];
  for (let i = 0; i < 500; i++) lines.push(`line-${i}-${"x".repeat(50)}`);
  const content = lines.join("\n");
  writeFileSync(path, content);

  const maxBytes = 1000;
  const t = readIndexTail(path, maxBytes);
  expect(t).not.toBeNull();
  expect(t!.text.length).toBeLessThan(content.length);
  // the returned text must be an exact suffix of the original content, i.e. it
  // begins right after a newline in the source, never mid-line.
  expect(content.endsWith(t!.text)).toBe(true);
  expect(content[content.length - t!.text.length - 1]).toBe("\n");
});

test("smaller-than-cap file returns its full content", () => {
  const dir = mkdtempSync(join(tmpdir(), "tail-"));
  const path = join(dir, "small.jsonl");
  const content = "line-one\nline-two\nline-three";
  writeFileSync(path, content);

  const t = readIndexTail(path, 1000);
  expect(t).not.toBeNull();
  expect(t!.text).toBe(content);
});

test("appending to the file changes the hash", () => {
  const dir = mkdtempSync(join(tmpdir(), "tail-"));
  const path = join(dir, "append.jsonl");
  writeFileSync(path, "line-one\n");
  const before = readIndexTail(path, 1000);
  appendFileSync(path, "line-two\n");
  const after = readIndexTail(path, 1000);
  expect(before!.hash).not.toBe(after!.hash);
});

test("reading twice without touching the file returns the same hash", () => {
  const dir = mkdtempSync(join(tmpdir(), "tail-"));
  const path = join(dir, "stable.jsonl");
  writeFileSync(path, "line-one\nline-two\n");
  const first = readIndexTail(path, 1000);
  const second = readIndexTail(path, 1000);
  expect(first!.hash).toBe(second!.hash);
});

test("nonexistent path returns null", () => {
  expect(readIndexTail(join(tmpdir(), "does-not-exist-" + Date.now() + ".jsonl"), 1000)).toBeNull();
});

test("a final record larger than the cap retries with the wider window instead of skipping", () => {
  const dir = mkdtempSync(join(tmpdir(), "tail-"));
  const path = join(dir, "huge-last-line.jsonl");
  // Explicit small windows so the branch is exercised without writing megabytes:
  // the last record exceeds the first window, so no line boundary is found and the
  // read must retry at the wider one - which is still narrower than the file.
  const NL = String.fromCharCode(10);
  const early = "a".repeat(8000);
  const last = "b".repeat(3000);
  writeFileSync(path, early + NL + last);

  const t = readIndexTail(path, 1000, 5000);
  expect(t).not.toBeNull();
  expect(t!.text).toBe(last);
});

test("returns null when even the widest window finds no line boundary", () => {
  const dir = mkdtempSync(join(tmpdir(), "tail-"));
  const path = join(dir, "no-newline.jsonl");
  writeFileSync(path, "z".repeat(10_000));
  expect(readIndexTail(path, 1000, 5000)).toBeNull();
});

test("default window and retry constants are ordered so the retry can widen", () => {
  expect(MAX_TAIL_BYTES).toBeGreaterThan(TAIL_BYTES);
});
