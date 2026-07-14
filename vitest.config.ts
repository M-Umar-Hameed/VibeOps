import { defineConfig } from "vitest/config";

// Root suite is the server only; the app under app/ has its own vitest config.
export default defineConfig({
  // 30s default: this suite is integration-heavy (shared Postgres, spawned
  // servers, embeddings) — 5s starves ordinary API tests under parallel load.
  test: { include: ["tests/**/*.test.ts"], globalSetup: "tests/global-setup.ts", testTimeout: 30_000 },
});
