import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
      // the agent imports the shared contract through this alias
      "@shared": resolve(__dirname, "./src/lib/shared"),
    },
  },
});
