import { parseVerdict } from "../relay/prompts.js";

// S6: past DIFF_PROMPT_CAP the reviewer can no longer see the whole diff. Rather
// than stat+truncate (which hides real source changes), split the diff into
// per-directory groups and review each separately, carrying the whole-diff stat
// into every chunk so the reviewer knows what it is NOT seeing.

export type ReviewChunk = { group: string; payload: string };

// Directory group for a file path: the first two segments of its DIRECTORY
// (path minus filename). Top-level files group under "(root)".
//   src/forge/runs.ts   -> "src/forge"
//   app/src/routes/x.ts -> "app/src"
//   tests/foo.test.ts   -> "tests"
//   README.md           -> "(root)"
function groupKey(path: string): string {
  const dir = path.split("/").slice(0, -1);
  return dir.length ? dir.slice(0, 2).join("/") : "(root)";
}

// Split a unified diff into per-file blocks keyed by the a/<path> header.
function splitFiles(diff: string): { path: string; text: string }[] {
  return diff
    .split(/(?=^diff --git )/m)
    .filter((s) => s.startsWith("diff --git "))
    .map((text) => {
      const m = text.match(/^diff --git a\/(\S+) b\//);
      return { path: m ? m[1] : "", text };
    });
}

// One chunk when the diff fits under the cap (identical to the pre-S6 payload:
// the elided diff verbatim). Over the cap, one chunk per directory group, each
// stamped with the whole-diff stat and capped so no chunk exceeds `cap`.
export function chunkReviewDiff(elidedDiff: string, stat: string, cap: number): ReviewChunk[] {
  if (elidedDiff.length <= cap) return [{ group: "", payload: elidedDiff }];

  const groups = new Map<string, string>();
  for (const f of splitFiles(elidedDiff)) {
    const k = groupKey(f.path);
    groups.set(k, (groups.get(k) ?? "") + f.text);
  }
  const stamp = (group: string, body: string): string => {
    const preamble = `[review chunk ${group} -- the whole-diff stat is below; you see only this directory's diff]\n${stat}\n\n`;
    // ponytail: stat assumed << cap (git --stat of a change set is a few hundred
    // chars). If stat alone exceeds cap the preamble still ships whole and the
    // body drops to empty -- correctness over the pathological case.
    const room = cap - preamble.length;
    return room >= body.length ? preamble + body : preamble + body.slice(0, Math.max(0, room));
  };
  return [...groups].map(([group, body]) => ({ group, payload: stamp(group, body) }));
}

// FAIL if ANY chunk fails. Concatenate the per-chunk reports under a header
// naming each group; single-chunk runs keep the reviewer's raw output verbatim.
export function mergeReviewVerdicts(chunks: ReviewChunk[], rawOutputs: string[]): { pass: boolean; raw: string } {
  const verdicts = rawOutputs.map(parseVerdict);
  const pass = verdicts.every((v) => v.pass);
  if (chunks.length === 1) return { pass, raw: verdicts[0].raw };
  const raw =
    chunks.map((c, i) => `=== review chunk: ${c.group} ===\n${verdicts[i].raw}`).join("\n\n") +
    `\n\nVERDICT: ${pass ? "PASS" : "FAIL"}`;
  return { pass, raw };
}
