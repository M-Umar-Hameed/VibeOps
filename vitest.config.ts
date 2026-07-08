import { defineConfig } from "vitest/config";

// Root suite is the server only; the app under app/ has its own vitest config.
export default defineConfig({
  test: { include: ["tests/**/*.test.ts"] },
});
