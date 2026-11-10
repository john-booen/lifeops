import { defineConfig } from "vitest/config";
import { isAbsolute } from "node:path";
import { COVERAGE_TARGETS } from "./scripts/coverage-gate.mjs";

const reportsDirectory = process.env.LIFEOPS_COVERAGE_DIRECTORY;
if (!reportsDirectory || !isAbsolute(reportsDirectory)) {
  throw new Error("Use scripts/verify-ci-local.mjs to allocate an isolated coverage directory");
}
export default defineConfig({
  test: {
    dir: "tests", include: ["**/*.test.ts"],
    fileParallelism: false,
    coverage: {
      enabled: true, provider: "v8", include: Object.keys(COVERAGE_TARGETS),
      reporter: ["json-summary", "json", "text-summary"], reportsDirectory,
      clean: false, reportOnFailure: false
    }
  }
});
