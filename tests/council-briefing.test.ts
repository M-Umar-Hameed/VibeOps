import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import {
  resolveContextBudget,
  listRepoFiles,
  renderTree,
  detectLanguages,
  parseManifests,
  buildRepoBriefing,
} from "../src/council/briefing.js";
import { estimateTokens } from "../src/services/usage.js";
import { startCouncil, getCouncil, getCouncilOutput } from "../src/council/runs.js";
import { createActor } from "../src/services/actors.js";
import { withSetting } from "./helpers/settings.js";
import type { RelayConfig } from "../src/relay/config.js";

process.env.EMBED_PROVIDER = "fake";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_AGENT = join(__dirname, "fixtures", "fake-agent.mjs");

describe("T1: budget parsing", () => {
  it("resolves absent, empty, unlimited, or invalid numbers to unlimited", () => {
    expect(resolveContextBudget(null)).toBe("unlimited");
    expect(resolveContextBudget(undefined)).toBe("unlimited");
    expect(resolveContextBudget("")).toBe("unlimited");
    expect(resolveContextBudget("  ")).toBe("unlimited");
    expect(resolveContextBudget("unlimited")).toBe("unlimited");
    expect(resolveContextBudget("UNLIMITED")).toBe("unlimited");
    expect(resolveContextBudget("abc")).toBe("unlimited");
    expect(resolveContextBudget("-5")).toBe("unlimited");
    expect(resolveContextBudget("1.5")).toBe("unlimited");
  });

  it("resolves valid non-negative integer strings to numbers", () => {
    expect(resolveContextBudget("0")).toBe(0);
    expect(resolveContextBudget("500")).toBe(500);
  });
});

describe("T2: scanner", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "vibeops-scanner-test-"));
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("fixture dir with git init + .gitignore respects git ignore rules", async () => {
    const g = (...args: string[]) => execFileSync("git", args, { cwd: tempDir, windowsHide: true });
    g("init", "-b", "main");
    g("config", "user.email", "test@example.com");
    g("config", "user.name", "Test");

    writeFileSync(join(tempDir, ".gitignore"), "secret.txt\nnode_modules/\n");
    writeFileSync(join(tempDir, "tracked.txt"), "hello\n");
    writeFileSync(join(tempDir, "secret.txt"), "confidential\n");
    mkdirSync(join(tempDir, "node_modules"));
    writeFileSync(join(tempDir, "node_modules", "pkg.json"), "{}\n");
    mkdirSync(join(tempDir, "src"));
    writeFileSync(join(tempDir, "src", "untracked.ts"), "export const x = 1;\n");

    g("add", ".gitignore", "tracked.txt");
    g("commit", "-m", "init");

    const files = await listRepoFiles(tempDir);
    expect(files).toContain("tracked.txt");
    expect(files).toContain("src/untracked.ts");
    expect(files).not.toContain("secret.txt");
    expect(files.some((f) => f.startsWith("node_modules/"))).toBe(false);
  });

  it("fixture dir with no .git falls back to fs walk and skips SKIP_DIRS", async () => {
    mkdirSync(join(tempDir, "src"));
    mkdirSync(join(tempDir, "node_modules"));
    mkdirSync(join(tempDir, "dist"));
    writeFileSync(join(tempDir, "src", "index.ts"), "console.log(1);");
    writeFileSync(join(tempDir, "node_modules", "skip.js"), "skip");
    writeFileSync(join(tempDir, "dist", "bundle.js"), "bundle");
    writeFileSync(join(tempDir, "package.json"), "{}");

    const files = await listRepoFiles(tempDir);
    expect(files).toContain("package.json");
    expect(files).toContain("src/index.ts");
    expect(files.some((f) => f.startsWith("node_modules/"))).toBe(false);
    expect(files.some((f) => f.startsWith("dist/"))).toBe(false);
  });

  it("detectLanguages on ['a.ts', 'b.ts', 'c.py'] returns ['TypeScript', 'Python']", () => {
    expect(detectLanguages(["a.ts", "b.ts", "c.py"])).toEqual(["TypeScript", "Python"]);
  });

  it("renderTree collapses below depth 2 when exceeding TREE_MAX_LINES", () => {
    // Generate > 500 files inside subdirs
    const files: string[] = [];
    for (let i = 0; i < 600; i++) {
      files.push(`src/components/file${i}.tsx`);
    }
    const tree = renderTree(files);
    const lines = tree.split("\n");
    expect(lines.length).toBeLessThanOrEqual(500);
    expect(tree).toContain("(600 files)");
  });
});

