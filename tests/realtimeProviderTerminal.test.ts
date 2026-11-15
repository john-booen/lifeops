import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { BailianRealtimeClient, UNCONFIRMED_VOICE_CANCEL_MESSAGE } from "../src/bailianRealtime";
import type { RealtimeProviderRunEvent } from "../src/voice/realtimeProviderRun";
import { VoiceSessionController, VoiceRuntimeJournal } from "../src/voice/voiceRuntime";
import { createVoiceSession } from "../src/voiceSession";
import { ServerVoiceEndpoint, type CascadeCaptureEvent } from "../src/voice/continuousInput";
import { setProviderEgressSink } from "../src/privacy";
import { serializeQualityLogEntry } from "../src/qualityLog";
import { finishOmniE2eVoiceTurn, handleOmniE2eAudioOutputEvent, interruptManagedVoiceTurn, recordVoiceProviderRun,
  startSystemSpeechForActiveTurn, stopBailianRealtimeRecording } from "../src/voice/voiceRealtime";

const ws = vi.hoisted(() => {
  class Socket {
    static CONNECTING = 0; static OPEN = 1; static CLOSED = 3;
    readyState = 0; sent: any[] = []; handlers = new Map<string, Function[]>();
    constructor(readonly url?: string, readonly options?: any) { sockets.push(this); }
    on(name: string, fn: Function) { this.handlers.set(name, [...(this.handlers.get(name) ?? []), fn]); return this; }
    emit(name: string, ...args: any[]) {
      if (name === "open") this.readyState = 1;
      if (name === "close") this.readyState = 3;
      for (const fn of this.handlers.get(name) ?? []) fn(...args);
    }
    message(value: unknown) { this.emit("message", JSON.stringify(value)); }
    send(value: string, callback?: (error?: Error) => void) { this.sent.push(JSON.parse(value)); callback?.(); }
    close() { this.emit("close", 1000, Buffer.alloc(0)); }
    terminate() { this.readyState = 3; }
  }
  const sockets: Socket[] = []; return { Socket, sockets };
});
vi.mock("ws", () => ({ default: ws.Socket }));
vi.mock("obsidian", () => ({ Notice: class {} }));
const settings = { ...DEFAULT_SETTINGS.realtimeVoice, apiKey: "synthetic-key", dataDisclosureAccepted: true,
  plaintextCredentialStorageAccepted: true, mode: "omni-e2e" as const, model: "synthetic-omni", speakReplies: true };
const pcm = Buffer.from(new Int16Array([42, -42]).buffer).toString("base64");
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
beforeEach(() => {
  vi.useFakeTimers(); ws.sockets.length = 0;
  vi.stubGlobal("window", { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
    atob: (v: string) => Buffer.from(v, "base64").toString("binary") });
});
afterEach(() => { setProviderEgressSink(null); vi.useRealTimers(); vi.unstubAllGlobals(); });

async function opened(callbacks: any = {}, options: any = {}) {
  const runs: RealtimeProviderRunEvent[] = [];
  const client = new BailianRealtimeClient(settings, { ...callbacks, onProviderRun: (e: RealtimeProviderRunEvent) => { runs.push(e); callbacks.onProviderRun?.(e); } }, options);
  const pending = client.connect(); const socket = ws.sockets.at(-1)!; socket.emit("open"); await pending;
  return { client, socket, runs };
}
const responseRuns = (runs: RealtimeProviderRunEvent[]) => runs.filter(r => r.stage === "voice_response");

const responseUsage = { input_tokens: 336, output_tokens: 41, total_tokens: 377,
  input_tokens_details: { text_tokens: 228, audio_tokens: 108 },
  output_tokens_details: { text_tokens: 9, audio_tokens: 32 } };

it.each(["cascade", "omni-e2e"] as const)("ignores non-event JSON and keeps receiving transcripts in %s mode", async mode => {
  const onTranscriptDone = vi.fn(), onError = vi.fn();
  const { client, socket } = await opened({ onTranscriptDone, onError }, { mode });
  socket.message(null);
  socket.message([]);
  socket.message({ transcript: "虚构占位文本" });
  socket.message({ type: "conversation.item.input_audio_transcription.completed", item_id: "example", transcript: "虚构语音" });
  expect(onTranscriptDone).toHaveBeenCalledExactlyOnceWith("虚构语音");
  expect(onError).not.toHaveBeenCalled();
  client.close();
});

it.each(["append", "commit"] as const)("retires failed realtime audio input on %s without accepting late speech", async operation => {
  const onDisconnected = vi.fn(), onCascadeCapture = vi.fn();
  const { client, socket, runs } = await opened({ onDisconnected, onCascadeCapture }, { mode: "cascade" });
  socket.message({ type: "session.updated" });
  if (operation === "commit") client.appendPcm16(pcm);
  vi.spyOn(socket, "send").mockImplementationOnce(() => { throw new Error(`send failure: ${settings.apiKey}`); });

  const send = operation === "append" ? () => client.appendPcm16(pcm) : () => client.commit();
  try {
    expect(send).not.toThrow();
    expect(onDisconnected).toHaveBeenCalledExactlyOnceWith({ code: 1006, reason: "百炼实时语音音频发送失败，连接已中断。" });
    expect(socket.readyState).toBe(ws.Socket.CLOSED);
    socket.message({ type: "conversation.item.input_audio_transcription.completed", item_id: "old", transcript: "虚构旧语音" });
    expect(onCascadeCapture).not.toHaveBeenCalled();
    const asr = runs.filter(run => run.stage === "voice_asr");
    if (operation === "commit") expect(asr).toMatchObject([{ errorCode: "network", run: { status: "failed" } }]);
    else expect(asr).toHaveLength(0);
  } finally {
    client.close();
  }
});

it("ignores a delayed send error from an old realtime connection", async () => {
  const onDisconnected = vi.fn(), onCascadeCapture = vi.fn();
  const { client, socket } = await opened({ onDisconnected, onCascadeCapture }, { mode: "cascade" });
  let completeSend: ((error?: Error) => void) | undefined;
  vi.spyOn(socket, "send").mockImplementationOnce((_value, callback) => { completeSend = callback; });
  client.appendPcm16(pcm);
  expect(completeSend).toBeTypeOf("function");
  const connecting = client.connect(), replacement = ws.sockets.at(-1)!;
  replacement.emit("open");
  await connecting;
  try {
    completeSend?.(new Error("虚构迟到的发送失败"));
    expect(onDisconnected).not.toHaveBeenCalled();
    replacement.message({ type: "conversation.item.input_audio_transcription.completed", item_id: "new", transcript: "虚构新语音" });
    expect(onCascadeCapture).toHaveBeenCalledWith({ type: "final", itemId: "new", text: "虚构新语音" });
  } finally {
    client.close();
  }
});

