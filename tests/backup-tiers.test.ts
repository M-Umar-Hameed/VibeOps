import { expect, test } from "vitest";
import { selectExportsToKeep, isoWeekKey, LOCAL_TIERS } from "../src/services/backup.js";

const n = (iso: string) => `export-${iso.replace(/[:.]/g, "-")}.json`;
const now = Date.parse("2026-11-23T12:00:00.000Z");
const none = { recent: 0, days: 0, weeks: 0 };

test("empty input", () => {
  expect(selectExportsToKeep([], now, LOCAL_TIERS)).toEqual([]);
});

test("fewer files than recent keeps all", () => {
  const f = ["2026-11-20T01:00:00.000Z", "2026-11-21T01:00:00.000Z", "2026-11-22T01:00:00.000Z"].map(n);
  expect(selectExportsToKeep(f, now, { ...none, recent: 10 }).sort()).toEqual([...f].sort());
});

test("non-export names are ignored", () => {
  const good = n("2026-11-23T01:00:00.000Z");
  const bad = ["notes.txt", "export-bad.json", `${good}.tmp`, "export-2026-11-23.json"];
  expect(selectExportsToKeep([...bad, good], now, { recent: 10, days: 10, weeks: 10 })).toEqual([good]);
});

test("unsorted input equals sorted input", () => {
  const f = [
    "2026-11-18T05:00:00.000Z", "2026-11-23T01:00:00.000Z", "2026-11-20T09:00:00.000Z",
    "2026-11-23T08:00:00.000Z", "2026-11-19T02:00:00.000Z",
  ].map(n);
  const t = { recent: 2, days: 3, weeks: 1 };
  expect(selectExportsToKeep([...f].reverse(), now, t)).toEqual(selectExportsToKeep([...f].sort(), now, t));
});

test("several per day keeps newest of each day", () => {
  const f = ["2026-11-22T01:00:00.000Z", "2026-11-22T09:00:00.000Z", "2026-11-23T01:00:00.000Z", "2026-11-23T09:00:00.000Z"].map(n);
  expect(selectExportsToKeep(f, now, { ...none, days: 7 })).toEqual([f[3], f[1]]);
});

test("recent boundary", () => {
  const f = [1, 2, 3, 4, 5].map((h) => n(`2026-11-23T0${h}:00:00.000Z`));
  expect(selectExportsToKeep(f, now, { ...none, recent: 2 })).toEqual([f[4], f[3]]);
});

test("day boundary at UTC midnight", () => {
  const f = [n("2026-11-22T23:59:59.999Z"), n("2026-11-23T00:00:00.000Z")];
  expect(selectExportsToKeep(f, now, { ...none, days: 2 })).toEqual([f[1], f[0]]);
});

test("days limit", () => {
  const f = ["2026-11-20", "2026-11-21", "2026-11-22", "2026-11-23"].flatMap((d) => [n(`${d}T01:00:00.000Z`), n(`${d}T02:00:00.000Z`)]);
  expect(selectExportsToKeep(f, now, { ...none, days: 2 })).toEqual([n("2026-11-23T02:00:00.000Z"), n("2026-11-22T02:00:00.000Z")]);
});

test("week boundary: Sunday and Monday are different ISO weeks", () => {
  const f = [n("2026-11-22T10:00:00.000Z"), n("2026-11-23T10:00:00.000Z")];
  expect(selectExportsToKeep(f, now, { ...none, weeks: 2 })).toEqual([f[1], f[0]]);
  expect(selectExportsToKeep(f, now, { ...none, weeks: 1 })).toEqual([f[1]]);
});

test("ISO year boundary", () => {
  expect(isoWeekKey(Date.parse("2026-12-31T10:00:00Z"))).toBe("2026-W53");
  expect(isoWeekKey(Date.parse("2027-01-01T10:00:00Z"))).toBe("2026-W53");
  expect(isoWeekKey(Date.parse("2027-01-04T00:00:00Z"))).toBe("2027-W01");
});

test("future-dated file is kept", () => {
  const f = [n("2026-11-24T10:00:00.000Z"), n("2026-11-23T10:00:00.000Z")];
  expect(selectExportsToKeep(f, now, none)).toEqual([f[0]]);
});

test("90 files over 20-23 Nov with LOCAL_TIERS", () => {
  const f: string[] = [];
  for (let i = 0; i < 90; i++) f.push(n(new Date(Date.parse("2026-11-20T00:00:00.000Z") + i * 3_600_000 + 1).toISOString()));
  const keep = selectExportsToKeep(f, Date.parse("2026-11-24T00:00:00.000Z"), LOCAL_TIERS);
  expect(new Set(keep).size).toBe(keep.length);
  expect(keep.length).toBeLessThanOrEqual(10 + 7 + 4);
  expect(keep.length).toBeGreaterThanOrEqual(10);
});
