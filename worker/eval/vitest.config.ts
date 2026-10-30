import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The live prompt eval. Not part of `npm test`: it calls the real models and costs a few cents a run.
export default defineConfig({
  root: fileURLToPath(new URL("..", import.meta.url)),
  test: {
    environment: "node",
    include: ["eval/**/*.eval.ts"],
    testTimeout: 240_000,
  },
});
