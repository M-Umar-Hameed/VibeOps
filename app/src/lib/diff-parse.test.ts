import { describe, it, expect } from "vitest";
import { parseUnifiedDiff } from "./diff-parse.js";

describe("parseUnifiedDiff", () => {
  it("parses multi-file diffs including add, del, rename, and binary", () => {
    const diffText = `diff --git a/old.txt b/new.txt
similarity index 100%
rename from old.txt
rename to new.txt
diff --git a/app/src/lib/example.ts b/app/src/lib/example.ts
index e69de29..d95f3ad 100644
--- a/app/src/lib/example.ts
+++ b/app/src/lib/example.ts
@@ -1,3 +1,4 @@
 export function test() {
-  return 1;
+  return 2;
+  // more
 }
diff --git a/app/src/lib/binary.png b/app/src/lib/binary.png
new file mode 100644
index 0000000..e69de29
Binary files /dev/null and b/app/src/lib/binary.png differ`;

    const { files } = parseUnifiedDiff(diffText);
    expect(files.length).toBe(3);

    expect(files[0].path).toBe("new.txt");
    expect(files[0].additions).toBe(0);
    expect(files[0].deletions).toBe(0);
    expect(files[0].hunks.length).toBe(0);

    expect(files[1].path).toBe("app/src/lib/example.ts");
    expect(files[1].additions).toBe(2);
    expect(files[1].deletions).toBe(1);
    expect(files[1].hunks.length).toBe(1);
    expect(files[1].hunks[0].rows).toEqual([
      { left: 1, right: 1, type: "ctx", text: "export function test() {" },
      { left: 2, right: null, type: "del", text: "  return 1;" },
      { left: null, right: 2, type: "add", text: "  return 2;" },
      { left: null, right: 3, type: "add", text: "  // more" },
      { left: 3, right: 4, type: "ctx", text: "}" },
    ]);

    expect(files[2].path).toBe("app/src/lib/binary.png");
    expect(files[2].binary).toBe(true);
    expect(files[2].hunks.length).toBe(0);
  });
});
