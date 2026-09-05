import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    passWithNoTests: false,
    testTimeout: 10_000,
    hookTimeout: 10_000,
    restoreMocks: true,
  },
});