describe("T3: manifest parsers", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "vibeops-manifest-test-"));
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("parses valid fixtures for package.json, Cargo.toml, pyproject.toml, and go.mod", async () => {
    writeFileSync(
      join(tempDir, "package.json"),
      JSON.stringify({
        dependencies: { react: "^18.2.0", express: "^4.18.0" },
        devDependencies: { typescript: "^5.0.0" },
      }),
    );
    writeFileSync(
      join(tempDir, "Cargo.toml"),
      `[package]\nname = "test"\n[dependencies]\nserde = "1.0"\ntokio = { version = "1.28" }\n`,
    );
    writeFileSync(
      join(tempDir, "pyproject.toml"),
      `[project]\nname = "app"\ndependencies = [\n  "fastapi>=0.100.0",\n  "requests"\n]\n`,
    );
    writeFileSync(
      join(tempDir, "go.mod"),
      `module example.com/app\n\ngo 1.21\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.9.1\n)\n\nrequire github.com/google/uuid v1.3.0\n`,
    );

    const manifests = await parseManifests(tempDir, [
      "package.json",
      "Cargo.toml",
      "pyproject.toml",
      "go.mod",
    ]);

    expect(manifests).toHaveLength(4);

    const pkg = manifests.find((m) => m.label === "package.json")!;
    expect(pkg.deps).toContain("react@^18.2.0");
    expect(pkg.deps).toContain("express@^4.18.0");
    expect(pkg.deps).toContain("typescript@^5.0.0");

    const cargo = manifests.find((m) => m.label === "Cargo.toml")!;
    expect(cargo.deps).toContain("serde@1.0");
    expect(cargo.deps).toContain("tokio@1.28");

    const py = manifests.find((m) => m.label === "pyproject.toml")!;
    expect(py.deps).toContain("fastapi>=0.100.0");
    expect(py.deps).toContain("requests");

    const gomod = manifests.find((m) => m.label === "go.mod")!;
    expect(gomod.deps).toContain("github.com/gin-gonic/gin@v1.9.1");
    expect(gomod.deps).toContain("github.com/google/uuid@v1.3.0");
  });

  it("handles malformed fixtures by returning empty deps and not throwing", async () => {
    writeFileSync(join(tempDir, "package.json"), `{"dependencies": { "truncated": `);
    writeFileSync(join(tempDir, "Cargo.toml"), `[dependencies\nserde = "1.0"\n`);
    writeFileSync(join(tempDir, "pyproject.toml"), `[project]\ndependencies = [\n  "fastapi"`);
    writeFileSync(join(tempDir, "go.mod"), `module app\nrequire (\n  github.com/gin-gonic/gin v1.9.1\n`);

    const manifests = await parseManifests(tempDir, [
      "package.json",
      "Cargo.toml",
      "pyproject.toml",
      "go.mod",
    ]);
    expect(manifests).toEqual([]);
  });

  it("parses monorepo: root first, child included, depth-3 excluded", async () => {
    writeFileSync(join(tempDir, "package.json"), JSON.stringify({ dependencies: { rootPkg: "1.0" } }));
    mkdirSync(join(tempDir, "packages", "a", "deep"), { recursive: true });
    writeFileSync(
      join(tempDir, "packages", "a", "package.json"),
      JSON.stringify({ dependencies: { childPkg: "1.0" } }),
    );
    writeFileSync(
      join(tempDir, "packages", "a", "deep", "package.json"),
      JSON.stringify({ dependencies: { deepPkg: "1.0" } }),
    );

    const manifests = await parseManifests(tempDir, [
      "package.json",
      "packages/a/package.json",
      "packages/a/deep/package.json",
    ]);

    expect(manifests).toHaveLength(2);
    expect(manifests[0].label).toBe("package.json");
    expect(manifests[1].label).toBe("packages/a/package.json");
  });
});

