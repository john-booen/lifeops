import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BailianRealtimeClient } from "../src/bailianRealtime";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { setProviderEgressSink } from "../src/privacy";
import { ServerVoiceEndpoint } from "../src/voice/continuousInput";

const { Socket, sockets } = vi.hoisted(() => {
  class Socket {
    static CONNECTING = 0;
    static OPEN = 1;
    readyState = Socket.CONNECTING;
    bufferedAmount = 0;
    sent: Array<Buffer | string> = [];
    handlers = new Map<string, (...args: any[]) => void>();
    constructor(readonly address: URL | string) { sockets.push(this); }
    on(event: string, callback: (...args: any[]) => void) { this.handlers.set(event, callback); }
    send(value: Buffer | string) { this.sent.push(value); }
    open() { this.readyState = Socket.OPEN; this.handlers.get("open")?.(); }
    message(value: unknown) { this.handlers.get("message")?.(Buffer.from(JSON.stringify(value))); }
    close() { this.readyState = 3; this.handlers.get("close")?.(1000, Buffer.alloc(0)); }
    terminate() { this.close(); }
  }
  const sockets: Socket[] = [];
  return { Socket, sockets };
});
vi.mock("ws", () => ({ default: Socket }));
vi.mock("obsidian", () => ({ Notice: class {} }));

const settings = { ...DEFAULT_SETTINGS.realtimeVoice, asrEngine: "streaming-hotwords" as const, mode: "cascade" as const,
  apiKey: "synthetic-key", dataDisclosureAccepted: true, plaintextCredentialStorageAccepted: true,
  asrHotwords: "沈知禾， 蓝色样品盒\n沈知禾" };
const audio = Buffer.from([1, 2, 3, 4]);

beforeEach(() => {
  sockets.length = 0;
  vi.stubGlobal("window", { setTimeout, clearTimeout });
});
afterEach(() => { setProviderEgressSink(null); vi.unstubAllGlobals(); });

it("sends audio only after the provider accepts the opt-in task and delivers one final per sentence", async () => {
  const egress: unknown[] = [];
  setProviderEgressSink(async record => { egress.push(record); });
  const accept = new ServerVoiceEndpoint();
  const received: string[] = [];
  const client = new BailianRealtimeClient(settings, {
    onCascadeCapture(event) {
      // The panel resets draft text when it interrupts playback.
      if (event.type === "started") client.resetTranscript();
      const ready = accept.accept(event)?.ready;
      if (ready) received.push(ready);
    }
  });
  const pending = client.connect();
  const socket = sockets[0];
  socket.open();
  client.appendPcm16(audio.toString("base64"));
  expect(socket.sent).toHaveLength(1);
  expect(String(socket.address)).toBe("wss://dashscope.aliyuncs.com/api-ws/v1/inference");
  const request = JSON.parse(String(socket.sent[0]));
  expect(request.payload).toMatchObject({ model: "qwen-audio-3.1-asr-flash-streaming",
    parameters: { format: "pcm", sample_rate: 16000, vocabulary: { 沈知禾: 5, 蓝色样品盒: 5 } } });
  const taskId = request.header.task_id;
  const emit = (event: string, sentence?: Record<string, unknown>, owner = taskId) => socket.message({
    header: { event, task_id: owner }, payload: { output: { sentence } }
  });
  emit("task-started");
  await pending;
  client.appendPcm16(audio.toString("base64"));
  expect(socket.sent[1]).toEqual(audio);
  emit("result-generated", { text: "虚构来电", sentence_end: true, end_time: 200 }, "different-task");
  emit("result-generated", { text: "提醒我", sentence_end: false });
  expect(received).toEqual([]);
  const first = { text: "提醒我给蓝色样品盒贴标签", sentence_end: true, end_time: 900 };
  emit("result-generated", first);
  emit("result-generated", first);
  emit("result-generated", { text: "撤销", sentence_end: true, end_time: 1800 });
  client.close();
  emit("result-generated", { text: "迟到的转写", sentence_end: true, end_time: 1900 });
  expect(received).toEqual([first.text, "撤销"]);
  expect(egress).toEqual([
    expect.objectContaining({ capability: "voice", purpose: "realtime_connection", sourceCount: 0 }),
    expect.objectContaining({ purpose: "realtime_audio_turn", requestBytes: 4 })
  ]);
  expect(JSON.stringify(egress)).not.toMatch(/沈知禾|蓝色样品盒|synthetic-key/);
});

it("keeps the old endpoint by default, and never sends hotwords without consent or to another host", async () => {
  await expect(new BailianRealtimeClient({ ...settings, dataDisclosureAccepted: false }).connect()).rejects.toThrow();
  await expect(new BailianRealtimeClient({ ...settings, endpoint: "wss://dashscope.aliyuncs.com.example.org" }).connect())
    .rejects.toThrow("百炼官方语音地址");
  expect(sockets).toHaveLength(0);
  const old = new BailianRealtimeClient({ ...settings, asrEngine: undefined });
  const pending = old.connect();
  const socket = sockets[0];
  socket.open();
  await pending;
  expect(String(socket.address)).toContain("/api-ws/v1/realtime?model=");
  expect(JSON.parse(String(socket.sent[0])).type).toBe("session.update");
  expect(JSON.stringify(socket.sent)).not.toContain("沈知禾");
  old.close();
});
