import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // testTimeout exceeds the longest in-test waitFor (6000ms). At the 5000ms
  // default a wait can outlive its own test, which fails as a timeout under load
  // rather than as the assertion that actually did not hold.
  test: { environment: "jsdom", setupFiles: ["./src/test-setup.ts"], globals: true, testTimeout: 15000 },
});
