import { defineWorkspace } from "vitest/config";

// Vector-dependent tests share the embeddings table and query via HNSW approximate
// search. Under parallel load, rows written by one test can crowd another's exact-
// match rows out of the ANN candidate pool — a structural constraint of approximate
// nearest-neighbor indexes, not a bug. These tests serialize to avoid interference.
const vectorTests = [
  "tests/knowledge-search.test.ts",
  "tests/knowledge-graph.test.ts",
  "tests/knowledge-scope.test.ts",
];

export default defineWorkspace([
  {
    // Main pool: all non-vector tests run in parallel (default behavior).
    test: {
      name: "main",
      include: ["tests/**/*.test.ts"],
      exclude: vectorTests,
      globalSetup: "tests/global-setup.ts",
      testTimeout: 30_000,
    },
  },
  {
    // Vector pool: these tests run sequentially to avoid HNSW recall interference.
    // fileParallelism: false ensures the files run one at a time; tests within each
    // file still run concurrently (which is fine — they scope via unique timestamps).
    test: {
      name: "vector",
      include: vectorTests,
      globalSetup: "tests/global-setup.ts",
      testTimeout: 30_000,
      fileParallelism: false,
    },
  },
]);
