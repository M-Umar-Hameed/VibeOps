import { rmSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// node-target (release matrix) -> real native-tree tokens.
// onnx dir is <os>/<cpu>; sharp pkg is sharp-<os>-<cpu>; ripgrep dir is <cpu>-<os>.
const KEEP = {
  "win-x64":      { onnx: ["win32", "x64"],   sharp: "win32-x64",   rg: "x64-win32" },
  "linux-x64":    { onnx: ["linux", "x64"],   sharp: "linux-x64",   rg: "x64-linux" },
  "darwin-arm64": { onnx: ["darwin", "arm64"], sharp: "darwin-arm64", rg: "arm64-darwin" },
};
// The three release legs. sharp trees are pruned by explicit foreign token so
// @img/colour and @img/sharp-wasm32 (non-platform packages) are never deleted.
const PLATFORMS = ["win32-x64", "linux-x64", "darwin-arm64"];

function dirSize(p) {
  let total = 0;
  for (const rel of readdirSync(p, { recursive: true })) {
    const s = statSync(join(p, String(rel)));
    if (s.isFile()) total += s.size;
  }
  return total;
}

// Unconditional, platform-independent. onnxruntime-web is the browser WASM
// backend transformers pulls alongside onnxruntime-node; a Node sidecar never
// loads it (~130MB). @types/undici-types are type-only, never required at runtime.
export function stripDeadWeight(outDir) {
  for (const dead of ["onnxruntime-web", "@types", "undici-types"]) {
    const p = join(outDir, "node_modules", dead);
    if (!existsSync(p)) continue;
    const bytes = dirSize(p);
    rmSync(p, { recursive: true, force: true });
    console.log(`stripped ${dead}: ${(bytes / 1e6).toFixed(1)}MB reclaimed`);
  }
}

// Per-leg. Deletes every platform's native binaries except `keep`. Never touches
// the kept platform.
export function prunePayload(dir, keep) {
  const k = KEEP[keep];
  if (!k) throw new Error(`prunePayload: unknown keep target ${keep}`);
  const nm = join(dir, "node_modules");

  const napi = join(nm, "onnxruntime-node", "bin", "napi-v6");
  if (existsSync(napi)) {
    for (const os of readdirSync(napi)) {
      for (const cpu of readdirSync(join(napi, os))) {
        if (os === k.onnx[0] && cpu === k.onnx[1]) continue;
        rmSync(join(napi, os, cpu), { recursive: true, force: true });
      }
    }
  }

  const img = join(nm, "@img");
  for (const plat of PLATFORMS) {
    if (plat === k.sharp) continue;
    rmSync(join(img, `sharp-${plat}`), { recursive: true, force: true });
    rmSync(join(img, `sharp-libvips-${plat}`), { recursive: true, force: true });
  }

  const rg = join(nm, "@anthropic-ai", "claude-agent-sdk", "vendor", "ripgrep");
  if (existsSync(rg)) {
    for (const d of readdirSync(rg)) {
      if (d !== k.rg) rmSync(join(rg, d), { recursive: true, force: true });
    }
  }
}

const argv = process.argv.slice(2);
if (argv.includes("--dir") && argv.includes("--keep")) {
  prunePayload(argv[argv.indexOf("--dir") + 1], argv[argv.indexOf("--keep") + 1]);
}
