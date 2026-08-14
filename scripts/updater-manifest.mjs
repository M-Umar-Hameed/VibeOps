// Build the Tauri updater manifest (latest.json) from the signatures produced by
// `tauri build`. tauri.conf.json points the updater at
// releases/latest/download/latest.json, but nothing ever generated that file — so
// the endpoint 404s and no client has ever seen an update.
//
// Run after the build matrix, over a directory of downloaded artifacts.
//   node scripts/updater-manifest.mjs --dir dist --version 0.1.0 --tag v0.1.0 \
//     --repo M-Umar-Hameed/VibeOps --out latest.json
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";

const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : dflt;
};
const dir = arg("--dir", "dist");
const version = arg("--version");
const tag = arg("--tag", `v${version}`);
const repo = arg("--repo");
const out = arg("--out", "latest.json");
if (!version || !repo) throw new Error("--version and --repo are required");

function walk(d) {
  const found = [];
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    if (statSync(p).isDirectory()) found.push(...walk(p));
    else found.push(p);
  }
  return found;
}

// Tauri names its updater payloads per platform; the .sig sits beside the payload.
// Only these two platforms are in the release matrix, so an unrecognised .sig is
// reported rather than silently skipped — a missing platform means clients on it
// never update, which is exactly the kind of silence this ticket is about.
function platformFor(sigPath) {
  const name = basename(sigPath);
  if (name.endsWith(".app.tar.gz.sig")) return "darwin-aarch64";
  if (name.endsWith("-setup.exe.sig") || name.endsWith(".nsis.zip.sig")) return "windows-x86_64";
  if (name.endsWith(".AppImage.tar.gz.sig")) return "linux-x86_64";
  return null;
}

const platforms = {};
const unknown = [];
for (const sig of walk(dir).filter((f) => f.endsWith(".sig"))) {
  const key = platformFor(sig);
  if (!key) { unknown.push(basename(sig)); continue; }
  const payload = basename(sig).replace(/\.sig$/, "");
  platforms[key] = {
    signature: readFileSync(sig, "utf-8").trim(),
    url: `https://github.com/${repo}/releases/download/${tag}/${payload}`,
  };
}

if (unknown.length) console.warn(`updater-manifest: unrecognised signatures skipped: ${unknown.join(", ")}`);
if (Object.keys(platforms).length === 0) {
  throw new Error(`no updater signatures found under ${dir} — was the build signed? (TAURI_SIGNING_PRIVATE_KEY)`);
}

writeFileSync(out, JSON.stringify({
  version,
  notes: `VibeOps ${version}`,
  pub_date: new Date().toISOString(),
  platforms,
}, null, 2));
console.log(`wrote ${out} for ${Object.keys(platforms).join(", ")}`);
