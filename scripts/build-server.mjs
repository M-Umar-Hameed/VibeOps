import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync, readFileSync, mkdtempSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { stripDeadWeight } from "./prune-platform.mjs";

const outDir = process.argv.includes("--out")
  ? process.argv[process.argv.indexOf("--out") + 1]
  : "dist-server";

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// ponytail: cjs format errors on the server graph's top-level await (not just
// import.meta, which esbuild shims fine) -- esm output + createRequire banner
// for the external pglite require is the documented fallback (see brief).
await build({
  entryPoints: ["src/api/server.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: join(outDir, "server.mjs"),
  // claude-agent-sdk spawns its own cli.js and resolves it relative to its
  // package dir, so it must stay on disk rather than be inlined.
  external: ["@electric-sql/pglite", "@huggingface/transformers", "@anthropic-ai/claude-agent-sdk"],
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: "info",
});

cpSync("node_modules/@electric-sql/pglite", join(outDir, "node_modules", "@electric-sql", "pglite"), { recursive: true });
cpSync("node_modules/@anthropic-ai/claude-agent-sdk", join(outDir, "node_modules", "@anthropic-ai", "claude-agent-sdk"), { recursive: true });
cpSync("drizzle", join(outDir, "drizzle"), { recursive: true });

// Local-embeddings stack: npm resolves the native tree (onnxruntime, sharp) into
// the payload. The payload serves BOTH bundle platforms, but a same-prefix second
// pass for the other platform's optionals prunes the first pass's binaries
// (verified: an in-place win-then-linux install drops @img/sharp-win32-x64).
// Install each platform into its own temp prefix instead, then merge the trees
// (linux over win) so both platforms' native binaries coexist. onnxruntime-node
// ships every platform inside one package, so either pass alone covers it.
const tfVersion = JSON.parse(readFileSync("package.json", "utf-8")).dependencies["@huggingface/transformers"];
const winPrefix = mkdtempSync(join(tmpdir(), "vibeops-tf-win-"));
const linuxPrefix = mkdtempSync(join(tmpdir(), "vibeops-tf-linux-"));
try {
  execSync(`npm install --prefix "${winPrefix}" --no-save --omit=dev --os=win32 --cpu=x64 @huggingface/transformers@${tfVersion}`, { stdio: "inherit" });
  execSync(`npm install --prefix "${linuxPrefix}" --no-save --omit=dev --os=linux --cpu=x64 --libc=glibc @huggingface/transformers@${tfVersion}`, { stdio: "inherit" });
  cpSync(join(winPrefix, "node_modules"), join(outDir, "node_modules"), { recursive: true });
  cpSync(join(linuxPrefix, "node_modules"), join(outDir, "node_modules"), { recursive: true });
} finally {
  rmSync(winPrefix, { recursive: true, force: true });
  rmSync(linuxPrefix, { recursive: true, force: true });
}

// npm writes node_modules/.bin as SYMLINKS on POSIX (real .cmd shims on Windows).
// Copying them out of the temp prefix leaves the links pointing at paths that no
// longer resolve, and tauri.conf.json globs resources/server/**/* — so the bundler
// walks a dangling link and fails with "resource path ... doesn't exist". First
// seen on the macOS build (semver). The sidecar require()s packages and never
// execs these bins, so the whole directory is dead weight in the payload.
rmSync(join(outDir, "node_modules", ".bin"), { recursive: true, force: true });

// onnxruntime's GPU provider libs (CUDA/TensorRT) reference libcublas.so.12,
// which linuxdeploy tries to resolve on a runner with no CUDA - that single
// unresolvable dependency is what killed every AppImage build. The sidecar
// only ever uses the CPU provider (inside libonnxruntime itself), so the GPU
// providers are dead weight on every platform.
const onnxBin = join(outDir, "node_modules", "onnxruntime-node", "bin");
try {
  for (const entry of readdirSync(onnxBin, { recursive: true })) {
    const name = String(entry);
    if (/libonnxruntime_providers_(cuda|tensorrt)/.test(name)) {
      rmSync(join(onnxBin, name), { force: true });
      console.log(`stripped GPU provider: ${name}`);
    }
  }
} catch { /* package layout changed; the AppImage step will say so */ }
 
stripDeadWeight(outDir);

console.log(`payload ready: ${outDir}`);