it.each(["server error", "Omni timeout", "cascade timeout"])("reports failed initial context after %s even if disposal fails", async mode => {
  const onInitialContextError = vi.fn(), dispose = vi.fn();
  const initialInstructions = {
    instructions: "虚构首次语音资料", baseInstructions: "虚构基础提示", assertCurrent: vi.fn(), dispose
  };
  const options = mode === "cascade timeout" ? { mode: "cascade" } : { initialInstructions };
  const { client, socket } = await opened({ onInitialContextError }, options);
  client.createResponse();
  const update = socket.sent.find(event => event.type === "session.update");
  vi.spyOn(socket, "close").mockImplementationOnce(() => { throw Error("虚构关闭失败"); });
  vi.spyOn(socket, "terminate").mockImplementationOnce(() => { throw Error("虚构终止失败"); });

  if (mode === "server error") socket.message({ type: "error", error: { message: "虚构会话拒绝" } });
  else await vi.advanceTimersByTimeAsync(12_000);
  expect(onInitialContextError).toHaveBeenCalledOnce();
  expect(dispose).toHaveBeenCalledTimes(mode === "cascade timeout" ? 0 : 1);
  socket.message({ type: "session.updated", session: { instructions: update.session.instructions } });
  expect(socket.sent.filter(event => event.type === "response.create")).toHaveLength(0);
  expect(vi.getTimerCount()).toBe(0);
  client.close();
});

it.each([false, true])("stops a cascade session rejected during startup only (acknowledged: %s)", async acknowledged => {
  const onInitialContextError = vi.fn(), onError = vi.fn(), onCascadeCapture = vi.fn();
  const { client, socket, runs } = await opened({ onInitialContextError, onError, onCascadeCapture }, { mode: "cascade" });
  if (acknowledged) socket.message({ type: "session.updated" });
  try {
    socket.message({ type: "error", error: { code: "invalid_request_error", message: "虚构会话设置拒绝" } });
    expect(runs).toMatchObject([{ stage: "voice_connection", run: { status: acknowledged ? "success" : "failed" } }]);
    expect(socket.readyState).toBe(acknowledged ? ws.Socket.OPEN : ws.Socket.CLOSED);
    expect(onInitialContextError).toHaveBeenCalledTimes(acknowledged ? 0 : 1);
    expect(onError).toHaveBeenCalledTimes(acknowledged ? 1 : 0);
    socket.message({ type: "conversation.item.input_audio_transcription.completed", item_id: "fictional", transcript: "虚构语音" });
    expect(onCascadeCapture.mock.calls.some(([event]) => event.type === "final")).toBe(acknowledged);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    client.close();
  }
});

it("releases a cascade capture after transcription fails and delivers the next capture once", async () => {
  const endpoint = new ServerVoiceEndpoint(), ready: string[] = [];
  const onCascadeCapture = vi.fn((event: CascadeCaptureEvent) => {
    const capture = endpoint.accept(event);
    if (capture?.ready !== undefined) ready.push(capture.ready);
  });
  const onError = vi.fn();
  const { client, socket, runs } = await opened({ onCascadeCapture, onError }, { mode: "cascade" });
  socket.message({ type: "session.updated" });
  const started = (id: string) => socket.message({ type: "input_audio_buffer.speech_started", item_id: id, audio_start_ms: 100 });
  const stopped = (id: string) => socket.message({ type: "input_audio_buffer.speech_stopped", item_id: id, audio_end_ms: 800 });
  const final = (id: string, transcript: string) => socket.message({
    type: "conversation.item.input_audio_transcription.completed", item_id: id, transcript
  });
  try {
    started("failed-item");
    stopped("failed-item");
    expect(endpoint.awaitingTranscript).toBe(true);
    socket.message({ type: "conversation.item.input_audio_transcription.failed", item_id: "failed-item", error: { message: "虚构转写失败" } });
    expect(endpoint.awaitingTranscript).toBe(false);
    expect(onError).toHaveBeenCalledExactlyOnceWith("虚构转写失败");
    final("failed-item", "虚构过期转写");
    started("next-item");
    stopped("next-item");
    final("next-item", "虚构下一条转写");
    expect(ready).toEqual(["虚构下一条转写"]);
    expect(runs.filter(event => event.stage === "voice_asr").map(event => event.run.status)).toEqual(["failed", "success"]);
  } finally {
    client.close();
  }
});

