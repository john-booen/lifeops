import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BailianRealtimeTtsClient } from "../src/bailianTtsRealtime";
import { DEFAULT_SETTINGS } from "../src/defaults";
import type { RealtimeProviderRunEvent } from "../src/voice/realtimeProviderRun";
import { setProviderEgressSink } from "../src/privacy";

const sockets = vi.hoisted(() => {
  type Handler = (...args: any[]) => void;
  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 3;
    readyState = FakeWebSocket.CONNECTING;
    sent: Record<string, unknown>[] = [];
    handlers = new Map<string, Handler[]>();
    constructor(readonly url: string, readonly options?: any) { instances.push(this); }
    on(event: string, handler: Handler) {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
      return this;
    }
    emit(event: string, ...args: unknown[]) {
      if (event === "open") this.readyState = FakeWebSocket.OPEN;
      if (event === "close") this.readyState = FakeWebSocket.CLOSED;
      for (const handler of this.handlers.get(event) ?? []) handler(...args);
    }
    message(value: unknown) { this.emit("message", JSON.stringify(value)); }
    send(value: string, callback?: (error?: Error) => void) { this.sent.push(JSON.parse(value)); callback?.(); }
    close(code = 1000) { this.emit("close", code, Buffer.alloc(0)); }
    terminate() { this.readyState = FakeWebSocket.CLOSED; }
  }
  const instances: FakeWebSocket[] = [];
  return { FakeWebSocket, instances };
});

vi.mock("ws", () => ({ default: sockets.FakeWebSocket }));

const audio = Buffer.from([1, 0, 2, 0]).toString("base64");
function setup(overrides = {}) {
  const events: RealtimeProviderRunEvent[] = [];
  const callbacks = { onOpen: vi.fn(), onAudioDelta: vi.fn(), onResponseDone: vi.fn(), onError: vi.fn(), onProviderRun: vi.fn((event: RealtimeProviderRunEvent) => events.push(event)) };
  const client = new BailianRealtimeTtsClient({
    ...DEFAULT_SETTINGS.realtimeVoice,
    apiKey: "synthetic-secret", endpoint: "wss://synthetic.invalid/tts", ttsModel: "configured-tts", ttsSampleRate: 24000,
    dataDisclosureAccepted: true, plaintextCredentialStorageAccepted: true, ...overrides
  }, callbacks, { sessionId: "local-session", generation: 2, turnId: "local-turn" });
  return { client, events, callbacks };
}

