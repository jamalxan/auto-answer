import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["__tests__/**/*.test.ts"],
    // The suite is ~100 files and several import the whole trigger/CRM graph
    // dynamically; on a loaded CI runner the default 5s is too tight and
    // produced timeouts that pass in isolation.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
