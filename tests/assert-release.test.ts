import { expect, test } from "vitest";
import { assertBudget, assertManifest } from "../scripts/assert-release.mjs";

const BUDGETS = { "-setup.exe": 120_000_000, ".deb": 90_000_000 };

test("assertBudget passes when every entry is under budget", () => {
  expect(() =>
    assertBudget(
      [
        { name: "VibeOps_1.2.3_x64-setup.exe", bytes: 100_000_000 },
        { name: "vibeops_1.2.3_amd64.deb", bytes: 80_000_000 },
      ],
      BUDGETS,
    ),
  ).not.toThrow();
});

test("assertBudget throws naming the file and both numbers when over budget", () => {
  expect(() =>
    assertBudget([{ name: "vibeops_1.2.3_amd64.deb", bytes: 95_000_000 }], BUDGETS),
  ).toThrowError(/vibeops_1\.2\.3_amd64\.deb.*95000000.*90000000/);
});

test("assertBudget matches by suffix regardless of version in the name", () => {
  expect(() =>
    assertBudget([{ name: "VibeOps_9.9.9_x64-setup.exe", bytes: 130_000_000 }], BUDGETS),
  ).toThrowError(/-setup\.exe budget/);
});

test("assertBudget skips files that match no budget suffix", () => {
  expect(() =>
    assertBudget([{ name: "latest.json", bytes: 999_999_999 }], BUDGETS),
  ).not.toThrow();
});

test("assertManifest throws when linux-x86_64 is missing", () => {
  expect(() =>
    assertManifest({
      platforms: { "darwin-aarch64": {}, "windows-x86_64": {} },
    }),
  ).toThrowError(/linux-x86_64/);
});

test("assertManifest passes with all three platforms", () => {
  expect(() =>
    assertManifest({
      platforms: {
        "darwin-aarch64": {},
        "windows-x86_64": {},
        "linux-x86_64": {},
      },
    }),
  ).not.toThrow();
});