beforeEach(() => {
  sockets.instances.length = 0;
  vi.useFakeTimers();
  vi.stubGlobal("window", { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout });
});
afterEach(() => { setProviderEgressSink(null); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("TTS provider completion contract", () => {
  it.each(["session.update", "input_text_buffer.commit"])("reports asynchronous TTS send failure at %s before the timeout", async frameType => {
    const { client, events, callbacks } = setup();
    const speaking = client.speak("虚构朗读输入");
    const finished = speaking.catch(error => error);
    const socket = sockets.instances[0];
    const send = socket.send.bind(socket);
    let completeSend: ((error?: Error) => void) | undefined;
    vi.spyOn(socket, "send").mockImplementation((frame, callback) => {
      if (JSON.parse(frame).type === frameType) {
        completeSend = callback;
        send(frame);
      } else send(frame, callback);
    });
    try {
      socket.emit("open");
      expect(completeSend).toBeTypeOf("function");
      completeSend?.(new Error("虚构音频发送失败 synthetic-secret"));
      expect(socket.readyState).toBe(sockets.FakeWebSocket.CLOSED);
      expect(await finished).toMatchObject({ code: "network" });
      expect(callbacks.onError).toHaveBeenCalledExactlyOnceWith("虚构音频发送失败 [REDACTED]");
      expect(events).toMatchObject([{ stage: "tts", errorCode: "network", run: { status: "failed" } }]);
      socket.message({ type: "response.audio.delta", delta: audio });
      socket.message({ type: "response.done", response: { status: "completed" } });
      expect(callbacks.onAudioDelta).not.toHaveBeenCalled();
      expect(callbacks.onResponseDone).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      client.cancel();
      await finished;
    }
  });

  it("ignores an asynchronous TTS send failure from a replaced request", async () => {
    const { client, events, callbacks } = setup();
    const old = client.speak("虚构旧答复").catch(error => error);
    const oldSocket = sockets.instances[0];
    let completeOldSend: ((error?: Error) => void) | undefined;
    vi.spyOn(oldSocket, "send").mockImplementationOnce((_frame, callback) => { completeOldSend = callback; });
    try {
      oldSocket.emit("open");
      expect(completeOldSend).toBeTypeOf("function");
      const current = client.speak("虚构新答复");
      const socket = sockets.instances[1];
      socket.emit("open");
      completeOldSend?.(new Error("虚构旧的发送失败"));
      expect(socket.readyState).toBe(sockets.FakeWebSocket.OPEN);
      expect(callbacks.onError).not.toHaveBeenCalled();
      socket.message({ type: "response.audio.delta", delta: audio });
      socket.message({ type: "response.done", response: { status: "completed" } });
      await current;
      expect(await old).toMatchObject({ name: "AbortError" });
      expect(events.map(event => event.run.status)).toEqual(["cancelled", "success"]);
    } finally {
      client.cancel();
    }
  });

  describe("documented TTS request", () => {
    it("sends unique event IDs and audits the exact UTF-8 request payloads", async () => {
      const records: any[] = [];
      setProviderEgressSink(record => { records.push(record); });
      const { client } = setup();
      const pending = client.speak(" 你好 world。 ");
      const socket = sockets.instances[0];
      socket.emit("open");
      socket.message({ type: "response.audio.delta", delta: audio });
      socket.message({ type: "response.done", response: { status: "completed" } });
      await pending;
      expect(socket.sent.map(event => event.type)).toEqual(["session.update", "input_text_buffer.append", "input_text_buffer.commit"]);
      const ids = socket.sent.map(event => event.event_id);
      expect(new Set(ids).size).toBe(3);
      for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      expect(socket.sent[1]).toMatchObject({ text: "你好 world。" });
      expect(records).toHaveLength(1);
      expect(records[0].requestBytes).toBe(Buffer.byteLength(socket.sent.map(event => JSON.stringify(event)).join("\n"), "utf8"));
      expect(vi.getTimerCount()).toBe(0);
    });

    it.each([
      ["zh", "Chinese"], ["zh-CN", "Chinese"], ["en", "English"],
      [" en-US ", "English"], ["", "Chinese"], ["unsupported", "Chinese"]
    ])("maps configured language %j to provider value %s", async (language, expected) => {
      const { client } = setup({ language });
      const pending = client.speak("合成输入");
      const socket = sockets.instances[0];
      socket.emit("open");
      socket.message({ type: "response.audio.delta", delta: audio });
      socket.message({ type: "response.done", response: { status: "completed" } });
      await pending;
      expect(socket.sent[0]).toMatchObject({ type: "session.update", session: { language_type: expected, mode: "commit" } });
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe("known credential audit redaction", () => {
    it.each([false, true])("protects TTS identities while retaining wire model and authentication (reported=%s)", async reported => {
      const model = "model-synthetic-secret", { client, events } = setup({ ttsModel: model }), records: any[] = [], shared: any[] = [];
      setProviderEgressSink(record => { records.push(record); });
      const pending = client.speak("合成输入", { onProviderRun: run => { shared.push(run); } }), socket = sockets.instances[0];
      expect(new URL(socket.url).searchParams.get("model")).toBe(model); expect(socket.options.headers.Authorization).toBe("Bearer synthetic-secret");
      socket.emit("open"); socket.message({ type: "response.created", response: { id: "redaction-tts", ...(reported ? { model: "reported-synthetic-secret" } : {}) } });
      socket.message({ type: "response.audio.delta", response_id: "redaction-tts", delta: audio });
      socket.message({ type: "response.done", response: { id: "redaction-tts", status: "completed" } }); await pending;
      expect(events[0].run).toMatchObject({ requestedModel: "unknown", actualModel: "unknown", modelIdentitySource: "configured", status: "success", attempts: [{ model: "unknown" }] });
      expect(shared).toEqual([events[0].run]); expect(records).toHaveLength(1); expect(records[0].model).toBe("unknown");
      expect(JSON.stringify({ events, records, shared })).not.toContain("synthetic-secret"); expect(vi.getTimerCount()).toBe(0);
    });
    it("protects zero-attempt TTS configuration failure", async () => {
      const { client, events } = setup({ ttsModel: "model-synthetic-secret", dataDisclosureAccepted: false });
      const error = await client.speak("合成输入").catch(error => error);
      expect(error).toMatchObject({ code: "configuration" }); expect(events[0].run).toMatchObject({ requestedModel: "unknown", status: "failed", attempts: [] });
      expect(JSON.stringify({ error, events })).not.toContain("synthetic-secret"); expect(sockets.instances).toHaveLength(0);
    });
  });
  it.each(["response.done", "response.completed"])("waits through open and audio.done until %s, then records exactly one success", async (type) => {
    const { client, events, callbacks } = setup();
    const onProviderRun = vi.fn();
    const settled = vi.fn();
    const speaking = client.speak("合成朗读输入", { onProviderRun });
    void speaking.then(settled);
    const socket = sockets.instances[0];
    socket.emit("open");
    socket.message({ type: "response.created", response: { id: "remote-response", model: "reported-tts" } });
    socket.message({ type: "response.audio.delta", response_id: "remote-response", delta: audio });
    socket.message({ type: "response.audio.done", response_id: "remote-response" });
    socket.message({ type: "response.output_audio.done", response_id: "remote-response" });
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
    expect(callbacks.onResponseDone).not.toHaveBeenCalled();
    expect(callbacks.onAudioDelta).toHaveBeenCalledWith(audio, 24000);
    expect(socket.sent.map(event => event.type)).toEqual(["session.update", "input_text_buffer.append", "input_text_buffer.commit"]);

    socket.message({ type, response: { id: "remote-response", status: "completed" } });
    await speaking;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ stage: "tts", responseId: "remote-response", context: { sessionId: "local-session", generation: 2, turnId: "local-turn" }, run: {
      requestedProvider: "bailian-realtime", requestedModel: "configured-tts", actualProvider: "bailian-realtime", actualModel: "reported-tts", modelIdentitySource: "response", status: "success", fallbackUsed: false,
      attempts: [{ provider: "bailian-realtime", model: "configured-tts", transport: "websocket", status: "success" }]
    } });
    expect(events[0].traceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(onProviderRun).toHaveBeenCalledWith(events[0].run);
    expect(callbacks.onResponseDone).toHaveBeenCalledOnce();
    socket.message({ type, response: { status: "completed" } });
    socket.emit("error", new Error("late error"));
    client.cancel();
    expect(events).toHaveLength(1);
    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["response.done", "response.completed"])("keeps missing-status compatibility for %s with valid audio", async (type) => {
    const { client, events } = setup();
    const speaking = client.speak("合成输入");
    const socket = sockets.instances[0];
    socket.emit("open");
    socket.message({ type: "response.output_audio.delta", delta: audio });
    socket.message({ type });
    await speaking;
    expect(events[0].run).toMatchObject({ status: "success", actualModel: "configured-tts", modelIdentitySource: "configured" });
  });

  it.each(["response.done", "response.completed", "session.finished"])("rejects %s without audio instead of claiming success", async (type) => {
    const { client, events, callbacks } = setup();
    const rejection = expect(client.speak("合成输入")).rejects.toMatchObject({ code: "invalid_response" });
    const socket = sockets.instances[0];
    socket.emit("open");
    socket.message({ type });
    await rejection;
    expect(events[0].run).toMatchObject({ status: "failed", attempts: [{ errorCode: "invalid_response" }] });
    expect(events[0].run.actualModel).toBeUndefined();
    expect(callbacks.onResponseDone).not.toHaveBeenCalled();
  });

  it.each([null, {}, { type: {} }])("settles an invalid TTS event %j and clears the playback request", async event => {
    const { client, events, callbacks } = setup();
    const rejection = expect(client.speak("合成输入")).rejects.toMatchObject({ code: "invalid_response" });
    const socket = sockets.instances[0];
    socket.emit("open");
    socket.message(event);
    await rejection;
    expect(events).toHaveLength(1);
    expect(callbacks.onError).toHaveBeenCalledOnce();
    expect(callbacks.onResponseDone).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not treat session.finished as success even after audio", async () => {
    const { client, events } = setup();
    const rejection = expect(client.speak("合成输入")).rejects.toMatchObject({ code: "invalid_response" });
    const socket = sockets.instances[0];
    socket.emit("open");
    socket.message({ type: "response.audio.delta", delta: audio });
    socket.message({ type: "session.finished" });
    await rejection;
    expect(events).toHaveLength(1);
    expect(events[0].run.status).toBe("failed");
  });

  it.each(["failed", "incomplete", "cancelled"])("does not claim success for terminal status %s despite audio", async (status) => {
    const { client, events } = setup();
    const rejection = expect(client.speak("合成输入")).rejects.toMatchObject({ code: status === "cancelled" ? "cancelled" : "invalid_response" });
    const socket = sockets.instances[0];
    socket.emit("open");
    socket.message({ type: "response.audio.delta", delta: audio });
    socket.message({ type: "response.done", response: { status } });
    await rejection;
    expect(events[0].run.status).toBe(status === "cancelled" ? "cancelled" : "failed");
  });

  it.each([
    [{ code: "invalid_api_key", message: "synthetic-secret unauthorized" }, "auth"],
    [{ code: "rate_limit_exceeded", status_code: 429, message: "synthetic-secret too many requests" }, "rate_limit"],
    [{ message: "synthetic-secret timed out" }, "timeout"],
    [{ message: "synthetic-secret connection lost" }, "network"]
  ])("classifies provider errors and excludes private payloads from metadata: %s", async (error, code) => {
    const { client, events, callbacks } = setup();
    const rejection = expect(client.speak("私有合成输入")).rejects.toMatchObject({ code });
    const socket = sockets.instances[0];
    socket.emit("open");
    socket.message({ type: "error", error });
    socket.emit("close", 1000, Buffer.from("late close"));
    await rejection;
    expect(events).toHaveLength(1);
    expect(events[0].run.attempts[0].errorCode).toBe(code);
    const metadata = JSON.stringify(events[0].run);
    expect(metadata).not.toMatch(/synthetic-secret|私有合成输入|synthetic\.invalid|connection lost/);
    expect(callbacks.onError).toHaveBeenCalledOnce();
    expect(callbacks.onError.mock.calls[0][0]).not.toContain("synthetic-secret");
  });

  it("classifies an error nested in failed response details", async () => {
    const { client, events } = setup();
    const rejection = expect(client.speak("合成输入")).rejects.toMatchObject({ code: "auth" });
    const socket = sockets.instances[0];
    socket.emit("open");
    socket.message({ type: "response.done", response: { status: "failed", status_details: { error: { code: "authentication_error", status: 401 } } } });
    await rejection;
    expect(events[0].run.attempts[0]).toMatchObject({ errorCode: "auth", httpStatus: 401 });
  });

  it.each([false, true])("rejects passive close before/after open (opened=%s)", async (opened) => {
    const { client, events, callbacks } = setup();
    const rejection = expect(client.speak("合成输入")).rejects.toMatchObject({ code: "network" });
    const socket = sockets.instances[0];
    if (opened) socket.emit("open");
    socket.emit("close", 1000, Buffer.alloc(0));
    await rejection;
    expect(events).toHaveLength(1);
    expect(events[0].run.status).toBe("failed");
    expect(callbacks.onError).toHaveBeenCalledWith("连接关闭：1000");
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])("bounds connection and generation waits (opened=%s)", async (opened) => {
    const { client, events } = setup();
    const rejection = expect(client.speak("合成输入")).rejects.toMatchObject({ code: "timeout" });
    const socket = sockets.instances[0];
    if (opened) {
      socket.emit("open");
      socket.message({ type: "response.audio.delta", delta: audio });
      socket.message({ type: "response.audio.done" });
    }
    await vi.advanceTimersByTimeAsync(opened ? 60_000 : 12_000);
    await rejection;
    expect(events[0].run).toMatchObject({ status: "failed", attempts: [{ errorCode: "timeout" }] });
    expect(socket.readyState).toBe(sockets.FakeWebSocket.CLOSED);
    expect(sockets.instances).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels before transport on pre-abort and settles exactly once", async () => {
    const { client, events } = setup();
    const abort = new AbortController(); abort.abort();
    await expect(client.speak("合成输入", { signal: abort.signal })).rejects.toMatchObject({ name: "AbortError", code: "cancelled" });
    expect(events[0].run).toMatchObject({ status: "cancelled", attempts: [] });
    expect(sockets.instances).toHaveLength(0);
    client.cancel();
    expect(events).toHaveLength(1);
  });

  it("records caller first-audio timeout as failed while preserving silent abort semantics", async () => {
    const { client, events, callbacks } = setup();
    const rejection = expect(client.speak("合成输入")).rejects.toMatchObject({ name: "AbortError", code: "timeout" });
    const socket = sockets.instances[0];
    socket.emit("open");
    client.cancel("timeout");
    await rejection;
    expect(events[0].run).toMatchObject({ status: "failed", attempts: [{ status: "failed", errorCode: "timeout" }] });
    expect(socket.sent.at(-1)).toEqual({ type: "response.cancel" });
    expect(socket.readyState).toBe(sockets.FakeWebSocket.CLOSED);
    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(callbacks.onResponseDone).not.toHaveBeenCalled();
  });

  it("cancels a connecting socket before a late open can send text", async () => {
    const { client, events, callbacks } = setup();
    const rejection = expect(client.speak("合成输入")).rejects.toMatchObject({ code: "cancelled" });
    const socket = sockets.instances[0];
    client.cancel();
    expect(socket.readyState).toBe(sockets.FakeWebSocket.CLOSED);
    socket.emit("open");
    socket.message({ type: "response.audio.delta", delta: audio });
    await rejection;
    expect(socket.sent).toHaveLength(0);
    expect(callbacks.onOpen).not.toHaveBeenCalled();
    expect(callbacks.onAudioDelta).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("closes the captured socket even when sending cancellation fails", async () => {
    const { client, events } = setup();
    const rejection = expect(client.speak("合成输入")).rejects.toMatchObject({ code: "cancelled" });
    const socket = sockets.instances[0];
    socket.emit("open");
    vi.spyOn(socket, "send").mockImplementation(() => { throw new Error("send failed"); });
    client.cancel();
    await rejection;
    expect(socket.readyState).toBe(sockets.FakeWebSocket.CLOSED);
    expect(events).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["cancel", "signal", "replace"])("isolates old events and timers when a speak is cancelled through %s", async (kind) => {
    const { client, events, callbacks } = setup();
    const abort = new AbortController();
    const firstRejected = expect(client.speak("旧输入", { signal: abort.signal })).rejects.toMatchObject({ name: "AbortError", code: "cancelled" });
    const oldSocket = sockets.instances[0];
    oldSocket.emit("open");
    if (kind === "cancel") client.cancel();
    if (kind === "signal") abort.abort();
    const next = client.speak("新输入");
    await firstRejected;
    const socket = sockets.instances[1];
    oldSocket.emit("open");
    oldSocket.message({ type: "response.audio.delta", delta: audio });
    oldSocket.message({ type: "response.done", response: { status: "completed" } });
    oldSocket.emit("error", new Error("old socket error"));
    oldSocket.emit("close", 1006, Buffer.from("old close"));
    expect(events).toHaveLength(1);
    expect(events[0].run).toMatchObject({ status: "cancelled", attempts: [{ errorCode: "cancelled" }] });
    expect(callbacks.onOpen).toHaveBeenCalledOnce();
    expect(callbacks.onAudioDelta).not.toHaveBeenCalled();
    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(oldSocket.sent.filter(event => event.type === "input_text_buffer.commit")).toHaveLength(1);
    socket.emit("open");
    socket.message({ type: "response.audio.delta", delta: audio });
    socket.message({ type: "response.done" });
    await next;
    expect(events).toHaveLength(2);
    expect(events[1].run.status).toBe("success");
    expect(events[0].traceId).not.toBe(events[1].traceId);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores mismatched response IDs on the same socket", async () => {
    const { client, events } = setup();
    const speaking = client.speak("合成输入");
    const socket = sockets.instances[0];
    socket.emit("open");
    socket.message({ type: "response.created", response: { id: "owned-response" } });
    socket.message({ type: "response.audio.delta", response_id: "other-response", delta: audio });
    socket.message({ type: "response.done", response: { id: "other-response" } });
    expect(events).toHaveLength(0);
    socket.message({ type: "response.audio.delta", response_id: "owned-response", delta: audio });
    socket.message({ type: "response.done", response: { id: "owned-response" } });
    await speaking;
    expect(events).toHaveLength(1);
  });

  it.each(["not-base64!!", "AQ=="])("rejects malformed PCM audio: %s", async (delta) => {
    const { client, events, callbacks } = setup();
    const rejection = expect(client.speak("合成输入")).rejects.toMatchObject({ code: "invalid_response" });
    const socket = sockets.instances[0];
    socket.emit("open");
    socket.message({ type: "response.audio.delta", delta });
    await rejection;
    expect(events).toHaveLength(1);
    expect(callbacks.onAudioDelta).not.toHaveBeenCalled();
  });

  it("publishes blocked configuration without opening transport", async () => {
    const { client, events } = setup({ dataDisclosureAccepted: false });
    await expect(client.speak("合成输入")).rejects.toMatchObject({ code: "configuration" });
    expect(events[0].run).toMatchObject({ status: "failed", attempts: [] });
    expect(sockets.instances).toHaveLength(0);
  });

  it("does not retry or alter completion when metadata listeners throw", async () => {
    const { client, callbacks } = setup();
    callbacks.onProviderRun.mockImplementation(() => { throw new Error("metric failure"); });
    const speaking = client.speak("合成输入", { onProviderRun: () => { throw new Error("metric failure"); } });
    const socket = sockets.instances[0];
    socket.emit("open");
    socket.message({ type: "response.audio.delta", delta: audio });
    socket.message({ type: "response.done" });
    await speaking;
    expect(sockets.instances).toHaveLength(1);
    expect(callbacks.onResponseDone).toHaveBeenCalledOnce();
  });
});
