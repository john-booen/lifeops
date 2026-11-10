import { describe, expect, it } from "vitest";
import { BreezeLocalTtsClient } from "../src/breezeLocalTts";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { migrateRealtimeVoiceSettings } from "../src/settingsMigration";
const testReal = process.env.BREEZE_REAL_LOCAL === "1" ? describe : describe.skip;
testReal("local Breeze real synthetic test", () => {
  it("generates real PCM through the LifeOps adapter", async () => {
    const chunks: Buffer[]=[]; let done=0;
    const c=new BreezeLocalTtsClient(migrateRealtimeVoiceSettings({...DEFAULT_SETTINGS.realtimeVoice,ttsEngine:"breeze-local"}), {onAudioDelta:(b,rate)=>{expect(rate).toBe(24000); chunks.push(Buffer.from(b,"base64"));}, onResponseDone:()=>done++});
    try { await c.speak("早上好，今天我们慢慢来。"); }
    finally { c.cancel(); await c.waitForIdle(); }
    const pcm = Buffer.concat(chunks);
    expect(chunks.length).toBeGreaterThan(0); expect(pcm.length).toBeGreaterThan(48000); expect(done).toBe(1);
    let peak = 0;
    for (let i = 0; i + 1 < pcm.length; i += 2) peak = Math.max(peak, Math.abs(pcm.readInt16LE(i)));
    expect(peak).toBeGreaterThan(100);
  }, 120_000);
  it("cancels a real worker before its first sound", async () => {
    const chunks: string[]=[]; const c=new BreezeLocalTtsClient(migrateRealtimeVoiceSettings({...DEFAULT_SETTINGS.realtimeVoice,ttsEngine:"breeze-local"}),{onAudioDelta:b=>chunks.push(b)});
    const result=c.speak("这是一个用来测试打断的虚构句子。").then(() => null, (error: unknown) => error);
    await new Promise(r=>setTimeout(r,500)); c.cancel();
    try { expect(await result).toMatchObject({name:"AbortError"}); }
    finally { c.cancel(); await c.waitForIdle(); }
    expect(chunks).toHaveLength(0);
  }, 10_000);
});
