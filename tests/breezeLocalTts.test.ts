import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS } from "../src/defaults";

const state = vi.hoisted(() => ({ children: [] as any[], spawnArgs: [] as any[] }));
vi.mock("node:child_process", () => ({
  spawn: (...args: any[]) => {
    state.spawnArgs.push(args);
    const child = new EventEmitter() as any;
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = vi.fn(); state.children.push(child); return child;
  }
}));
import { BreezeLocalTtsClient, createTtsClient } from "../src/breezeLocalTts";

let directory: string;
let settings = { ...DEFAULT_SETTINGS.realtimeVoice, ttsEngine: "breeze-local" as const };
function frame(pcm: Buffer): Buffer { const h=Buffer.alloc(4); h.writeUInt32BE(pcm.length); return Buffer.concat([h, pcm]); }

describe("local Breeze TTS", () => {
  beforeEach(async () => {
    state.children.length = 0; state.spawnArgs.length = 0;
    directory = await mkdtemp(join(tmpdir(), "lifeops-breeze-config-"));
    await mkdir(join(directory, "work", "breeze-model-4bit"), { recursive: true });
    const python = join(directory, "custom-python"), referenceAudio = join(directory, "reference.wav");
    await writeFile(python, "fictional executable"); await writeFile(referenceAudio, "fictional reference");
    settings = { ...DEFAULT_SETTINGS.realtimeVoice, ttsEngine: "breeze-local", breeze: { home: directory, python, referenceAudio, referenceText: "纯虚构参考文字。" } };
  });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
  it("keeps reply text in stdin and isolates Python imports from the host working directory", async () => {
    const c = new BreezeLocalTtsClient(settings);
    const p = c.speak("不能出现在命令行中的虚构文本");
    const [python, args, options] = state.spawnArgs[0];
    expect(python).toBe(settings.breeze!.python);
    expect(args.slice(0, 4)).toEqual(["-I", "-B", "-u", "-c"]);
    expect(args.join(" ")).not.toContain("不能出现在命令行中的虚构文本");
    expect(options.shell).toBe(false); expect(options.env.HF_HUB_OFFLINE).toBe("1");
    const request = JSON.parse(state.children[0].stdin.read().toString());
    expect(request.text).toBe("不能出现在命令行中的虚构文本");
    expect(request.breeze).toMatchObject(settings.breeze!);
    c.cancel(); state.children[0].emit("close", null);
    await expect(p).rejects.toMatchObject({ name: "AbortError" }); await c.waitForIdle();
  });
  it("stops between frames when a callback cancels synchronously inside the same chunk", async () => {
    const chunks: string[] = [];
    const c = new BreezeLocalTtsClient(settings, { onAudioDelta: b => { chunks.push(b); c.cancel(); } });
    const p = c.speak("测试同步打断"); const child = state.children[0];
    child.stdout.write(Buffer.concat([frame(Buffer.from([1, 2])), frame(Buffer.from([3, 4]))]));
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(chunks).toHaveLength(1); expect(child.kill).toHaveBeenCalledOnce();
    let closed = false; const idle = c.waitForIdle().then(() => { closed = true; });
    await Promise.resolve(); expect(closed).toBe(false);
    child.emit("close", null); await idle; expect(closed).toBe(true);
  });
  it("stops its worker if the UI open callback throws", async () => {
    const c = new BreezeLocalTtsClient(settings, { onOpen: () => { throw new Error("private UI detail"); } });
    await expect(c.speak("虚构界面异常")).rejects.toThrow("本地语音播放器无法启动");
    expect(state.children[0].kill).toHaveBeenCalledWith("SIGKILL");
    state.children[0].emit("close", null); await c.waitForIdle();
  });
  it("settles a throwing completion callback without leaking private error details", async () => {
    const c = new BreezeLocalTtsClient(settings, { onResponseDone: () => { throw new Error("private UI detail"); } });
    const p = c.speak("虚构收尾异常"); const child = state.children[0];
    child.stdout.write(frame(Buffer.from([1, 2]))); child.emit("close", 0);
    await expect(p).rejects.toThrow("本地语音播放收尾失败"); await c.waitForIdle();
  });
  it("decodes framed PCM in order, including split headers, and finishes once", async () => {
    const chunks: string[] = []; let done=0;
    const c = new BreezeLocalTtsClient(settings, { onAudioDelta: (b,rate) => { expect(rate).toBe(24000); chunks.push(b); }, onResponseDone: () => done++ });
    const result=c.speak("虚构测试句子"); const child=state.children[0];
    const wire=Buffer.concat([frame(Buffer.from([1,2,3,4])),frame(Buffer.from([5,6]))]);
    child.stdout.write(wire.subarray(0,2)); child.stdout.write(wire.subarray(2,8)); child.stdout.write(wire.subarray(8)); child.emit("close",0);
    await result; expect(chunks).toEqual([Buffer.from([1,2,3,4]).toString("base64"),Buffer.from([5,6]).toString("base64")]); expect(done).toBe(1);
  });
  it("interrupts the worker, rejects and ignores late audio", async () => {
    const chunks: string[] = []; let done=0; const c=new BreezeLocalTtsClient(settings,{onAudioDelta:b=>chunks.push(b),onResponseDone:()=>done++});
    const pending=c.speak("测试打断"); const child=state.children[0]; c.cancel();
    await expect(pending).rejects.toMatchObject({name:"AbortError"}); expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    child.stdout.write(frame(Buffer.from([1,2]))); child.emit("close",0); expect(chunks).toEqual([]); expect(done).toBe(0);
  });
  it("does not emit late audio or completion after cancellation during playback", async () => {
    const chunks: string[]=[]; let done=0;
    const c=new BreezeLocalTtsClient(settings,{onAudioDelta:b=>chunks.push(b),onResponseDone:()=>done++});
    const pending=c.speak("虚构测试句子"); const child=state.children[0];
    child.stdout.write(frame(Buffer.from([1,2]))); expect(chunks).toHaveLength(1);
    c.cancel(); await expect(pending).rejects.toMatchObject({name:"AbortError"});
    child.stdout.write(frame(Buffer.from([3,4]))); child.emit("close",0);
    expect(chunks).toHaveLength(1); expect(done).toBe(0); expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });
  it("rejects oversized replies without launching a subprocess", async () => {
    const c=new BreezeLocalTtsClient(settings); await expect(c.speak("字".repeat(121))).rejects.toThrow("120"); expect(state.children).toHaveLength(0);
  });
  it("reports a missing configured reference before launching inference", async () => {
    settings.breeze!.referenceAudio = join(directory, "missing.wav");
    await expect(new BreezeLocalTtsClient(settings).speak("纯虚构测试")).rejects.toThrow("参考音频");
    expect(state.children).toHaveLength(0);
  });
  it("rejects malformed and empty output instead of treating it as speech", async () => {
    const c=new BreezeLocalTtsClient(settings); const p=c.speak("测试"); const child=state.children[0];
    child.stdout.write(Buffer.alloc(4)); await expect(p).rejects.toThrow("无效"); expect(child.kill).toHaveBeenCalled();
  });
  it("keeps existing provider as default", () => {
    expect(createTtsClient(DEFAULT_SETTINGS.realtimeVoice, {})).not.toBeInstanceOf(BreezeLocalTtsClient);
    expect(createTtsClient(settings, {})).toBeInstanceOf(BreezeLocalTtsClient);
  });
});
