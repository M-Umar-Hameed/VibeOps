// CI regression gates for release artifacts (docs/optimization-plan.md M7).
// Two silent regressions this blocks: the payload creeping back toward shipping
// every platform, and latest.json missing a platform (v0.1.3 shipped without
// linux, fixed in 1962c45 — nothing stopped it recurring until now).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { pathToFileURL } from "node:url";

// Budgets are 20% above the measured post-QW2 artifact sizes (Task 1 evidence).
// Measured 2026-08-16 from v0.1.3: -setup.exe 146969943B, .dmg 219873797B, .deb 233811616B, .AppImage 299809272B.
// Matched by filename SUFFIX so version numbers in names never break matching.
const BUDGETS = {
  "-setup.exe": 176363932,
  ".dmg": 263848557,
  ".deb": 280573940,
  ".AppImage": 359771127,
};

const REQUIRED_PLATFORMS = ["darwin-aarch64", "windows-x86_64", "linux-x86_64"];

// Throws naming the file, its size and its budget when any entry exceeds its
// budget. Entries whose name matches no budget suffix carry no budget: skipped.
export function assertBudget(entries, budgets) {
  const suffixes = Object.keys(budgets);
  for (const { name, bytes } of entries) {
    const suffix = suffixes.find((s) => name.endsWith(s));
    if (suffix === undefined) continue;
    if (bytes > budgets[suffix]) {
      throw new Error(
        `${name} is ${bytes} bytes, over the ${suffix} budget of ${budgets[suffix]} bytes`,
      );
    }
  }
}

// Throws unless every required platform is present in manifest.platforms.
export function assertManifest(manifest) {
  const present = Object.keys(manifest?.platforms ?? {});
  const missing = REQUIRED_PLATFORMS.filter((p) => !present.includes(p));
  if (missing.length) {
    throw new Error(
      `latest.json missing platform(s): ${missing.join(", ")} (has: ${present.join(", ") || "none"})`,
    );
  }
}

function walk(d) {
  const found = [];
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    if (statSync(p).isDirectory()) found.push(...walk(p));
    else found.push(p);
  }
  return found;
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const [cmd, target] = process.argv.slice(2);
  if (cmd === "manifest") {
    assertManifest(JSON.parse(readFileSync(target, "utf-8")));
    console.log(`manifest ok: ${REQUIRED_PLATFORMS.join(", ")} all present`);
  } else if (cmd === "budget") {
    const entries = walk(target).map((p) => ({
      name: basename(p),
      bytes: statSync(p).size,
    }));
    assertBudget(entries, BUDGETS);
    console.log(`budget ok: ${entries.length} files under budget`);
  } else {
    throw new Error("usage: assert-release.mjs <manifest latest.json | budget bundleDir>");
  }
}
