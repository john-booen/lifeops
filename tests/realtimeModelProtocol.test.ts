import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { BailianRealtimeClient } from "../src/bailianRealtime";

const ws = vi.hoisted(() => {
  class Socket {
    static OPEN = 1;
    readyState = 0;
    sent: any[] = [];
    handlers = new Map<string, Function[]>();
    constructor() { sockets.push(this); }
    on(name: string, fn: Function) { this.handlers.set(name, [...(this.handlers.get(name) ?? []), fn]); return this; }
    emit(name: string, ...args: any[]) {
      if (name === "open") this.readyState = 1;
      if (name === "close") this.readyState = 3;
      for (const fn of this.handlers.get(name) ?? []) fn(...args);
    }
    send(raw: string) { this.sent.push(JSON.parse(raw)); }
    close() { this.emit("close", 1000, Buffer.alloc(0)); }
  }
  const sockets: Socket[] = [];
  return { Socket, sockets };
});
vi.mock("ws", () => ({ default: ws.Socket }));
vi.mock("obsidian", () => ({ Notice: class {} }));
const clients: BailianRealtimeClient[] = [];
const model38 = "qwen3.8-omni-flash-realtime";
beforeEach(() => {
  vi.useFakeTimers(); ws.sockets.length = 0;
  vi.stubGlobal("window", { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout });
});
afterEach(() => {
  clients.splice(0).forEach(client => client.close());
  vi.useRealTimers(); vi.unstubAllGlobals();
});
async function open(model: string, options: ConstructorParameters<typeof BailianRealtimeClient>[2] = {}) {
  const client = new BailianRealtimeClient({ ...DEFAULT_SETTINGS.realtimeVoice, model, mode: "omni-e2e",
    apiKey: "synthetic-key", dataDisclosureAccepted: true, plaintextCredentialStorageAccepted: true }, {}, options);
  clients.push(client);
  const connecting = client.connect(), socket = ws.sockets.at(-1)!;
  socket.emit("open"); await connecting;
  return { client, socket };
}

describe("model-specific realtime wire protocol", () => {
  it("uses the verified explicit PCM and server VAD combination only for 3.8", async () => {
    const { socket } = await open(model38, { instructions: "固定的虚构指令", tools: [{ type: "function", name: "read_example", parameters: { type: "object" } }] });
    const update = socket.sent[0];
    expect(update.event_id).toMatch(/^event_[0-9a-f-]+$/);
    expect(update.session).toMatchObject({
      modalities: ["text", "audio"], input_audio_transcription: { model: "qwen3-asr-flash-realtime" },
      audio: { input: { format: { type: "pcm", sample_rate: 16000 } }, output: { format: { type: "pcm", sample_rate: 24000 } } },
      turn_detection: { type: "server_vad", threshold: 0.35, silence_duration_ms: 1500, create_response: false, interrupt_response: false },
      instructions: "固定的虚构指令", tools: [{ type: "function", function: { name: "read_example", parameters: { type: "object" } } }]
    });
    expect(update.session).not.toHaveProperty("input_audio_format");
    expect(update.session).not.toHaveProperty("output_audio_format");
  });

  it.each(["qwen3.5-omni-plus-realtime-2026-03-15", "synthetic-omni", "qwen3.8-omni-flash-realtime-other"])("preserves legacy payload and message IDs for %s", async model => {
    const { client, socket } = await open(model, { instructions: "合成指令" });
    expect(socket.sent[0]).not.toHaveProperty("event_id");
    expect(socket.sent[0].session).toMatchObject({ input_audio_format: "pcm16", output_audio_format: "pcm16",
      turn_detection: { type: "semantic_vad", threshold: 0.8, create_response: false, interrupt_response: false } });
    expect(socket.sent[0].session).not.toHaveProperty("audio");
    client.appendPcm16("KgA="); client.createResponse();
    expect(socket.sent.slice(1)).toEqual([{ type: "input_audio_buffer.append", audio: "KgA=" }, { type: "response.create" }]);
  });

  it("adds distinct event IDs to 3.8 audio and response messages without mutating a caller payload", async () => {
    const { client, socket } = await open(` ${model38} `);
    client.appendPcm16("KgA="); client.createResponse();
    expect(socket.sent.map(event => event.type)).toEqual(["session.update", "input_audio_buffer.append", "response.create"]);
    const ids = socket.sent.map(event => event.event_id);
    expect(new Set(ids).size).toBe(3); ids.forEach(id => expect(id).toMatch(/^event_[0-9a-f-]+$/));
    const payload = { type: "session.update", event_id: "existing-context-nonce", session: { instructions: "新合成指令" } };
    (client as any).send(payload);
    expect(socket.sent.at(-1)).toEqual(payload);
    expect(payload).toEqual({ type: "session.update", event_id: "existing-context-nonce", session: { instructions: "新合成指令" } });
  });

  it("preserves the initial snapshot nonce and exact acknowledgement boundary for 3.8", async () => {
    const dispose = vi.fn(), assertCurrent = vi.fn();
    const { client, socket } = await open(model38, { initialInstructions: {
      instructions: "合成的首次上下文", baseInstructions: "合成基础规则", assertCurrent, dispose
    } });
    const update = socket.sent[0];
    expect(update.session.instructions).toContain("合成的首次上下文");
    expect(update.session.instructions).toContain(update.event_id);
    expect(update.session.instructions).toContain("不得朗读");
    client.createResponse(); expect(socket.sent).toHaveLength(1);
    socket.emit("message", JSON.stringify({ type: "session.updated", session: { instructions: "错误的合成上下文" } }));
    expect(dispose).not.toHaveBeenCalled(); expect(socket.sent).toHaveLength(1);
    socket.emit("message", JSON.stringify({ type: "session.updated", session: { instructions: update.session.instructions } }));
    expect(dispose).toHaveBeenCalledOnce();
    expect(socket.sent.at(-1).type).toBe("response.create");
    expect(socket.sent.at(-1).event_id).not.toBe(update.event_id);
  });
});