describe("accepted response usage through the actual client", () => {
  it.each(["response.done", "response.completed"])("records counters once at %s, without response content or server IDs in logs", async type => {
    const onResponseDone = vi.fn(), onAudioDelta = vi.fn();
    const { client, socket, runs } = await opened({ onResponseDone, onAudioDelta }, {
      providerContext: () => ({ sessionId: "local-session", generation: 3, turnId: "local-turn" }) });
    client.createResponse();
    socket.message({ type: "response.created", response: { id: "private-server-id", model: "reported-omni" } });
    socket.message({ type: "response.text.delta", response_id: "private-server-id", delta: "private-reply" });
    const terminal = { type, response: { id: "private-server-id", status: "completed", usage: {
      ...responseUsage, body: "private-usage-body", apiKey: "private-key" }, output: [{ text: "private-output" }] } };
    socket.message(terminal); socket.message({ ...terminal, response: { ...terminal.response, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } });
    const response = responseRuns(runs); expect(response).toHaveLength(1);
    expect(response[0].context).toEqual({ sessionId: "local-session", generation: 3, turnId: "local-turn" });
    expect(response[0].run).toMatchObject({ actualModel: "reported-omni", status: "success", responseUsage: {
      status: "reported", inputTokens: 336, outputTokens: 41, totalTokens: 377,
      inputDetails: { textTokens: 228, audioTokens: 108 }, outputDetails: { textTokens: 9, audioTokens: 32 } } });
    expect(serializeQualityLogEntry({ providerTraceId: response[0].traceId, providerRuns: [response[0].run] })).not.toContain("private");
    expect(onResponseDone).toHaveBeenCalledOnce(); expect(onAudioDelta).not.toHaveBeenCalled();
    expect(socket.sent.filter(e => e.type === "response.create")).toHaveLength(1); client.close(); expect(vi.getTimerCount()).toBe(0);
  });
  it.each([[undefined, "missing"], [{ input_tokens: "private" }, "invalid"]])("does not turn %s into zero usage or change a valid response", async (usage, status) => {
    const onResponseDone = vi.fn(), { client, socket, runs } = await opened({ onResponseDone });
    client.createResponse(); socket.message({ type: "response.created", response: { id: "r" } });
    socket.message({ type: "response.text.delta", response_id: "r", delta: "合成回复" });
    socket.message({ type: "response.done", response: { id: "r", status: "completed", usage } });
    expect(responseRuns(runs)[0].run).toMatchObject({ status: "success", responseUsage: { status } });
    expect(onResponseDone).toHaveBeenCalledOnce(); client.close();
  });
  it.each(["failed", "incomplete", "cancelled"])("retains accepted usage on server %s without claiming successful content", async status => {
    const onResponseDone = vi.fn(), { client, socket, runs } = await opened({ onResponseDone });
    client.createResponse(); socket.message({ type: "response.created", response: { id: "r" } });
    socket.message({ type: "response.done", response: { id: "r", status, usage: responseUsage } });
    expect(responseRuns(runs)[0].run).toMatchObject({ status: status === "cancelled" ? "cancelled" : "failed",
      responseUsage: { status: "reported", totalTokens: 377 } });
    expect(onResponseDone).not.toHaveBeenCalled(); client.close();
  });
  it.each([
    { response_id: "r", response: { id: "other" } },
    { responseId: "r", response: { id: "other" } },
    { response_id: "r", responseId: "other", response: { id: "r" } },
    { response_id: "r", response: {} }, { response: {} }
  ])("does not infer usage ownership from missing or conflicting raw IDs: %j", async event => {
    const { client, socket, runs } = await opened(); client.createResponse();
    socket.message({ type: "response.created", response: { id: "r" } });
    socket.message({ type: "response.text.delta", response_id: "r", delta: "合成回复" });
    socket.message({ type: "response.done", ...event, response: { ...event.response, status: "completed", usage: responseUsage } });
    expect(responseRuns(runs)[0].run.responseUsage).toEqual({ status: "missing" }); client.close();
  });
  it("keeps local cancellation final; late counters cannot revive old output or contaminate a new response", async () => {
    const onResponseDone = vi.fn(), onAudioDelta = vi.fn(), { client, socket, runs } = await opened({ onResponseDone, onAudioDelta });
    client.createResponse(); socket.message({ type: "response.created", response: { id: "old" } }); client.cancelResponse();
    socket.message({ type: "response.done", response: { id: "old", status: "completed", usage: responseUsage } });
    client.createResponse(); socket.message({ type: "response.created", response: { id: "new" } });
    socket.message({ type: "response.audio.delta", response_id: "old", delta: pcm });
    socket.message({ type: "response.text.delta", response_id: "old", delta: "旧回复" });
    socket.message({ type: "response.done", response: { id: "old", status: "completed", usage: responseUsage } });
    socket.message({ type: "response.text.delta", response_id: "new", delta: "新回复" });
    socket.message({ type: "response.done", response: { id: "new", status: "completed", usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } } });
    expect(responseRuns(runs).map(e => e.run.responseUsage)).toEqual([{ status: "missing" },
      { status: "reported", inputTokens: 1, outputTokens: 2, totalTokens: 3 }]);
    expect(onResponseDone).toHaveBeenCalledOnce(); expect(onResponseDone.mock.calls[0][0]).toBe("新回复");
    expect(onAudioDelta).not.toHaveBeenCalled(); client.close(); expect(vi.getTimerCount()).toBe(0);
  });
  it("does not use an unbound terminal to establish its own usage ownership", async () => {
    const { client, socket, runs } = await opened(); client.createResponse();
    socket.message({ type: "response.done", response: { id: "unbound", status: "completed", usage: responseUsage } });
    expect(responseRuns(runs)[0].run.responseUsage).toEqual({ status: "missing" }); client.close();
  });
  it("old sockets cannot supply new-connection usage; a throwing metrics sink cannot interrupt completion", async () => {
    const onResponseDone = vi.fn(), { client, socket, runs } = await opened({ onResponseDone, onProviderRun: () => { throw new Error("metrics only"); } });
    client.createResponse(); socket.message({ type: "response.created", response: { id: "old" } });
    const pending = client.connect(), next = ws.sockets.at(-1)!; next.emit("open"); await pending;
    client.createResponse(); next.message({ type: "response.created", response: { id: "new" } });
    socket.message({ type: "response.done", response: { id: "new", status: "completed", usage: responseUsage } });
    next.message({ type: "response.text.delta", response_id: "new", delta: "新回复" });
    next.message({ type: "response.done", response: { id: "new", status: "completed" } });
    expect(responseRuns(runs).map(e => e.run.responseUsage)).toEqual([{ status: "missing" }, { status: "missing" }]);
    expect(onResponseDone).toHaveBeenCalledOnce(); client.close();
  });
});

