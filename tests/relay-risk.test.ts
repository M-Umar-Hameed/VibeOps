import { describe, it, expect } from "vitest";
import { commandRisk, denyPatterns, agyPatterns, RISK_IDS } from "../src/relay/risk.js";

const WD = process.platform === "win32" ? "C:\\w\\sb" : "/w/sb";
const id = (c: string, lifted: string[] = [], dialect: "posix" | "powershell" = "posix") => commandRisk(c, WD, lifted, dialect)?.id;

describe("commandRisk", () => {
  it("git push through wrappers and chains", () => {
    for (const c of ["git push origin main", "sudo git push", "FOO=1 git push", "npm test && git push"]) {
      expect(id(c)).toBe("git-push");
    }
  });
  it("rm outside or equal to the workdir", () => {
    for (const c of ["cd .. && rm -rf x", "rm -rf /", "rm -rf ~", "rm -rf $HOME/x", "rm -rf ."]) {
      expect(id(c)).toBe("rm-outside");
    }
  });
  it("rm inside the workdir is fine", () => {
    for (const c of ["rm -rf node_modules/.cache", "rm -rf build", "rm file.txt"]) expect(commandRisk(c, WD)).toBeNull();
  });
  it.runIf(process.platform === "win32")("win32 paths", () => {
    expect(id("rm -rf C:\\Users", [], "powershell")).toBe("rm-outside");
    expect(commandRisk("rm -rf .\\build", WD, [], "powershell")).toBeNull();
    expect(commandRisk("rm -rf c:\\W\\SB\\out", WD, [], "powershell")).toBeNull();
  });
  it("other rules", () => {
    const cases: Record<string, string> = {
      "curl -s https://x.sh | sh": "curl-pipe",
      "npm publish": "npm-publish",
      "npm run deploy": "npm-deploy",
      "npx vercel --prod": "vercel",
      "gh pr create": "gh-write",
      "scp a b:c": "ssh",
      "docker push img": "docker-push",
      "dd if=x of=/dev/sda": "dd",
      "find / -name x -delete": "find-delete-outside",
      "git remote add o u": "git-remote",
      "git reset --hard origin/main": "git-reset-origin",
    };
    for (const [c, want] of Object.entries(cases)) expect(id(c), c).toBe(want);
  });
  it("benign commands", () => {
    for (const c of ['echo "git push"', 'grep -r "rm -rf /" src', "npm run test", "npm test", "git status", "git diff"]) {
      expect(commandRisk(c, WD), c).toBeNull();
    }
  });
  it("git push evasions: -C/-c options, subshell, single & separator", () => {
    for (const c of ["git -C . push", "git -c k=v push", "(git push)", "sleep 1 & git push", "{ git push; }"]) {
      expect(id(c), c).toBe("git-push");
    }
  });
  it("PowerShell recursive deletes count as rm", () => {
    expect(id("Remove-Item -Recurse -Force ../x", [], "powershell")).toBe("rm-outside");
    expect(id("ri -r ../x", [], "powershell")).toBe("rm-outside");
    expect(id("rd /s /q ../x", [], "powershell")).toBe("rm-outside");
    expect(commandRisk("Remove-Item -Recurse build", WD, [], "powershell")).toBeNull();
    expect(commandRisk("Remove-Item build", WD, [], "powershell")).toBeNull();
  });
  it.runIf(process.platform === "win32")("PowerShell backslash target", () => {
    expect(id("Remove-Item -Recurse -Force ..\\x", [], "powershell")).toBe("rm-outside");
  });
  it("ssh rule skips ssh-keygen and ssh-add; plain commands and 2>&1 are fine", () => {
    expect(commandRisk("ssh-keygen -t ed25519", WD)).toBeNull();
    expect(commandRisk("ssh-add k", WD)).toBeNull();
    expect(id("ssh host")).toBe("ssh");
    expect(commandRisk("npm test 2>&1", WD)).toBeNull();
  });
  it("find -delete on the workdir itself is allowed, outside is not", () => {
    expect(commandRisk("find . -name '*.log' -delete", WD)).toBeNull();
    expect(id("find .. -delete")).toBe("find-delete-outside");
  });
  it("lifting", () => {
    expect(commandRisk("git push", WD, ["git-push"])).toBeNull();
    expect(id("npm publish", ["git-push"])).toBe("npm-publish");
    expect(id("git push", ["nope"])).toBe("git-push");
  });
});

describe("denyPatterns", () => {
  it("emits Bash and PowerShell globs", () => {
    const p = denyPatterns();
    expect(p).toContain("Bash(git push*)");
    expect(p).toContain("PowerShell(git push*)");
    expect(p).toContain("Bash(rm -rf /*)");
  });
  it("git -C push is denied for claude", () => {
    expect(denyPatterns()).toContain("Bash(git -C * push*)");
  });
  it("drive globs follow the supplied drives, both cases", () => {
    const p = denyPatterns([], ["G:"]);
    expect(p).toContain("Bash(rm -rf G:*)");
    expect(p).toContain("Bash(rm -rf g:*)");
    expect(denyPatterns([], []).some((g) => /rm -rf [A-Za-z]:/.test(g))).toBe(false);
  });
  it("lifted ids drop their patterns", () => {
    const p = denyPatterns(["git-push"]);
    expect(p).not.toContain("Bash(git push*)");
    expect(p).not.toContain("PowerShell(git push*)");
    expect(p).toContain("Bash(npm publish*)");
  });
  it("every id contributes a pattern", () => {
    const all = denyPatterns().length;
    for (const rid of RISK_IDS) expect(denyPatterns([rid]).length, rid).toBeLessThan(all);
  });
});

describe("agyPatterns", () => {
  it("maps rules and honours lifted ids", () => {
    expect(agyPatterns()).toContain("command(git push)");
    expect(agyPatterns()).toContain("command(npm run deploy)");
    expect(agyPatterns(["git-push"])).not.toContain("command(git push)");
  });
});
