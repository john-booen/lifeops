import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BailianRealtimeClient } from "../src/bailianRealtime";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { createVoiceSession } from "../src/voiceSession";
import { VoiceSessionController } from "../src/voice/voiceRuntime";
import type { RealtimeProviderRunEvent } from "../src/voice/realtimeProviderRun";
import { fallbackOmniResponseToBrain, finishOmniE2eVoiceTurn, handleOmniE2eResponseCreated,
  recordVoiceProviderRun } from "../src/voice/voiceRealtime";

const ws = vi.hoisted(() => {
  class Socket {
    static CONNECTING = 0; static OPEN = 1; static CLOSED = 3;
    readyState = 0; sent: any[] = []; handlers = new Map<string, Function[]>();
    constructor() { sockets.push(this); }
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
  plaintextCredentialStorageAccepted: true, mode: "omni-e2e" as const, model: "configured-omni", speakReplies: false };
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
beforeEach(() => {
  vi.useFakeTimers(); ws.sockets.length = 0;
  vi.stubGlobal("window", { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

async function opened(callbacks: any = {}, options: any = {}) {
  const runs: RealtimeProviderRunEvent[] = [];
  const client = new BailianRealtimeClient(settings, { ...callbacks, onProviderRun: (event: RealtimeProviderRunEvent) => {
    runs.push(event); callbacks.onProviderRun?.(event);
  } }, options);
  const pending = client.connect(); const socket = ws.sockets.at(-1)!; socket.emit("open"); await pending;
  socket.message({ type: "session.updated", session: { model: "reported-omni" } });
  return { client, socket, runs };
}
const asrRuns = (runs: RealtimeProviderRunEvent[]) => runs.filter(run => run.stage === "voice_asr");

describe("independent ASR terminal and retirement checks on the actual client", () => {
  it.each(["completed", "failed"])("records an ASR %s terminal when a preceding speech event is absent", async terminal => {
    const { client, socket, runs } = await opened();
    socket.message({ type: `conversation.item.input_audio_transcription.${terminal}`, item_id: "unseen-item",
      transcript: "synthetic input", model: "reported-asr", error: { code: "invalid_api_key", message: "unauthorized" } });
    expect(asrRuns(runs)).toHaveLength(1);
    expect(asrRuns(runs)[0].run).toMatchObject({ requestedModel: "qwen3-asr-flash-realtime",
      status: terminal === "completed" ? "success" : "failed", attempts: [{ transport: "websocket" }] });
    if (terminal === "completed") expect(asrRuns(runs)[0].run.actualModel).toBe("reported-asr");
    else expect(asrRuns(runs)[0]).toMatchObject({ errorCode: "auth" });
    client.close(); expect(asrRuns(runs)).toHaveLength(1);
  });
  it("settles an empty completed ASR as invalid instead of leaving it pending until stop", async () => {
    const onTranscriptDone = vi.fn(); const { client, socket, runs } = await opened({ onTranscriptDone });
    socket.message({ type: "input_audio_buffer.speech_started", item_id: "empty" });
    socket.message({ type: "conversation.item.input_audio_transcription.completed", item_id: "empty", transcript: "" });
    expect(asrRuns(runs)).toHaveLength(1);
    expect(asrRuns(runs)[0]).toMatchObject({ errorCode: "invalid_response", run: { status: "failed" } });
    expect(onTranscriptDone).not.toHaveBeenCalled(); client.close(); expect(asrRuns(runs)).toHaveLength(1);
  });
  it.each(["completed", "failed"])("a retired %s item cannot adopt or settle the current unbound ASR or emit an old transcript", async terminal => {
    const onTranscriptDone = vi.fn(); const { client, socket, runs } = await opened({ onTranscriptDone }, { mode: "cascade" });
    for (let i = 0; i < 129; i++) {
      socket.message({ type: "input_audio_buffer.speech_started", item_id: `item-${i}` });
      socket.message({ type: "conversation.item.input_audio_transcription.completed", item_id: `item-${i}`, transcript: "synthetic" });
    }
    client.appendPcm16(Buffer.from(new Int16Array([42, -42]).buffer).toString("base64")); client.commit();
    const pending = (client as any).unboundAsrRun; const count = asrRuns(runs).length;
    onTranscriptDone.mockClear();
    socket.message({ type: `conversation.item.input_audio_transcription.${terminal}`, item_id: "item-0", transcript: "obsolete",
      error: { code: "invalid_api_key" } });
    expect(asrRuns(runs)).toHaveLength(count); expect(pending.settled).toBe(false);
    expect((client as any).unboundAsrRun).toBe(pending); expect(onTranscriptDone).not.toHaveBeenCalled();
    socket.message({ type: "conversation.item.input_audio_transcription.completed", item_id: "current-item", transcript: "current" });
    expect(asrRuns(runs)).toHaveLength(count + 1); expect(asrRuns(runs).at(-1)?.traceId).toBe(pending.traceId);
    expect(onTranscriptDone).toHaveBeenCalledWith("current"); client.close();
  });
  it("a new speech event without an item does not inherit the prior settled item and duplicate completion is ignored", async () => {
    const onTranscriptDone = vi.fn(); const { client, socket, runs } = await opened({ onTranscriptDone });
    socket.message({ type: "input_audio_buffer.speech_started", item_id: "prior" });
    socket.message({ type: "conversation.item.input_audio_transcription.completed", item_id: "prior", transcript: "prior" });
    socket.message({ type: "input_audio_buffer.speech_started" });
    socket.message({ type: "conversation.item.input_audio_transcription.completed", item_id: "current", transcript: "current" });
    socket.message({ type: "conversation.item.input_audio_transcription.completed", item_id: "current", transcript: "duplicate" });
    expect(asrRuns(runs)).toHaveLength(2); expect(asrRuns(runs)[0].traceId).not.toBe(asrRuns(runs)[1].traceId);
    expect(onTranscriptDone.mock.calls.map(call => call[0])).toEqual(["prior", "current"]); client.close();
  });
  it("a manual committed input with no terminal item settles its own pending ASR instead of the previous item", async () => {
    const { client, socket, runs } = await opened({}, { mode: "cascade" });
    socket.message({ type: "input_audio_buffer.speech_started", item_id: "prior" });
    socket.message({ type: "conversation.item.input_audio_transcription.completed", item_id: "prior", transcript: "prior" });
    client.appendPcm16(Buffer.from(new Int16Array([42, -42]).buffer).toString("base64")); client.commit();
    const pending = (client as any).unboundAsrRun;
    socket.message({ type: "conversation.item.input_audio_transcription.completed", transcript: "current" });
    expect(asrRuns(runs)).toHaveLength(2); expect(asrRuns(runs)[1].traceId).toBe(pending.traceId);
    client.close(); expect(asrRuns(runs)).toHaveLength(2);
  });
  it("bounds rejected input and retired ASR identifiers during a long connection and clears them on stop", async () => {
    const { client, socket } = await opened();
    for (let i = 0; i < 800; i++) {
      socket.message({ type: "input_audio_buffer.speech_started", item_id: `noise-${i}`, audio_start_ms: 1000 });
      socket.message({ type: "input_audio_buffer.speech_stopped", item_id: `noise-${i}`, audio_end_ms: 1050 });
    }
    expect((client as any).asrRuns.size).toBeLessThanOrEqual(128);
    expect((client as any).ignoredInputItemIds.size).toBeLessThanOrEqual(512);
    expect((client as any).retiredAsrItemIds.size).toBeLessThanOrEqual(512);
    client.close(); expect((client as any).ignoredInputItemIds.size).toBe(0);
    expect((client as any).retiredAsrItemIds.size).toBe(0);
  });
});

function controllerView() {
  const runtime = new VoiceSessionController(); runtime.connect(); runtime.connected();
  runtime.beginTurn({ route: "e2e", transcript: "synthetic request" });
  runtime.transitionTurn("endpointing"); runtime.transitionTurn("routing"); runtime.transitionTurn("generating");
  const view: any = { controller: { settings: { realtimeVoice: settings }, appendQualityLog: vi.fn(async () => undefined),
    appendAgentConversation: vi.fn(async () => undefined), submitAgentMessage: vi.fn(async () => ({ reply: "synthetic brain reply", actions: [] })) },
    agentVoiceRuntime: runtime, agentMode: "voice", agentBusy: true, agentRecording: true, agentVoiceSendInFlight: true,
    agentMessages: [{ role: "user", content: "synthetic request" }, { role: "assistant", content: "" }], agentOmniE2eAssistantIndex: 1,
    agentOmniE2eReply: "", agentOmniE2eUserMessage: "synthetic request", agentOmniPendingAudio: [], agentOmniPlaybackReady: null,
    agentTtsClient: null, agentRealtimeClient: null, agentVoiceTrace: {}, pendingAgentActions: [], voiceSession: createVoiceSession(),
    markVoiceTrace: vi.fn(), refreshAgentSurfaceState: vi.fn(), transitionVoiceSession: vi.fn(), setAgentMessageBubbleContent: vi.fn(),
    setAgentBusy: vi.fn((busy: boolean) => { view.agentBusy = busy; }), appendAgentQualityLog: vi.fn(async () => undefined),
    currentVoiceMessageText: () => "", resetCurrentVoiceTurnDraft: vi.fn(), agentAudioOutput: { cancel: vi.fn() } };
  return { runtime, view };
}

describe("independent actual Controller and client provider ownership checks", () => {
  it("rejects retry identity from a prior turn and bounds retired response ownership over many turns", () => {
    const { runtime } = controllerView(); runtime.bindResponse("first-response"); runtime.interrupt();
    for (let i = 0; i < 600; i++) {
      runtime.beginTurn({ route: "e2e", transcript: `synthetic ${i}` });
      runtime.bindResponse(`response-${i}`); runtime.retryResponse(`response-${i}`, `retry-${i}`); runtime.interrupt();
    }
    expect((runtime as any).retiredResponseIds.size).toBeLessThanOrEqual(512);
    runtime.beginTurn({ route: "e2e", transcript: "current" }); runtime.bindResponse("current-response");
    const current = runtime.snapshot().currentTurn!;
    expect(() => runtime.retryResponse("first-response", "foreign-retry")).toThrow("Invalid response retry");
    expect(runtime.snapshot().currentTurn).toMatchObject({ turnId: current.turnId, responseId: "current-response", phase: current.phase });
  });
  it.each(["text", "tool"])("does not restart a failed attempt after %s output, avoiding duplicate delivery or tools", async output => {
    const onError = vi.fn(); const onModelRetry = vi.fn(); const onToolCall = vi.fn(() => new Promise<string>(() => {}));
    const { client, socket, runs } = await opened({ onError, onModelRetry, onToolCall }); client.createResponse();
    socket.message({ type: "response.created", response: { id: "partial-response" } });
    socket.message(output === "text" ? { type: "response.text.delta", response_id: "partial-response", delta: "partial" }
      : { type: "response.function_call_arguments.done", response_id: "partial-response", call_id: "call", name: "query_vault", arguments: "{}" });
    socket.message({ type: "error", error: { message: "ModelServingError" } }); await vi.advanceTimersByTimeAsync(16_000);
    expect(onModelRetry).not.toHaveBeenCalled(); expect(onError).toHaveBeenCalledOnce();
    expect(socket.sent.filter(event => event.type === "response.create")).toHaveLength(1);
    expect(runs.filter(event => event.stage === "voice_response")).toMatchObject([{ run: { status: "failed", attempts: [{ status: "failed" }] } }]);
    client.close();
  });
  it.each([undefined, "retry-model"])("a retry with a new response ID keeps its turn and cannot claim a failed attempt model (model=%s)", async model => {
    const { runtime, view } = controllerView(); const owner = runtime.snapshot();
    let completion: Promise<void> | undefined; const onOldEvent = vi.fn(); const onToolCall = vi.fn(() => "unexpected");
    const { client, socket, runs } = await opened({
      onResponseCreated: (event: any) => handleOmniE2eResponseCreated(view, event),
      onResponseTextDelta: onOldEvent, onAudioDelta: onOldEvent, onToolCall,
      onResponseDone: (text: string, event: any) => { completion = finishOmniE2eVoiceTurn(view, text, event); },
      onProviderRun: (event: RealtimeProviderRunEvent) => recordVoiceProviderRun(view, runtime, event)
    }, { providerContext: () => ({ sessionId: runtime.snapshot().sessionId, generation: runtime.snapshot().generation,
      turnId: runtime.snapshot().currentTurn?.turnId }) });
    view.agentRealtimeClient = client; client.createResponse();
    socket.message({ type: "response.created", response: { id: "failed-attempt", model: "failed-model" } });
    socket.message({ type: "error", error: { message: "ModelServingError" } }); await vi.advanceTimersByTimeAsync(500);
    socket.message({ type: "response.created", response: { id: "successful-retry", ...(model ? { model } : {}) } });
    socket.message({ type: "response.text.delta", response_id: "failed-attempt", delta: "old text" });
    socket.message({ type: "response.audio.delta", response_id: "failed-attempt", delta: "AQACAA==" });
    socket.message({ type: "response.function_call_arguments.done", response_id: "failed-attempt", call_id: "old-call", name: "query_vault", arguments: "{}" });
    socket.message({ type: "response.done", response: { id: "failed-attempt", status: "completed" } });
    expect(onOldEvent).not.toHaveBeenCalled(); expect(onToolCall).not.toHaveBeenCalled();
    expect(runtime.snapshot().currentTurn?.responseId).toBe("successful-retry");
    expect(runtime.snapshot().currentTurn?.modelDone).toBe(false);
    socket.message({ type: "response.text.delta", response_id: "successful-retry", delta: "synthetic successful retry" });
    socket.message({ type: "response.done", response: { id: "successful-retry", status: "completed" } });
    await completion;
    const result = runs.find(event => event.stage === "voice_response")!;
    expect(result.run.actualModel).toBe(model ?? "reported-omni"); expect(result.run.attempts).toHaveLength(2);
    expect(result.run.attempts.map(attempt => attempt.status)).toEqual(["failed", "success"]);
    expect(result.context).toMatchObject({ turnId: owner.currentTurn!.turnId, generation: owner.generation });
    expect(runtime.snapshot().currentTurn?.phase).toBe("completed"); client.close();
  });
  it("tool response and its retried continuation have distinct successful traces in the same turn, with one final turn completion", async () => {
    const { runtime, view } = controllerView(); const owner = runtime.snapshot();
    let resolveTool!: (value: string) => void; const tool = new Promise<string>(resolve => { resolveTool = resolve; });
    let completion: Promise<void> | undefined;
    const { client, socket, runs } = await opened({ onToolCall: () => tool,
      onResponseCreated: (event: any) => handleOmniE2eResponseCreated(view, event),
      onResponseDone: (text: string, event: any) => { completion = finishOmniE2eVoiceTurn(view, text, event); },
      onProviderRun: (event: RealtimeProviderRunEvent) => recordVoiceProviderRun(view, runtime, event)
    }, { providerContext: () => ({ sessionId: runtime.snapshot().sessionId, generation: runtime.snapshot().generation,
      turnId: runtime.snapshot().currentTurn?.turnId }) });
    view.agentRealtimeClient = client; client.createResponse();
    socket.message({ type: "response.created", response: { id: "private-tool-response", model: "tool-model" } });
    socket.message({ type: "response.function_call_arguments.done", response_id: "private-tool-response", call_id: "query-call",
      name: "query_vault", arguments: "{}" });
    socket.message({ type: "response.done", response: { id: "private-tool-response", status: "completed" } });
    const responseRuns = () => runs.filter(event => event.stage === "voice_response");
    expect(responseRuns()).toHaveLength(1); expect(runtime.snapshot().currentTurn?.modelDone).toBe(false);
    expect(socket.sent.filter(event => event.type === "response.create")).toHaveLength(1);
    resolveTool("synthetic query result"); await flush();
    expect(socket.sent.filter(event => event.type === "response.create")).toHaveLength(2);
    socket.message({ type: "error", error: { message: "ModelServingError" } }); await vi.advanceTimersByTimeAsync(500);
    expect(socket.sent.filter(event => event.type === "response.create")).toHaveLength(3);
    socket.message({ type: "response.created", response: { id: "private-continuation", model: "reply-model" } });
    socket.message({ type: "response.text.delta", response_id: "private-continuation", delta: "synthetic final reply" });
    socket.message({ type: "response.done", response: { id: "private-continuation", status: "completed" } });
    await completion; await flush(); expect(responseRuns()).toHaveLength(2);
    expect(responseRuns().map(event => event.run.actualModel)).toEqual(["tool-model", "reply-model"]);
    expect(responseRuns()[0].traceId).not.toBe(responseRuns()[1].traceId);
    for (const event of responseRuns()) {
      expect(event.context).toEqual({ sessionId: owner.sessionId, generation: owner.generation, turnId: owner.currentTurn!.turnId });
      expect(event.run.status).toBe("success"); expect(event.run.attempts.at(-1)?.status).toBe("success");
      expect(runtime.eventJournal().snapshot().find(row => row.providerTraceId === event.traceId)).toMatchObject({ turnId: owner.currentTurn!.turnId });
    }
    expect(responseRuns()[1].run.attempts).toHaveLength(2);
    expect(runtime.snapshot().currentTurn?.phase).toBe("completed"); expect(view.controller.appendAgentConversation).toHaveBeenCalledOnce();
    expect(JSON.stringify(view.controller.appendQualityLog.mock.calls)).not.toMatch(/private-tool-response|private-continuation/);
    client.close();
  });
  it("six failed attempts retain one old trace and hand the same turn to the brain with a fresh local trace", async () => {
    const { runtime, view } = controllerView(); const owner = runtime.snapshot(); let fallback: Promise<void> | undefined;
    const { client, socket, runs } = await opened({ onError: (message: string) => { fallback = fallbackOmniResponseToBrain(view, message); },
      onProviderRun: (event: RealtimeProviderRunEvent) => recordVoiceProviderRun(view, runtime, event)
    }, { providerContext: () => ({ sessionId: runtime.snapshot().sessionId, generation: runtime.snapshot().generation,
      turnId: runtime.snapshot().currentTurn?.turnId }) });
    view.agentRealtimeClient = client; client.createResponse();
    for (const delay of [500, 1000, 2000, 4000, 8000]) {
      socket.message({ type: "error", error: { message: "ModelServingError" } }); await vi.advanceTimersByTimeAsync(delay);
    }
    socket.message({ type: "error", error: { message: "ModelServingError" } }); await fallback; await flush();
    const responseRuns = runs.filter(event => event.stage === "voice_response"); expect(responseRuns).toHaveLength(1);
    expect(responseRuns[0].run).toMatchObject({ status: "failed", fallbackUsed: true }); expect(responseRuns[0].run.attempts).toHaveLength(6);
    const options = view.controller.submitAgentMessage.mock.calls[0][2];
    expect(options).toMatchObject({ source: "voice", signal: owner.currentTurn!.abortController.signal });
    expect(options.providerTraceId).toMatch(/^[0-9a-f-]{36}$/); expect(options.providerTraceId).not.toBe(responseRuns[0].traceId);
    expect(runtime.eventJournal().snapshot().find(row => row.providerTraceId === options.providerTraceId)).toMatchObject({
      sessionId: owner.sessionId, generation: owner.generation, turnId: owner.currentTurn!.turnId, route: "brain",
      eventType: "provider.voice_response.requested" });
    socket.message({ type: "error", error: { message: "ModelServingError" } }); await vi.advanceTimersByTimeAsync(16_000);
    expect(view.controller.submitAgentMessage).toHaveBeenCalledOnce();
    expect(socket.sent.filter(event => event.type === "response.create")).toHaveLength(6);
    expect(runtime.snapshot().currentTurn?.phase).toBe("completed"); client.close();
  });
});
