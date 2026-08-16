import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
  resolve: {
    // mirrors tsconfig.json "paths"
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
});
