import { defineConfig } from "vitest/config";

export default defineConfig({ test: {
  include: ["tests/eval/deviceSync.eval.ts"],
  fileParallelism: false,
  testTimeout: 180_000,
  hookTimeout: 30_000
} });
