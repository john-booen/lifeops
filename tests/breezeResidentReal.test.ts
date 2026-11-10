import { describe, expect, it } from "vitest";
import { setTimeout as wait } from "node:timers/promises";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { migrateRealtimeVoiceSettings } from "../src/settingsMigration";
import { BreezeResidentWorker } from "../src/voice/breezeResident";

const real = process.env.BREEZE_REAL_LOCAL === "1" ? describe : describe.skip;

real("resident Breeze on the local Mac", () => {
  it("synthesizes ten short sentences after one warmup and recovers from cancellation", async () => {
    const worker = new BreezeResidentWorker(migrateRealtimeVoiceSettings({ ...DEFAULT_SETTINGS.realtimeVoice, ttsEngine: "breeze-local" }));
    const samples = ["早上好。", "我听到了。", "今天还有三件事。", "已经记好了。", "稍等一下。", "现在可以继续。",
      "请先核对时间。", "这周完成两次。", "我把结果放在面板了。", "今天先做到这里。"];
    const firstFrames: number[] = [];
    try {
      const warmup = performance.now();
      await worker.warm();
      const warmupMs = Math.round(performance.now() - warmup);
      for (const sentence of samples) {
        let first: number | undefined, bytes = 0;
        const start = performance.now();
        await worker.speak(sentence, pcm => { first ??= performance.now() - start; bytes += Buffer.from(pcm, "base64").length; });
        expect(bytes).toBeGreaterThan(1000);
        expect(first).toBeDefined();
        firstFrames.push(Math.round(first!));
      }
      const abort = new AbortController();
      let cancelledFrames = 0, resumedFrames = 0;
      const cancelled = worker.speak("这一句是准备取消的虚构测试语音。", () => { cancelledFrames++; }, abort.signal);
      const settled = expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
      await wait(50); abort.abort(); await settled;
      await worker.speak("取消后还能继续。", () => { resumedFrames++; });
      expect(cancelledFrames).toBe(0); expect(resumedFrames).toBeGreaterThan(0);
      const ordered = [...firstFrames].sort((a, b) => a - b);
      process.stdout.write(`Breeze 常驻实测 ${JSON.stringify({ warmupMs, firstFrames, p50: ordered[4], p90: ordered[8] })}\n`);
    } finally { await worker.close(); }
  }, 180_000);
});