describe("T4: assembler", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "vibeops-assembler-test-"));
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("returns empty string immediately when budget is 0 without reading filesystem", async () => {
    const nonExistent = join(tempDir, "does-not-exist");
    const briefing = await buildRepoBriefing(nonExistent, 0);
    expect(briefing).toBe("");
  });

  it("returns empty string for non-existent root with unlimited budget", async () => {
    const nonExistent = join(tempDir, "does-not-exist");
    const briefing = await buildRepoBriefing(nonExistent, "unlimited");
    expect(briefing).toBe("");
  });

  it("assembles complete briefing for unlimited budget and redacts secrets", async () => {
    writeFileSync(
      join(tempDir, "package.json"),
      JSON.stringify({
        dependencies: { react: "^18.2.0" },
      }),
    );
    writeFileSync(
      join(tempDir, "README.md"),
      "# My App\nSecret key is sk-ant-api0123456789abcdef\nDocumentation content here.\n",
    );
    mkdirSync(join(tempDir, "src"));
    writeFileSync(join(tempDir, "src", "index.ts"), "export const x = 1;\n");

    const briefing = await buildRepoBriefing(tempDir, "unlimited");

    expect(briefing).toContain("# Repository Briefing");
    expect(briefing).toContain("## Project Identity");
    expect(briefing).toContain("## Directory Layout");
    expect(briefing).toContain("## Declared Dependencies");
    expect(briefing).toContain("react@^18.2.0");
    expect(briefing).toContain("## Key Documentation");
    expect(briefing).not.toContain("sk-ant-api0123456789abcdef");
    expect(briefing).toContain("[redacted]");
  });

  it("enforces budget cap by dropping lower priority sections", async () => {
    writeFileSync(
      join(tempDir, "package.json"),
      JSON.stringify({
        dependencies: { react: "^18.2.0" },
      }),
    );
    // Create a very large README that pushes tokens way over 500
    writeFileSync(join(tempDir, "README.md"), "A".repeat(3000));
    mkdirSync(join(tempDir, "src"));
    writeFileSync(join(tempDir, "src", "index.ts"), "export const x = 1;\n");

    const briefing = await buildRepoBriefing(tempDir, 500);

    expect(estimateTokens(briefing.length)).toBeLessThanOrEqual(500);
    expect(briefing).toContain("## Project Identity");
    expect(briefing).toContain("## Declared Dependencies");
    expect(briefing).not.toContain("## Key Documentation");
  });
});

describe("T5: engine-level injection", () => {
  let workdir: string;
  let counterDir: string;
  let counterFile: string;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "council-briefing-run-"));
    const g = (...a: string[]) => execFileSync("git", a, { cwd: workdir, windowsHide: true });
    g("init", "-b", "main");
    g("config", "user.email", "t@t");
    g("config", "user.name", "t");
    writeFileSync(join(workdir, "readme.md"), "base\n");
    writeFileSync(join(workdir, "package.json"), JSON.stringify({ dependencies: { express: "4.0.0" } }));
    g("add", "-A");
    g("commit", "-m", "base");

    counterDir = mkdtempSync(join(tmpdir(), "council-briefing-ctr-"));
    counterFile = join(counterDir, "counter.txt");
  });

  afterEach(() => {
    delete process.env.FAKE_SCRIPT;
    delete process.env.FAKE_COUNTER_FILE;
    try {
      rmSync(workdir, { recursive: true, force: true });
      rmSync(counterDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  function relayConfig(): RelayConfig {
    return {
      workdir,
      agents: {
        fake: {
          cmd: [process.execPath, FAKE_AGENT, "{prompt}", "--model", "{model}"],
          roles: ["plan", "work", "review"],
          models: [{ name: "fast", tier: "free", quality: 2 }, { name: "smart", tier: "expensive", quality: 5 }],
        },
      },
    };
  }

  function setScript(script: string): void {
    process.env.FAKE_SCRIPT = script;
    process.env.FAKE_COUNTER_FILE = counterFile;
  }

  async function waitForStatus(id: string, statuses: string[], timeoutMs = 60_000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const council = getCouncil(id);
      if (statuses.includes(council.status)) return council;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`timed out waiting for status ${statuses.join("|")}`);
  }

  it("with budget '0', persona prompt contains no repo-briefing fence", async () => {
    const { actor } = await createActor({ name: `actor-${Date.now()}-${Math.random()}`, kind: "human" });
    setScript("echo-prompt,echo-prompt,echo-prompt,chairman-go");

    await withSetting("council.contextTokenBudget", "0", async () => {
      const { councilId } = await startCouncil(actor.id, relayConfig(), { prompt: "a prompt long enough to pass validation" });
      const c = await waitForStatus(councilId, ["decided"]);
      const believer = (c as any).believer ?? "";
      expect(believer).not.toContain('label="repo-briefing"');
      const out = getCouncilOutput(councilId, 0);
      expect(out?.chunk).not.toContain("=== COUNCIL context");
    });
  });

  it("with budget 'unlimited', persona prompt contains repo-briefing fence", async () => {
    const { actor } = await createActor({ name: `actor-unlimited-${Date.now()}-${Math.random()}`, kind: "human" });
    setScript("echo-prompt,echo-prompt,echo-prompt,chairman-go");

    
    await withSetting("council.contextTokenBudget", "unlimited", async () => {
      const { councilId } = await startCouncil(actor.id, relayConfig(), { prompt: "a prompt long enough to pass validation" });
      const c = await waitForStatus(councilId, ["decided"]);
      const believer = (c as any).believer ?? "";
      expect(believer).toContain('<UNTRUSTED label="repo-briefing">');
      expect(believer).toContain("# Repository Briefing");
      const out = getCouncilOutput(councilId, 0);
      expect(out?.chunk).toContain("=== COUNCIL context");
    });
  });
});