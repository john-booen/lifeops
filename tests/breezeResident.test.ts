import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { BreezeResidentWorker } from "../src/voice/breezeResident";
import { BreezeResidentTtsClient, BreezeSentenceBuffer } from "../src/voice/breezeSpeech";

interface Child extends EventEmitter { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn> }
const { children } = vi.hoisted(() => ({ children: [] as Child[] }));
vi.mock("node:child_process", () => ({ spawn: () => {
  const child: Child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn()
  });
  children.push(child);
  return child;
} }));

let root: string, settings = DEFAULT_SETTINGS.realtimeVoice;
const pcm = Buffer.from([1, 2, 3, 4]).toString("base64");
const frame = (child: Child, data: object) => child.stdout.write(JSON.stringify(data) + "\n");
async function commands(child: Child) {
  await vi.waitFor(() => expect(child.stdin.readableLength).toBeGreaterThan(0));
  return child.stdin.read().toString().trim().split("\n").map((line: string) => JSON.parse(line) as { id?: string; text?: string; cancel?: string });
}

beforeEach(async () => {
  children.length = 0;
  root = await mkdtemp(join(tmpdir(), "lifeops-resident-breeze-"));
  await mkdir(join(root, "work", "breeze-model-4bit"), { recursive: true });
  const python = join(root, "python"), referenceAudio = join(root, "voice.wav");
  await writeFile(python, "fictional executable"); await writeFile(referenceAudio, "fictional sample");
  settings = { ...DEFAULT_SETTINGS.realtimeVoice, ttsEngine: "breeze-local", breeze: { home: root, python, referenceAudio, referenceText: "虚构参考。" } };
});
afterEach(async () => { vi.useRealTimers(); await rm(root, { recursive: true, force: true }); });

describe("resident Breeze", () => {
  it("starts a first sentence before the stream ends and reuses the same model for the next sentence", async () => {
    const worker = new BreezeResidentWorker(settings), warm = worker.warm(), child = children[0];
    await commands(child); frame(child, { ready: true }); await warm;
    let release!: () => void;
    const next = new Promise<void>(resolve => { release = resolve; });
    const audio = vi.fn(), done = vi.fn();
    const client = new BreezeResidentTtsClient(settings, { onAudioDelta: audio, onResponseDone: done }, worker);
    const speech = client.speakStream((async function* () { yield "第一句。"; await next; yield "第二句。"; })());
    const [first] = await commands(child);
    expect(first.text).toBe("第一句。");
    frame(child, { id: first.id, seq: 0, pcm }); frame(child, { id: first.id, done: true });
    expect(audio).toHaveBeenCalledOnce(); expect(done).not.toHaveBeenCalled();
    release();
    const [second] = await commands(child);
    expect(second.text).toBe("第二句。");
    frame(child, { id: second.id, seq: 0, pcm }); frame(child, { id: second.id, done: true });
    await speech;
    expect(audio).toHaveBeenCalledTimes(2); expect(done).toHaveBeenCalledOnce(); expect(children).toHaveLength(1);
    const closed = worker.close(); child.emit("close"); await closed;
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("cancels by id and discards late frames without closing the acknowledged worker", async () => {
    const worker = new BreezeResidentWorker(settings), warm = worker.warm(), child = children[0];
    await commands(child); frame(child, { ready: true }); await warm;
    const abort = new AbortController(), audio = vi.fn();
    const speech = worker.speak("等待打断。", audio, abort.signal);
    const rejected = expect(speech).rejects.toMatchObject({ name: "AbortError" });
    const [first] = await commands(child);
    abort.abort(); await rejected;
    expect(await commands(child)).toEqual([{ cancel: first.id }]);
    frame(child, { id: first.id, seq: 0, pcm }); frame(child, { id: first.id, done: true, cancelled: true });
    expect(audio).not.toHaveBeenCalled(); expect(child.kill).not.toHaveBeenCalled();
    const resumed = worker.speak("继续。", audio), [second] = await commands(child);
    frame(child, { id: second.id, seq: 0, pcm }); frame(child, { id: second.id, done: true });
    await resumed; expect(audio).toHaveBeenCalledOnce();
    const closed = worker.close(); child.emit("close"); await closed;
  });

  it("tries one replacement after a crash and stops when it also exits", async () => {
    const worker = new BreezeResidentWorker(settings);
    const speech = worker.speak("虚构崩溃重试。", vi.fn());
    const rejected = expect(speech).rejects.toThrow("本地语音进程已退出");
    const first = children[0]; await commands(first); frame(first, { ready: true });
    await commands(first); first.emit("close");
    await vi.waitFor(() => expect(children).toHaveLength(2));
    const second = children[1]; await commands(second); frame(second, { ready: true });
    await commands(second); second.emit("close"); await rejected;
    expect(children).toHaveLength(2); await worker.close();
  });

  it("releases an unused warmed process at ten minutes", async () => {
    vi.useFakeTimers();
    const worker = new BreezeResidentWorker(settings), warm = worker.warm(), child = children[0];
    frame(child, { ready: true }); await warm;
    await vi.advanceTimersByTimeAsync(599_999); expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(child.kill).toHaveBeenCalledOnce();
    child.emit("close"); await worker.close();
  });

  it("reaps a worker that does not actually stop generating after cancellation", async () => {
    const worker = new BreezeResidentWorker(settings), warm = worker.warm(), child = children[0];
    await commands(child); frame(child, { ready: true }); await warm;
    const abort = new AbortController(), speech = worker.speak("取消没有回执。", vi.fn(), abort.signal);
    const rejected = expect(speech).rejects.toMatchObject({ name: "AbortError" });
    await commands(child);
    abort.abort(); await rejected;
    await vi.waitFor(() => expect(child.kill).toHaveBeenCalledWith("SIGKILL"), { timeout: 750 });
    child.emit("close"); await worker.close();
  });

  it("splits at sentence boundaries, at a comma for long sentences and at the worker limit", () => {
    const splitter = new BreezeSentenceBuffer();
    expect(splitter.push("第一句。第二")).toEqual(["第一句。"]);
    expect(splitter.push("句\n" + "字".repeat(25) + "，" + "字".repeat(16))).toEqual(["第二句", "字".repeat(25) + "，"]);
    const rest = splitter.push("字".repeat(110), true);
    expect(rest.map(item => item.length)).toEqual([120, 6]);
  });
});