describe("realtime stage terminal contract", () => {
  describe("known credential audit redaction", () => {
    it.each([false, true])("retains the actual connection key after settings restore (reported=%s)", async reported => {
      const actualKey = "synthetic-connection-retained-key", configured = { ...settings, model: `model-${actualKey}` };
      const runs: RealtimeProviderRunEvent[] = [], records: any[] = [];
      setProviderEgressSink(record => { records.push(record); });
      const client = new BailianRealtimeClient(configured, { onProviderRun: event => { runs.push(event); } });
      configured.apiKey = actualKey;
      const pending = client.connect(), socket = ws.sockets.at(-1)!; socket.emit("open"); await pending;
      expect(socket.options.headers.Authorization).toBe(`Bearer ${actualKey}`);
      expect(new URL(socket.url!).searchParams.get("model")).toBe(configured.model);
      socket.message({ type: "session.updated" }); configured.apiKey = settings.apiKey;
      client.createResponse();
      socket.message({ type: "response.created", response: { id: "restored-key-response", ...(reported ? { model: `reported-${actualKey}` } : {}) } });
      socket.message({ type: "response.text.delta", response_id: "restored-key-response", delta: "合成回复" });
      socket.message({ type: "response.done", response: { id: "restored-key-response", status: "completed" } });
      expect(runs.map(event => event.stage)).toEqual(["voice_connection", "voice_response"]);
      expect(responseRuns(runs)[0].run).toMatchObject({ requestedModel: "unknown", actualModel: "unknown", modelIdentitySource: "configured", status: "success", attempts: [{ model: "unknown" }] });
      expect(JSON.stringify({ runs, records })).not.toContain(actualKey);
      expect(socket.sent.filter(event => event.type === "response.create")).toHaveLength(1);
      client.close(); expect(vi.getTimerCount()).toBe(0);
    });
    it.each([false, true])("protects connection/response/ASR identities (reported=%s)", async reported => {
      const configured = { ...settings, model: `model-${settings.apiKey}` }, runs: RealtimeProviderRunEvent[] = [], records: any[] = [];
      setProviderEgressSink(record => { records.push(record); });
      const client = new BailianRealtimeClient(configured, { onProviderRun: event => { runs.push(event); } });
      const pending = client.connect(), socket = ws.sockets.at(-1)!; socket.emit("open"); await pending;
      expect(new URL(socket.url!).searchParams.get("model")).toBe(configured.model); expect(socket.options.headers.Authorization).toBe(`Bearer ${settings.apiKey}`);
      socket.message({ type: "session.updated", ...(reported ? { session: { model: `reported-${settings.apiKey}` } } : {}) });
      client.createResponse(); socket.message({ type: "response.created", response: { id: "redaction-response", ...(reported ? { model: `reported-${settings.apiKey}` } : {}) } });
      socket.message({ type: "response.text.delta", response_id: "redaction-response", delta: "合成回复" });
      socket.message({ type: "response.done", response: { id: "redaction-response", status: "completed" } });
      socket.message({ type: "input_audio_buffer.speech_started", item_id: "redaction-asr" });
      socket.message({ type: "conversation.item.input_audio_transcription.completed", item_id: "redaction-asr", transcript: "合成输入", model: `reported-${settings.apiKey}` });
      expect(runs.map(event => event.stage)).toEqual(["voice_connection", "voice_response", "voice_asr"]);
      for (const event of runs.slice(0, 2)) expect(event.run).toMatchObject({ requestedModel: "unknown", actualModel: "unknown", modelIdentitySource: "configured", status: "success", attempts: [{ model: "unknown" }] });
      expect(runs[2].run).toMatchObject({ actualModel: "qwen3-asr-flash-realtime", modelIdentitySource: "configured" });
      expect(records).toHaveLength(1); expect(records[0].model).toBe("unknown"); expect(JSON.stringify({ runs, records })).not.toContain(settings.apiKey);
      client.close(); expect(vi.getTimerCount()).toBe(0);
    });
    it("protects realtime configuration failure identities without opening a socket", () => {
      const runs: RealtimeProviderRunEvent[] = [];
      const client = new BailianRealtimeClient({ ...settings, model: `model-${settings.apiKey}`, plaintextCredentialStorageAccepted: false }, { onProviderRun: event => { runs.push(event); } });
      expect(() => client.connect()).toThrow(); expect(ws.sockets).toHaveLength(0);
      expect(runs[0].run).toMatchObject({ requestedModel: "unknown", status: "failed", attempts: [] }); expect(JSON.stringify(runs)).not.toContain(settings.apiKey);
    });
  });
  it("wraps flat internal function definitions for the documented Realtime wire format without mutating them",async()=>{
    const tools=[{type:'function',name:'query_projects',description:'只读项目',parameters:{type:'object',properties:{query:{type:'string'}}}}],before=structuredClone(tools);
    const {client,socket}=await opened({}, {tools});expect(socket.sent[0].session.tools).toEqual([{type:'function',function:{name:'query_projects',description:'只读项目',parameters:tools[0].parameters}}]);
    expect(tools).toEqual(before);client.close();
  });
  it("preserves nested function and non-function definitions without double wrapping",async()=>{
    const tools=[{type:'function',function:{name:'query_projects',parameters:{type:'object'}}},{type:'mcp',server_label:'synthetic',server_url:'https://example.invalid'}];
    const {client,socket}=await opened({}, {tools});expect(socket.sent[0].session.tools).toEqual(tools);client.close();
  });
  it("keeps a parameterless function optional fields absent on the wire",async()=>{
    const {client,socket}=await opened({}, {tools:[{type:'function',name:'query_clock'}]});expect(socket.sent[0].session.tools).toEqual([{type:'function',function:{name:'query_clock'}}]);client.close();
  });
  it("open only resolves transport; session acknowledgement proves connection and supplies response model", async () => {
    const { client, socket, runs } = await opened();
    expect(runs).toEqual([]);
    socket.message({ type: "session.updated", session: { model: "reported-omni" } });
    socket.message({ type: "session.updated", session: { model: "other" } });
    expect(runs).toHaveLength(1);
    expect(runs[0].run).toMatchObject({ status: "success", actualModel: "reported-omni", modelIdentitySource: "response", attempts: [{ transport: "websocket", status: "success" }] });
    client.close(); expect(runs).toHaveLength(1);
  });
  it.each([["invalid_api_key", "auth"], ["rate_limit", "rate_limit"], ["invalid_request_error", "configuration"]])("open then %s is a failed connection", async (code, expected) => {
    const { client, socket, runs } = await opened(); socket.message({ type: "error", error: { code, message: "synthetic" } });
    expect(runs).toHaveLength(1); expect(runs[0].run).toMatchObject({ status: "failed", attempts: [{ errorCode: expected }] });
    expect(runs[0].run.actualModel).toBeUndefined(); client.close(); expect(runs).toHaveLength(1);
  });
  it("no acknowledgement times out metadata without changing established connect callback or sending another request", async () => {
    const onOpen = vi.fn(); const { client, socket, runs } = await opened({ onOpen });
    await vi.advanceTimersByTimeAsync(12_000);
    expect(onOpen).toHaveBeenCalledOnce(); expect(runs[0]).toMatchObject({ stage: "voice_connection", errorCode: "timeout", run: { status: "failed" } });
    expect(socket.sent).toHaveLength(1); client.close();
  });
  it("configuration rejection records no attempted request", () => {
    const runs: RealtimeProviderRunEvent[] = [];
    const client = new BailianRealtimeClient({ ...settings, apiKey: "" }, { onProviderRun: e => runs.push(e) });
    expect(() => client.connect()).toThrow(); expect(ws.sockets).toHaveLength(0);
    expect(runs[0]).toMatchObject({ errorCode: "configuration", run: { status: "failed", attempts: [] } });
  });
  it("cancel before open settles once and late open cannot send", async () => {
    const runs: RealtimeProviderRunEvent[] = []; const client = new BailianRealtimeClient(settings, { onProviderRun: e => runs.push(e) });
    const promise = client.connect().catch(e => e); const socket = ws.sockets[0]; client.close(); socket.emit("open");
    expect((await promise).name).toBe("AbortError"); expect(socket.sent).toEqual([]);
    expect(runs).toHaveLength(1); expect(runs[0].run.status).toBe("cancelled");
  });
  it("settles a connection that never opens even if socket termination fails", async () => {
    const onOpen = vi.fn();
    const client = new BailianRealtimeClient(settings, { onOpen });
    const rejected = expect(client.connect()).rejects.toThrow("百炼 Realtime 连接超时");
    const socket = ws.sockets[0];
    vi.spyOn(socket, "terminate").mockImplementationOnce(() => { throw Error("虚构连接终止失败"); });

    await vi.advanceTimersByTimeAsync(12_000);
    await rejected;
    socket.emit("open");
    expect(onOpen).not.toHaveBeenCalled();
    expect(socket.sent).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("reports initial source validation failure as failed when socket disposal also fails", async () => {
    let sourceIsCurrent = true;
    const onProviderRun = vi.fn(), dispose = vi.fn();
    const client = new BailianRealtimeClient(settings, { onProviderRun }, { initialInstructions: {
      instructions: "虚构首次资料", baseInstructions: "虚构基础提示", dispose,
      assertCurrent: () => { if (!sourceIsCurrent) throw Error("虚构资料已经变化"); }
    } });
    const rejected = expect(client.connect()).rejects.toMatchObject({ name: "RealtimeConnectionContextError" });
    const socket = ws.sockets[0];
    vi.spyOn(socket, "close").mockImplementationOnce(() => { throw Error("虚构连接关闭失败"); });
    vi.spyOn(socket, "terminate").mockImplementationOnce(() => { throw Error("虚构连接终止失败"); });
    sourceIsCurrent = false;

    socket.emit("open");
    await rejected;
    expect(onProviderRun).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ run: expect.objectContaining({ status: "failed" }) }));
    expect(dispose).toHaveBeenCalledOnce();
    expect(socket.sent).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("only successful response terminal assigns actual model and ignores duplicate or late response events", async () => {
    const onResponseDone = vi.fn(); const { client, socket, runs } = await opened({ onResponseDone });
    socket.message({ type: "session.updated" }); client.createResponse();
    socket.message({ type: "response.created", response: { id: "secret-server-response", model: "actual-model" } });
    socket.message({ type: "response.text.delta", response_id: "secret-server-response", delta: "原文正文" });
    expect(responseRuns(runs)).toEqual([]);
    socket.message({ type: "response.done", response: { id: "secret-server-response", status: "completed" } });
    socket.message({ type: "response.done", response: { id: "secret-server-response", status: "completed" } });
    socket.message({ type: "response.created", response: { id: "secret-server-response" } });
    expect(onResponseDone).toHaveBeenCalledOnce(); expect(responseRuns(runs)).toHaveLength(1);
    expect(responseRuns(runs)[0].run).toMatchObject({ actualModel: "actual-model", modelIdentitySource: "response", status: "success" }); client.close();
  });
  it.each(["failed", "incomplete", "cancelled", "completed"])("empty response %s never claims generated success", async status => {
    const { client, socket, runs } = await opened(); client.createResponse();
    socket.message({ type: "response.created", response: { id: "r" } });
    socket.message({ type: "response.done", response: { id: "r", status } });
    expect(responseRuns(runs)[0].run.status).toBe(status === "cancelled" ? "cancelled" : "failed");
    expect(responseRuns(runs)[0].run.actualModel).toBeUndefined(); client.close();
  });
  it("ASR uses its requested model, never the session Omni model; response identity requires ASR evidence", async () => {
    const { client, socket, runs } = await opened({}, { providerContext: () => ({ sessionId: "s", generation: 4, turnId: "previous-turn" }) });
    socket.message({ type: "session.updated", session: { model: "actual-omni" } });
    for (const [id, model] of [["asr-a", undefined], ["asr-b", "actual-asr"]]) {
      socket.message({ type: "input_audio_buffer.speech_started", item_id: id });
      socket.message({ type: "conversation.item.input_audio_transcription.completed", item_id: id, transcript: "合成输入", ...(model ? { model } : {}) });
      socket.message({ type: "conversation.item.input_audio_transcription.completed", item_id: id, transcript: "重复" });
    }
    const asr = runs.filter(r => r.stage === "voice_asr"); expect(asr).toHaveLength(2);
    expect(asr[0].context).toEqual({ sessionId: "s", generation: 4 });
    expect(asr[0].run).toMatchObject({ requestedModel: "qwen3-asr-flash-realtime", actualModel: "qwen3-asr-flash-realtime", modelIdentitySource: "configured" });
    expect(asr[1].run).toMatchObject({ actualModel: "actual-asr", modelIdentitySource: "response" }); client.close();
  });
  it("keeps metadata maps bounded and clears them on close; retired ASR done cannot produce fresh metadata", async () => {
    const { client, socket, runs } = await opened();
    for (let i = 0; i < 150; i++) {
      socket.message({ type: "input_audio_buffer.speech_started", item_id: `i${i}` });
      socket.message({ type: "conversation.item.input_audio_transcription.completed", item_id: `i${i}`, transcript: "合成" });
    }
    expect((client as any).asrRuns.size).toBe(128); const count = runs.length;
    socket.message({ type: "conversation.item.input_audio_transcription.completed", item_id: "i0", transcript: "旧" });
    expect(runs).toHaveLength(count); client.close(); expect((client as any).asrRuns.size).toBe(0);
  });
  it("existing five retries produce six bounded attempts and one final metadata record", async () => {
    const { client, socket, runs } = await opened(); socket.message({ type: "session.updated" }); client.createResponse();
    for (const delay of [500, 1000, 2000, 4000, 8000]) {
      socket.message({ type: "error", error: { message: "ModelServingError" } }); await vi.advanceTimersByTimeAsync(delay);
    }
    socket.message({ type: "error", error: { message: "ModelServingError" } });
    expect(responseRuns(runs)).toHaveLength(1); expect(responseRuns(runs)[0].run).toMatchObject({ status: "failed", fallbackUsed: true });
    expect(responseRuns(runs)[0].run.attempts).toHaveLength(6); expect(socket.sent.filter(s => s.type === "response.create")).toHaveLength(6); client.close();
  });
  it("cancel while retry waits and unscoped late errors cannot create another response", async () => {
    const { client, socket, runs } = await opened(); socket.message({ type: "session.updated" }); client.createResponse();
    socket.message({ type: "error", error: { message: "ModelServingError" } }); client.cancelResponse();
    expect(vi.getTimerCount()).toBe(0);
    socket.message({ type: "error", error: { message: "ModelServingError" } }); await vi.advanceTimersByTimeAsync(10_000);
    expect(socket.sent.filter(s => s.type === "response.create")).toHaveLength(1);
    expect(responseRuns(runs)).toHaveLength(1); expect(responseRuns(runs)[0].run.status).toBe("cancelled"); client.close();
  });
  it.each(["throw", "callback"] as const)("retires the Omni connection on response send failure from %s", async failure => {
    const onDisconnected = vi.fn(), onResponseDone = vi.fn();
    const { client, socket, runs } = await opened({ onDisconnected, onResponseDone });
    socket.message({ type: "session.updated" });
    let completeSend: ((error?: Error) => void) | undefined;
    const error = new Error("虚构回复请求发送失败");
    vi.spyOn(socket, "send").mockImplementationOnce((_raw, callback) => {
      if (failure === "throw") throw error;
      completeSend = callback;
    });
    try {
      expect(() => client.createResponse()).not.toThrow();
      if (failure === "callback") {
        expect(completeSend).toBeTypeOf("function");
        completeSend?.(error);
      }
      expect(socket.readyState).toBe(ws.Socket.CLOSED);
      expect(onDisconnected).toHaveBeenCalledExactlyOnceWith({ code: 1006,
        reason: "百炼实时语音回复请求发送失败，连接已中断。" });
      expect(responseRuns(runs)).toMatchObject([{ errorCode: "network", run: { status: "failed" } }]);
      socket.message({ type: "response.created", response: { id: "fictional-old" } });
      socket.message({ type: "response.done", response: { id: "fictional-old", status: "completed" } });
      expect(onResponseDone).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      client.close();
    }
  });

  it("ignores a reply send failure from an earlier response attempt", async () => {
    const onDisconnected = vi.fn(), onResponseDone = vi.fn();
    const { client, socket, runs } = await opened({ onDisconnected, onResponseDone });
    socket.message({ type: "session.updated" });
    let completeFirstSend: ((error?: Error) => void) | undefined;
    vi.spyOn(socket, "send").mockImplementationOnce((_raw, callback) => { completeFirstSend = callback; });
    try {
      client.createResponse();
      expect(completeFirstSend).toBeTypeOf("function");
      socket.message({ type: "error", error: { message: "ModelServingError" } });
      await vi.advanceTimersByTimeAsync(500);
      expect(socket.sent.filter(frame => frame.type === "response.create")).toHaveLength(1);
      completeFirstSend?.(new Error("虚构迟到的发送失败"));
      expect(socket.readyState).toBe(ws.Socket.OPEN);
      expect(onDisconnected).not.toHaveBeenCalled();
      socket.message({ type: "response.created", response: { id: "fictional-retry" } });
      socket.message({ type: "response.text.delta", response_id: "fictional-retry", delta: "虚构重试答复" });
      socket.message({ type: "response.done", response: { id: "fictional-retry", status: "completed" } });
      expect(onResponseDone).toHaveBeenCalledExactlyOnceWith("虚构重试答复", expect.objectContaining({ responseId: "fictional-retry" }));
      expect(responseRuns(runs)).toMatchObject([{ run: { status: "success", fallbackUsed: true } }]);
    } finally {
      client.close();
    }
  });

  it.each(["throw", "callback"] as const)("clears the response on cancellation send failure from %s", async failure => {
    const onTransportError = vi.fn(), onResponseDone = vi.fn();
    const { client, socket, runs } = await opened({ onTransportError, onResponseDone });
    socket.message({ type: "session.updated" });
    client.createResponse();
    socket.message({ type: "response.created", response: { id: "fictional-cancelled" } });
    const error = new Error("虚构取消发送失败");
    let completeSend: ((error?: Error) => void) | undefined;
    vi.spyOn(socket, "send").mockImplementationOnce((_value, callback) => {
      if (failure === "throw") throw error;
      completeSend = callback;
    });
    try {
      expect(() => client.cancelResponse()).not.toThrow();
      if (failure === "callback") {
        expect(completeSend).toBeTypeOf("function");
        completeSend?.(error);
      }
      expect(socket.readyState).toBe(ws.Socket.CLOSED);
      expect(onTransportError).toHaveBeenCalledExactlyOnceWith(UNCONFIRMED_VOICE_CANCEL_MESSAGE);
      expect(vi.getTimerCount()).toBe(0);
      client.createResponse();
      socket.message({ type: "response.done", response: { id: "fictional-cancelled", status: "completed" } });
      expect(onResponseDone).not.toHaveBeenCalled();
      expect(socket.sent.filter(event => event.type === "response.create")).toHaveLength(1);
      expect(responseRuns(runs)).toMatchObject([{ run: { status: "cancelled" } }]);
    } finally {
      client.close();
    }
  });
  it("reports an unconfirmed cancel when closing the response's socket fails", async () => {
    const onTransportError = vi.fn(), onResponseCreated = vi.fn();
    const { client, socket } = await opened({ onTransportError, onResponseCreated });
    socket.message({ type: "session.updated" });
    client.createResponse();
    client.cancelResponse();
    client.createResponse();
    vi.spyOn(socket, "close").mockImplementationOnce(() => { throw Error("虚构关闭失败"); });
    vi.spyOn(socket, "terminate").mockImplementationOnce(() => { throw Error("虚构终止失败"); });

    await vi.advanceTimersByTimeAsync(2_000);
    expect(onTransportError).toHaveBeenCalledExactlyOnceWith(UNCONFIRMED_VOICE_CANCEL_MESSAGE);
    expect(vi.getTimerCount()).toBe(0);
    socket.message({ type: "response.created", response: { id: "fictional-cancelled" } });
    expect(onResponseCreated).not.toHaveBeenCalled();
    expect(socket.sent.filter(event => event.type === "response.create")).toHaveLength(1);
    client.close();
  });
  it("keeps recently retired identities when an old terminal is delivered again", async () => {
    const onResponseTextDelta = vi.fn();
    const { client, socket } = await opened({ onResponseTextDelta });
    socket.message({ type: "session.updated" });
    for (let index = 0; index < 512; index += 1) {
      const id = `fictional-retired-${index}`;
      client.createResponse();
      socket.message({ type: "response.created", response: { id } });
      socket.message({ type: "response.done", response: { id, status: "completed" } });
    }
    socket.message({ type: "response.done", response: { id: "fictional-retired-511", status: "completed" } });
    socket.message({ type: "response.text.delta", response_id: "fictional-retired-0", delta: "迟到的虚构回复" });
    expect(onResponseTextDelta).not.toHaveBeenCalled();

    client.createResponse();
    socket.message({ type: "response.created", response: { id: "fictional-current" } });
    socket.message({ type: "response.text.delta", response_id: "fictional-current", delta: "当前虚构回复" });
    expect(onResponseTextDelta).toHaveBeenCalledExactlyOnceWith("当前虚构回复", expect.objectContaining({ responseId: "fictional-current" }));
    client.close();
  });
  it("retires the scheduled retry when a new native response is requested", async () => {
    const { client, socket, runs } = await opened();
    socket.message({ type: "session.updated" });
    client.createResponse();
    socket.message({ type: "error", error: { message: "ModelServingError" } });
    client.createResponse();
    socket.message({ type: "response.created", response: { id: "fictional-new" } });
    await vi.advanceTimersByTimeAsync(500);
    expect(socket.sent.filter(event => event.type === "response.create")).toHaveLength(2);
    expect(responseRuns(runs).map(event => event.run.status)).toEqual(["cancelled"]);
    client.close();
  });
  it("keeps one retry when the same failed attempt emits duplicate server errors", async () => {
    const onModelRetry = vi.fn();
    const { client, socket } = await opened({ onModelRetry });
    socket.message({ type: "session.updated" });
    client.createResponse();
    const failure = { type: "error", error: { message: "ModelServingError" } };
    socket.message(failure);
    socket.message(failure);
    await vi.advanceTimersByTimeAsync(500);
    expect(onModelRetry).toHaveBeenCalledExactlyOnceWith({ attempt: 1, delayMs: 500, message: "ModelServingError" });
    expect(socket.sent.filter(event => event.type === "response.create")).toHaveLength(2);
    client.close();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("reconnect closes old pending run once; old socket done cannot contaminate the new request", async () => {
    const { client, socket, runs } = await opened(); socket.message({ type: "session.updated" }); client.createResponse();
    socket.message({ type: "response.created", response: { id: "old" } });
    const next = client.connect(); const second = ws.sockets.at(-1)!; second.emit("open"); await next;
    second.message({ type: "session.updated" }); client.createResponse();
    socket.message({ type: "response.done", response: { id: "old", status: "completed", model: "wrong-model" } });
    second.message({ type: "response.created", response: { id: "new" } });
    second.message({ type: "response.text.delta", response_id: "new", delta: "新回复" });
    second.message({ type: "response.done", response: { id: "new", status: "completed" } });
    expect(responseRuns(runs).map(e => e.run.status)).toEqual(["cancelled", "success"]);
    expect(responseRuns(runs)[1].run.actualModel).toBe(settings.model); client.close();
  });
});

function controllerView() {
  const runtime = new VoiceSessionController(); runtime.connect(); runtime.connected();
  runtime.beginTurn({ route: "e2e", transcript: "合成请求" });
  runtime.transitionTurn("endpointing"); runtime.transitionTurn("routing"); runtime.transitionTurn("generating"); runtime.bindResponse("remote-response");
  const view: any = { controller: { settings: { realtimeVoice: settings }, appendQualityLog: vi.fn(async () => undefined), appendAgentConversation: vi.fn(async () => undefined) },
    agentVoiceRuntime: runtime, agentMode: "voice", agentBusy: true, agentRecording: true, agentVoiceSendInFlight: true,
    agentMessages: [{ role: "user", content: "合成请求" }, { role: "assistant", content: "" }], agentOmniE2eAssistantIndex: 1,
    agentOmniE2eReply: "", agentOmniE2eUserMessage: "合成请求", agentOmniPendingAudio: [], agentOmniPlaybackReady: null,
    agentTtsClient: null, agentRealtimeClient: null, agentVoiceTrace: {}, pendingAgentActions: [], voiceSession: createVoiceSession(), agentSpeechSources: new Set(),
    agentAudioOutput: { start: vi.fn(async () => undefined), appendPcm16: vi.fn(() => true), finish: vi.fn(), cancel: vi.fn(), fail: vi.fn() },
    markVoiceTrace: vi.fn(), refreshAgentSurfaceState: vi.fn(), transitionVoiceSession: vi.fn(), setAgentMessageBubbleContent: vi.fn(),
    setAgentBusy: vi.fn((busy: boolean) => { view.agentBusy = busy; }), appendAgentQualityLog: vi.fn(async () => undefined),
    currentVoiceMessageText: () => "", resetCurrentVoiceTurnDraft: vi.fn(), clearVoiceWarmupTimer: vi.fn(),
    clearVoiceLocalEndpointTimer: vi.fn(), clearVoiceNoTranscriptTimer: vi.fn(), cleanupAgentMedia: vi.fn(),
    invalidateVoicePipeline: vi.fn(() => { view.agentVoicePipelineGeneration = (view.agentVoicePipelineGeneration ?? 0) + 1; }) };
  return { runtime, view };
}
const done = { eventType: "response.done", responseId: "remote-response", status: "completed" };

describe("actual VoiceSessionController with fake WebSocket", () => {
  it("TTS generation promise settles at done while playback owns final completion, without deadlock or premature cancellation", async () => {
    const { runtime, view } = controllerView(); let settled = false;
    const finish = finishOmniE2eVoiceTurn(view, "合成朗读", done).then(() => { settled = true; });
    const socket = ws.sockets.at(-1)!; socket.emit("open"); await flush(); expect(settled).toBe(false);
    socket.message({ type: "response.audio.delta", response_id: "tts", delta: pcm }); await flush();
    expect(view.agentAudioOutput.appendPcm16).toHaveBeenCalledOnce(); expect(runtime.snapshot().currentTurn?.playbackDrained).toBe(false);
    socket.message({ type: "response.done", response: { id: "tts", status: "completed", model: "reported-tts" } }); await finish; await flush();
    expect(view.agentAudioOutput.finish).toHaveBeenCalled(); expect(runtime.snapshot().currentTurn?.phase).not.toBe("completed");
    const rows = view.controller.appendQualityLog.mock.calls.map((c: any) => c[0]); expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ providerStage: "tts", providerRuns: [{ status: "success", actualModel: "reported-tts" }] });
    const playbackId = runtime.snapshot().currentTurn!.playbackId!;
    handleOmniE2eAudioOutputEvent(view, { type: "drained", playbackId, owner: "fallback-tts", timestamp: 1 }); await flush();
    expect(runtime.snapshot().currentTurn?.phase).toBe("completed"); expect(view.agentBusy).toBe(false);
    expect(view.controller.appendAgentConversation).toHaveBeenCalledOnce(); expect(view.controller.appendQualityLog).toHaveBeenCalledOnce();
  });
  it.each(["interrupt", "stop"])("%s preserves cancelled old TTS trace after generation invalidation; late old completion never changes new turn", async action => {
    const { runtime, view } = controllerView(); const old = runtime.snapshot().currentTurn!;
    const finish = finishOmniE2eVoiceTurn(view, "合成朗读", done); const socket = ws.sockets.at(-1)!; socket.emit("open");
    if (action === "interrupt") interruptManagedVoiceTurn(view); else await stopBailianRealtimeRecording(view, true);
    await finish; if (action === "stop") { runtime.connect(); runtime.connected(); } runtime.beginTurn({ route: "brain", transcript: "下一轮" });
    const next = runtime.snapshot().currentTurn!;
    socket.message({ type: "response.audio.delta", response_id: "old-tts", delta: pcm });
    socket.message({ type: "response.done", response: { id: "old-tts", status: "completed" } }); await flush();
    const row = view.controller.appendQualityLog.mock.calls.map((c: any) => c[0]); expect(row).toHaveLength(1);
    expect(row[0]).toMatchObject({ providerStage: "tts", providerRuns: [{ status: "cancelled" }] });
    const event = runtime.eventJournal().snapshot().find(e => e.providerTraceId === row[0].providerTraceId)!;
    expect(event).toMatchObject({ turnId: old.turnId, generation: old.generation }); expect(event.turnId).not.toBe(next.turnId);
    expect(runtime.snapshot().currentTurn?.transcript).toBe("下一轮"); expect(view.agentAudioOutput.appendPcm16).not.toHaveBeenCalled();
    expect(ws.sockets).toHaveLength(1); expect(JSON.stringify(row)).not.toContain("old-tts");
  });
  it("first-audio timeout records failed TTS and only local fallback for system speech", async () => {
    const { runtime, view } = controllerView();
    vi.stubGlobal("SpeechSynthesisUtterance", class { onstart?: Function; constructor(public text: string) {} });
    (window as any).speechSynthesis = { cancel: vi.fn(), speak: vi.fn() };
    const finish = finishOmniE2eVoiceTurn(view, "合成朗读", done); ws.sockets[0].emit("open");
    await vi.advanceTimersByTimeAsync(5000); await finish;
    const rows = view.controller.appendQualityLog.mock.calls.map((c: any) => c[0]); expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ providerStage: "tts", errorCode: "timeout", providerRuns: [{ status: "failed" }] });
    expect(rows[1]).toMatchObject({ providerStage: "system_speech", localFallbackUsed: true }); expect(rows[1].providerRuns).toBeUndefined();
    expect(runtime.snapshot().currentTurn?.outputOwner).toBe("system"); expect(ws.sockets).toHaveLength(1);
    startSystemSpeechForActiveTurn(view, "合成朗读", "same fallback"); expect(view.controller.appendQualityLog).toHaveBeenCalledTimes(2);
  });
  it("stopped old real client response records its old owner with local trace; late socket cannot log or change next turn", async () => {
    const { runtime, view } = controllerView(); const old = runtime.snapshot().currentTurn!; const oldSession = runtime.snapshot().sessionId;
    const { client, socket } = await opened({ onProviderRun: (e: RealtimeProviderRunEvent) => recordVoiceProviderRun(view, runtime, e) },
      { providerContext: () => ({ sessionId: runtime.snapshot().sessionId, generation: runtime.snapshot().generation, turnId: runtime.snapshot().currentTurn?.turnId }) });
    view.agentRealtimeClient = client; socket.message({ type: "session.updated" }); client.createResponse();
    socket.message({ type: "response.created", response: { id: "raw-secret-response-id" } }); await stopBailianRealtimeRecording(view, true);
    runtime.connect(); runtime.connected(); runtime.beginTurn({ route: "brain", transcript: "下一轮" });
    socket.message({ type: "response.done", response: { id: "raw-secret-response-id", status: "completed" } }); await flush();
    const rows = view.controller.appendQualityLog.mock.calls.map((c: any) => c[0]); expect(rows.map((r: any) => r.providerStage)).toEqual(["voice_connection", "voice_response"]);
    expect(rows[1].providerRuns[0].status).toBe("cancelled");
    expect(runtime.eventJournal().snapshot().find(e => e.providerTraceId === rows[1].providerTraceId)).toMatchObject({ sessionId: oldSession, turnId: old.turnId, generation: old.generation });
    expect(JSON.stringify(rows)).not.toContain("raw-secret-response-id"); expect(runtime.snapshot().currentTurn?.transcript).toBe("下一轮");
  });
  it("runtime journal only retains valid local trace identifiers", () => {
    const journal = new VoiceRuntimeJournal(); const event = { timestamp: 1, sessionId: "s", generation: 1, eventType: "provider.tts.failed", stateBefore: "pending", stateAfter: "failed" };
    journal.record({ ...event, providerTraceId: "safe-local-id" }); journal.record({ ...event, providerTraceId: "server/payload\nsecret" });
    expect(journal.snapshot()[0].providerTraceId).toBe("safe-local-id"); expect(journal.snapshot()[1].providerTraceId).toBeUndefined();
  });
});
