import { expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// docker compose derives its project name from the working directory when the
// compose file has no top-level `name:`. A run told to touch the test DB from a
// sandbox dir (~/.vibeops/sandbox/<ticketId>/) would then create a rival project
// and strand a second container on host port 5433. Pinning `name:` makes every
// `docker compose up -d` address the SAME project from any cwd. This asserts the
// mechanism (the key is present and fixed), not a comment about it.
test("docker-compose.yml pins a fixed project name independent of cwd", () => {
  const path = fileURLToPath(new URL("../docker-compose.yml", import.meta.url));
  const text = readFileSync(path, "utf-8");
  const m = text.match(/^name:\s*(\S+)\s*$/m);
  expect(m?.[1]).toBe("tickets");
});
