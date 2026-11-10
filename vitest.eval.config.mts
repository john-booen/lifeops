import { defineConfig } from "vitest/config";

process.env.TZ = "Asia/Shanghai";

const voiceOnly = process.env.LIFEOPS_VOICE_EVAL === "1";
if (voiceOnly && process.env.LIFEOPS_EVAL_GATE) throw Error("语音基线不能替代正式文字评测");

export default defineConfig({
  test: {
    include: [voiceOnly ? "tests/eval/voiceLatency.eval.ts" : "tests/eval/run.eval.ts"],
    fileParallelism: false,
    testTimeout: 900_000,
    hookTimeout: 120_000
  }
});
