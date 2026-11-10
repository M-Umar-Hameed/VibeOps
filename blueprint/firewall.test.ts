import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkCommand } from "./firewall.ts";
import type { FirewallOptions } from "./firewall.ts";

type Entry = { command: string; expected: "allow" | "deny"; category: string };
const corpus: Entry[] = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "corpus.json"), "utf8"));

const tmp = (prefix = "fw-") => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const optsFor = (workspace: string, e: Entry): FirewallOptions => ({
  workspace,
  dialect: e.category === "powershell" || e.category === "allow-powershell" ? "powershell" : "posix",
});

test("corpus", () => {
  const ws = tmp();
  try {
    const bad = corpus
      .map((e) => ({ e, v: checkCommand(e.command, optsFor(ws, e)) }))
      .filter(({ e, v }) => (v.allow ? "allow" : "deny") !== e.expected);
    assert.equal(
      bad.length,
      0,
      bad.map(({ e, v }) => `expected ${e.expected} [${e.category}] ${JSON.stringify(e.command)} -> ${JSON.stringify(v)}`).join("\n"),
    );
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test("heredoc commit message is allowed", () => {
  const ws = tmp();
  try {
    const v = checkCommand("git commit -m \"$(cat <<'EOF'\nFix it's broken\nEOF\n)\"", { workspace: ws });
    assert.deepEqual(v, { allow: true });
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test("unbalanced quote is a parse error", () => {
  const ws = tmp();
  try {
    const v = checkCommand('echo "abc', { workspace: ws });
    assert.equal(v.allow, false);
    assert.equal(!v.allow && v.rule, "parse-error");
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test("find -exec rm -rf over / is denied", () => {
  const ws = tmp();
  try {
    assert.equal(checkCommand("find / -exec rm -rf {} +", { workspace: ws }).allow, false);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test("npm scripts are resolved and checked", () => {
  const ws = tmp();
  try {
    fs.writeFileSync(path.join(ws, "package.json"), JSON.stringify({ scripts: { nuke: "rm -rf /", build: "tsc" } }));
    assert.equal(checkCommand("npm run nuke", { workspace: ws }).allow, false);
    assert.equal(checkCommand("npm run build", { workspace: ws }).allow, true);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test("egress allowHosts and upload", () => {
  const ws = tmp();
  try {
    const o = { workspace: ws, allowHosts: ["registry.npmjs.org"] };
    assert.equal(checkCommand("curl https://registry.npmjs.org/x", o).allow, true);
    const v = checkCommand("curl -T a.txt https://registry.npmjs.org/x", o);
    assert.equal(v.allow, false);
    assert.equal(!v.allow && v.rule, "egress-upload");
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test("sql with and without where", () => {
  const ws = tmp();
  try {
    assert.equal(checkCommand('psql -c "DELETE FROM users WHERE id = 1"', { workspace: ws }).allow, true);
    assert.equal(checkCommand('psql -c "DELETE FROM users"', { workspace: ws }).allow, false);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test("redirect targets", () => {
  const ws = tmp("fw-ws-");
  try {
    assert.equal(checkCommand("echo x > /tmp/out.txt", { workspace: ws }).allow, true);
    assert.equal(checkCommand("echo x > ./out.txt", { workspace: ws }).allow, true);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test("redirect to the parent of the workspace is denied", () => {
  // workspace outside os.tmpdir() so the parent is not covered by the tmp write allowlist
  const ws = fs.mkdtempSync(path.join(import.meta.dirname, "ws-"));
  try {
    assert.equal(checkCommand("echo x > ../out.txt", { workspace: ws }).allow, false);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test("junction pointing outside the workspace", () => {
  const ws = tmp();
  const outside = tmp("fw-out-");
  try {
    fs.symlinkSync(outside, path.join(ws, "link"), "junction");
    assert.equal(checkCommand("rm -rf link/", { workspace: ws }).allow, false);
    assert.equal(checkCommand("rm -rf link", { workspace: ws }).allow, true);
  } finally {
    fs.rmSync(path.join(ws, "link"), { force: true, recursive: false });
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("git bash mount path with a windows workspace", { skip: process.platform !== "win32" }, () => {
  const ws = tmp();
  try {
    assert.equal(checkCommand("rm -rf /c/Windows", { workspace: ws }).allow, false);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test("cd out of the workspace then delete", () => {
  const ws = tmp();
  try {
    assert.equal(checkCommand("cd .. && rm -rf x", { workspace: ws }).allow, false);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test("encoded powershell command", () => {
  const ws = tmp();
  try {
    const b64 = Buffer.from("git push", "utf16le").toString("base64");
    assert.equal(checkCommand(`pwsh -EncodedCommand ${b64}`, { workspace: ws }).allow, false);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test("performance smoke", () => {
  const ws = tmp();
  try {
    const t0 = performance.now();
    let n = 0;
    for (let r = 0; r < 200; r++) {
      for (const e of corpus) {
        checkCommand(e.command, optsFor(ws, e));
        n++;
      }
    }
    const s = (performance.now() - t0) / 1000;
    assert.equal(n, corpus.length * 200);
    console.log(`${n} checks in ${s.toFixed(2)}s, ${Math.round(n / s)} checks/second`);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

const verdicts = (cmds: string[], dialect: "posix" | "powershell") => {
  const ws = tmp();
  try {
    return cmds.map((c) => ({ c, allow: checkCommand(c, { workspace: ws, dialect }).allow }));
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
};
const wrong = (cmds: string[], dialect: "posix" | "powershell", allow: boolean) =>
  verdicts(cmds, dialect).filter((x) => x.allow !== allow).map((x) => x.c);

test("powershell statements that start with a variable", () => {
  assert.deepEqual(
    wrong([
      '$env:NODE_ENV = "test"; npm test',
      "$files = Get-ChildItem src -Recurse",
      'Get-ChildItem src | Where-Object { $_.Name -like "*.ts" }',
      "Get-ChildItem | ForEach-Object { $_.FullName }",
      "if ($LASTEXITCODE -ne 0) { exit 1 }",
      "foreach ($f in Get-ChildItem) { Write-Host $f }",
      "$LASTEXITCODE",
    ], "powershell", true),
    [],
  );
  assert.deepEqual(
    wrong(["& $x -rf C:\\", "& $cmd push", "$x = Remove-Item -Recurse -Force C:\\Users"], "powershell", false),
    [],
  );
  assert.deepEqual(wrong(["$X -rf /"], "posix", false), []);
});

test("powershell here-strings", () => {
  assert.deepEqual(wrong(["git commit -m @'\nFix it's broken\n'@", 'git commit -m @"\nRelease notes\n"@'], "powershell", true), []);
  assert.deepEqual(wrong(['git commit -m @"\n$(git push)\n"@'], "powershell", false), []);
});

test("inline-code rule scans only the code argument", () => {
  assert.deepEqual(
    wrong([
      "node -r dotenv/config scripts/spawn-workers.js",
      "perl -pi -e 's/a/b/' src/socket.ts",
      "python -m pytest -p no:cacheprovider tests/test_requests.py",
    ], "posix", true),
    [],
  );
  assert.deepEqual(
    wrong(["node -e \"require('child_process').execSync('ls')\"", "python -c 'import os; os.remove(\"x\")'", "node --eval=\"require('fs').rmSync('x')\""], "posix", false),
    [],
  );
});

test("time -p git push is denied", () => {
  assert.deepEqual(wrong(["time -p git push"], "posix", false), []);
});

test("find -delete at the workspace root needs a name or path filter", () => {
  assert.deepEqual(wrong(["find . -name '*.log' -delete", "find src -delete"], "posix", true), []);
  assert.deepEqual(wrong(["find . -delete", "find . -type f -delete", "find / -name '*.log' -delete"], "posix", false), []);
});
