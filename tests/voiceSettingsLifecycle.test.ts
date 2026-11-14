import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/defaults";
import type { LifeOpsSettings } from "../src/types";
import { voiceSettingsRevision } from "../src/voice/voiceSettingsBoundary";
import { BreezeResidentWorker } from "../src/voice/breezeResident";
import { sessionBreeze } from "../src/voice/breezeSpeech";
import { setProviderEgressSink } from "../src/privacy";

const transport = vi.hoisted(() => {
  const socket = vi.fn();
  const sockets: FakeSocket[] = [];
  class FakeSocket {
    static OPEN = 1;
    readyState = 0;
    readonly sent: string[] = [];
    private readonly handlers = new Map<string, Array<(...args: unknown[]) => void>>();
    constructor() {
      socket();
      if (!flags.allowFakeSockets) throw new Error("No real sockets");
      sockets.push(this);
    }
    on(event: string, handler: (...args: unknown[]) => void): this {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
      return this;
    }
    emit(event: string, ...args: unknown[]): void {
      for (const handler of this.handlers.get(event) ?? []) handler(...args);
    }
    open(): void { this.readyState = FakeSocket.OPEN; this.emit("open"); }
    send(message: string): void { this.sent.push(message); }
    message(event: Record<string, unknown>): void { this.emit("message", Buffer.from(JSON.stringify(event))); }
    close(): void { this.readyState = 3; this.emit("close", 1000, Buffer.alloc(0)); }
    terminate(): void { this.close(); }
  }
  const flags = { allowFakeSockets: false };
  return { fetch: vi.fn(), socket, sockets, FakeSocket, flags };
});
vi.mock("obsidian", () => ({
  App: class {}, Plugin: class { constructor(readonly app: any, readonly manifest: any) {} async saveData() {} async loadData() {} },
  TFile: class {}, TFolder: class {}, WorkspaceLeaf: class {}, ItemView: class {}, Modal: class {},
  PluginSettingTab: class {}, Setting: class {}, Platform: { isDesktopApp: false }, Notice: class {}, setIcon: vi.fn(),
  normalizePath: (path: string) => path.replace(/\\/g, "/").replace(/\/{2,}/g, "/"),
  requestUrl: vi.fn(() => { throw new Error("Unexpected non-streaming transport"); })
}));
vi.mock("ws", () => ({ default: transport.FakeSocket }));
const { default: LifeOpsPlugin } = await import("../src/main");
const { LifeOpsView } = await import("../src/lifeOpsView");
const { LifeOpsStore } = await import("../src/store");
const { LifeOpsAi } = await import("../src/ai");
const { BailianConnectionTimeoutError, BailianRealtimeClient } = await import("../src/bailianRealtime");
const { DiskVault } = await import("./helpers/diskVault");
const { startBailianRealtimeRecording, guardRealtimeCallbacks, startSystemSpeechForActiveTurn, finishOmniE2eVoiceTurn, sendManagedVoiceTurn } = await import("../src/voice/voiceRealtime");

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function settings(): LifeOpsSettings {
  const value = structuredClone(DEFAULT_SETTINGS);
  value.ai = { ...value.ai, provider: "openai-compatible", endpoint: "https://voice.synthetic.invalid/chat", model: "synthetic", apiKey: "synthetic-key", dataDisclosureAccepted: true };
  value.privacy!.plaintextCredentialStorageAccepted = true;
  value.realtimeVoice.apiKey = "synthetic-voice-key";
  value.realtimeVoice.dataDisclosureAccepted = true;
  value.realtimeVoice.plaintextCredentialStorageAccepted = true;
  return value;
}
function streamResponse(content: string): Response {
  return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`, {
    status: 200, headers: { "Content-Type": "text/event-stream" }
  });
}
let directory: string, vault: InstanceType<typeof DiskVault>, plugin: any, view: any;
let getUserMedia: ReturnType<typeof vi.fn>, utterances: any[];

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("fetch", transport.fetch);
  transport.fetch.mockReset(); transport.socket.mockClear();
  transport.sockets.length = 0;
  transport.flags.allowFakeSockets = false;
  getUserMedia = vi.fn(() => { throw new Error("Unexpected microphone request"); });
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  vi.stubGlobal("MediaRecorder", class {
    static isTypeSupported() { return true; }
    state = "inactive"; onstop: (() => void) | null = null; ondataavailable: ((event: { data: Blob }) => void) | null = null;
    start() { this.state = "recording"; }
    stop() { this.state = "inactive"; this.onstop?.(); }
  });
  utterances = [];
  vi.stubGlobal("SpeechSynthesisUtterance", class { constructor(readonly text: string) {} });
  vi.stubGlobal("speechSynthesis", { speaking: false, cancel: vi.fn(), speak: vi.fn((utterance: any) => utterances.push(utterance)) });
  directory = await mkdtemp(join(tmpdir(), "lifeops-voice-settings-"));
  vault = new DiskVault(directory);
  const leaves: Array<{ view: unknown }> = [];
  const app: any = { vault, workspace: { getLeavesOfType: () => leaves } };
  plugin = new LifeOpsPlugin(app, { id: "lifeops-assistant", dir: "" } as never);
  plugin.loadData = vi.fn(async () => settings());
  await plugin.loadSettings();
  plugin.store = new LifeOpsStore(app, plugin.settings);
  vi.spyOn(LifeOpsStore.prototype as any, "appendProviderEgressAudit").mockResolvedValue(undefined);
  await plugin.store.initializeVault();
  plugin.ai = new LifeOpsAi(plugin.settings);
  plugin.updateStatusBar = vi.fn(async () => {});
  view = new LifeOpsView({} as never, plugin);
  view.render = vi.fn(async () => {});
  view.refreshAgentSurfaceState = vi.fn();
  view.appendVoiceMetric = vi.fn();
  view.appendAgentQualityLog = vi.fn(async () => {});
  leaves.push({ view });
});

afterEach(async () => {
  view.invalidateVoiceSettings();
  setProviderEgressSink(null);
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  await rm(directory, { recursive: true, force: true });
});

describe("cascade waits for the final recognition result", () => {
  const preview = "帮我创建一个明天下午三点的任务，标题是。";
  const complete = "帮我创建一个明天下午三点的任务，标题是买牛奶。";
  function listening() {
    Object.assign(plugin.settings.realtimeVoice, { provider: "qwen-omni-realtime", mode: "cascade", triggerEnabled: false });
    view.agentMode = "voice"; view.agentRecording = true; view.agentVoiceReady = true;
    view.agentRealtimeClient = new BailianRealtimeClient(plugin.settings.realtimeVoice, {});
    view.tryAcceptPendingActionFromVoice = vi.fn(async () => true);
    view.queueCurrentVoiceInput = vi.fn();
    view.updateRealtimeTranscript(preview);
  }

  it.each([{}, { localEndpoint: true, silenceMs: 9_000 }])("keeps the preview until final ASR, even after a long local pause (%j)", async options => {
    listening();
    await view.sendVoiceTurnIfReady(options);
    expect(view.tryAcceptPendingActionFromVoice).not.toHaveBeenCalled();
    expect(view.queueCurrentVoiceInput).not.toHaveBeenCalled();
    expect(view.currentVoiceMessageText()).toBe(preview);

    view.updateRealtimeTranscript(complete, true);
    await view.sendVoiceTurnIfReady(options);
    expect(view.tryAcceptPendingActionFromVoice).toHaveBeenCalledExactlyOnceWith(complete);
    expect(transport.fetch).not.toHaveBeenCalled();
  });

  it("blocks direct managed dispatch and busy queuing of an unfinished preview", async () => {
    listening(); view.agentBusy = true;
    await sendManagedVoiceTurn(view, "delayed automatic dispatch");
    expect(view.queueCurrentVoiceInput).not.toHaveBeenCalled();
    expect(view.tryAcceptPendingActionFromVoice).not.toHaveBeenCalled();
    expect(view.currentVoiceMessageText()).toBe(preview);
  });

  it("allows explicit stop to submit the collected text", async () => {
    listening(); view.agentRecording = false;
    await sendManagedVoiceTurn(view, "manual cascade stop");
    expect(view.tryAcceptPendingActionFromVoice).toHaveBeenCalledExactlyOnceWith(preview);
  });

  it("preserves the browser recording submission path", async () => {
    listening(); plugin.settings.realtimeVoice.provider = "browser-live";
    view.sendAgentMessage = vi.fn(async () => {});
    await view.sendVoiceTurnIfReady();
    expect(view.sendAgentMessage).toHaveBeenCalledExactlyOnceWith("voice");
  });
});

describe("ordinary voice and text mode cycles", () => {
  function captureFixture(mockConnection = true) {
    const tracks: Array<{ readyState: string; stop: ReturnType<typeof vi.fn> }> = [];
    const contexts: Array<{ state: string }> = [];
    getUserMedia.mockImplementation(async () => {
      const track = {
        readyState: "live",
        stop: vi.fn(function (this: { readyState: string }) { this.readyState = "ended"; })
      };
      tracks.push(track);
      return { getTracks: () => [track] };
    });
    vi.stubGlobal("AudioContext", class {
      state = "running"; sampleRate = 16000; destination = {}; audioWorklet = undefined;
      constructor() { contexts.push(this); }
      createMediaStreamSource() { return { connect: vi.fn(), disconnect: vi.fn() }; }
      createScriptProcessor() { return { connect: vi.fn(), disconnect: vi.fn(), onaudioprocess: null }; }
      createGain() { return { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() }; }
      async close() { this.state = "closed"; }
    });
    const connects = vi.spyOn(BailianRealtimeClient.prototype, "connect");
    if (mockConnection) connects.mockResolvedValue(undefined);
    return { tracks, contexts, connects };
  }

  it("prewarms the first local voice reply before microphone permission and reuses that worker", async () => {
    const capture = captureFixture();
    const permission = deferred<void>();
    const acquire = getUserMedia.getMockImplementation() as () => Promise<MediaStream>;
    getUserMedia.mockImplementation(async () => { await permission.promise; return acquire(); });
    const warm = vi.spyOn(BreezeResidentWorker.prototype, "warm").mockResolvedValue(undefined);
    const close = vi.spyOn(BreezeResidentWorker.prototype, "close").mockResolvedValue(undefined);
    Object.assign(plugin.settings.realtimeVoice, { provider: "qwen-omni-realtime", mode: "cascade", ttsEngine: "breeze-local", speakReplies: true });
    view.agentMode = "voice";

    const starting = view.ensureVoiceStandby();
    const worker = sessionBreeze(view);
    expect(worker).toBeInstanceOf(BreezeResidentWorker);
    expect(warm).toHaveBeenCalledOnce();
    expect(capture.connects).not.toHaveBeenCalled();
    permission.resolve();
    await starting;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(view.agentVoiceReady).toBe(true);
    expect(sessionBreeze(view)).toBe(worker);
    expect(warm).toHaveBeenCalledOnce();
    view.stopVoiceStandby();
    expect(sessionBreeze(view)).toBeUndefined();
    expect(close).toHaveBeenCalledOnce();
  });

  it.each(["permission", "connection"] as const)("settles a first %s startup failure without claiming recovery or reopening the microphone", async kind => {
    const capture = captureFixture();
    if (kind === "permission") getUserMedia.mockRejectedValue(new Error("synthetic microphone unavailable"));
    else capture.connects.mockRejectedValue(new Error("synthetic connection failed"));
    view.agentMode = "voice"; view.agentVoiceConversation = true; view.agentInput = "保留的虚构草稿";
    await startBailianRealtimeRecording(view);
    expect(view.agentVoiceRuntime.snapshot().sessionPhase).toBe("stopped");
    expect(view.agentStatusLabel()).not.toContain("恢复");
    expect(view.agentVoiceConversation).toBe(false); expect(view.agentRecording).toBe(false);
    expect(view.agentStream).toBeNull(); expect(view.agentRealtimeClient).toBeNull(); expect(view.agentVoiceReconnectTimer).toBe(0);
    expect(view.agentVoiceReconnectAttempts).toBe(0); expect(view.agentInput).toBe("保留的虚构草稿");
    expect(view.agentReply).toContain("启动失败");
    expect(capture.tracks.every(t => t.readyState === "ended")).toBe(true);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(getUserMedia).toHaveBeenCalledOnce(); expect(transport.socket).not.toHaveBeenCalled();
  });

  it("collects hotwords from local records, prefers manually entered terms and uses the hotword engine", async () => {
    const capture = captureFixture();
    const today = new Date().toLocaleDateString("sv-SE");
    await plugin.store.createHabit({ name: "虚构纸牌训练", frequencyUnit: "day", frequencyInterval: 1, targetCount: 1, startDate: today });
    await plugin.store.createTask({ title: "整理 EVALBOX 目录", date: today });
    const configured = "虚构手填词\n" + plugin.settings.realtimeVoice.apiKey;
    plugin.settings.realtimeVoice.asrHotwords = configured;
    view.agentMode = "voice";
    await startBailianRealtimeRecording(view);
    const client = capture.connects.mock.contexts[0] as unknown as { settings: LifeOpsSettings["realtimeVoice"] };
    expect(client.settings.asrEngine).toBe("streaming-hotwords");
    const words = client.settings.asrHotwords!.split("\n");
    expect(words[0]).toBe("虚构手填词");
    expect(words).toEqual(expect.arrayContaining(["虚构纸牌训练", "EVALBOX"]));
    expect(words).not.toContain(plugin.settings.realtimeVoice.apiKey);
    expect(plugin.settings.realtimeVoice.asrHotwords).toBe(configured);
    expect(getUserMedia).toHaveBeenCalledOnce();
  });

  it("falls back from automatic hotwords on connection failure without reopening the microphone", async () => {
    const capture = captureFixture();
    plugin.settings.realtimeVoice.asrHotwords = "虚构手填词";
    capture.connects.mockRejectedValueOnce(new Error("synthetic hotword connection error"));
    view.agentMode = "voice";
    await startBailianRealtimeRecording(view);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(capture.connects).toHaveBeenCalledTimes(2);
    expect(capture.connects.mock.contexts[1]).not.toBe(capture.connects.mock.contexts[0]);
    expect(view.agentVoiceReady).toBe(true);
    expect(getUserMedia).toHaveBeenCalledOnce();
  });

  it("preserves credential filtering when collection of automatic hotwords fails", async () => {
    const capture = captureFixture();
    const credential = plugin.settings.realtimeVoice.apiKey;
    plugin.settings.realtimeVoice.asrHotwords = "虚构词\n" + credential;
    vi.spyOn(plugin, "collectVoiceSessionHotwords").mockRejectedValue(new Error("虚构索引异常"));
    view.agentMode = "voice";
    await startBailianRealtimeRecording(view);
    const client = capture.connects.mock.contexts[0] as unknown as { settings: LifeOpsSettings["realtimeVoice"] };
    expect(client.settings.asrHotwords).toBe("虚构词");
  });

  it.each(["cascade", "omni-e2e"] as const)("installs mode-specific realtime callbacks for %s", async mode => {
    const capture = captureFixture();
    Object.assign(plugin.settings.realtimeVoice, { provider: "qwen-omni-realtime", mode, asrEngine: "realtime-only" });
    view.agentMode = "voice";
    await startBailianRealtimeRecording(view);
    const client = capture.connects.mock.contexts[0] as unknown as {
      callbacks: import("../src/bailianRealtime").BailianRealtimeCallbacks;
      options: import("../src/bailianRealtime").BailianRealtimeOptions;
    };
    expect(typeof client.callbacks.onCascadeCapture === "function").toBe(mode === "cascade");
    for (const name of ["onTranscriptDone", "onAudioDelta", "onResponseDone", "onToolCall", "onModelRetry"] as const) {
      expect(typeof client.callbacks[name] === "function").toBe(mode === "omni-e2e");
    }
    expect(typeof client.options.instructions === "string").toBe(mode === "omni-e2e");
    expect(typeof client.callbacks.onInitialContextError).toBe("function");
  });

  it.each([true, false])("retries a cascade startup timeout once on the same microphone (recovers: %s)", async recovers => {
    const capture = captureFixture();
    Object.assign(plugin.settings.realtimeVoice, { provider: "qwen-omni-realtime", mode: "cascade" });
    capture.connects.mockRejectedValueOnce(new BailianConnectionTimeoutError());
    if (!recovers) capture.connects.mockRejectedValueOnce(new BailianConnectionTimeoutError());
    view.agentMode = "voice";
    view.agentVoiceConversation = true;
    await startBailianRealtimeRecording(view);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(capture.connects).toHaveBeenCalledTimes(2);
    expect(capture.connects.mock.contexts[0]).toBeInstanceOf(BailianRealtimeClient);
    expect(capture.connects.mock.contexts[1]).toBe(capture.connects.mock.contexts[0]);
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(view.agentVoiceRuntime.snapshot().sessionPhase).toBe(recovers ? "listening" : "stopped");
    expect(view.agentVoiceReady).toBe(recovers);
    expect(capture.tracks[0].readyState).toBe(recovers ? "live" : "ended");
  });

  it.each([true, false])("runs the real client through a first socket timeout (recovers: %s)", async recovers => {
    const capture = captureFixture(false);
    transport.flags.allowFakeSockets = true;
    Object.assign(plugin.settings.realtimeVoice, { provider: "qwen-omni-realtime", mode: "cascade", asrEngine: "realtime-only" });
    view.agentMode = "voice";
    view.agentVoiceConversation = true;
    const update = vi.spyOn(view, "updateRealtimeTranscript");

    const starting = startBailianRealtimeRecording(view);
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.sockets).toHaveLength(1);
    const [first] = transport.sockets;
    const client = view.agentRealtimeClient;
    await vi.advanceTimersByTimeAsync(11_999);
    expect(first.readyState).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(first.readyState).toBe(3);
    expect(transport.sockets).toHaveLength(2);
    const second = transport.sockets[1];
    expect(capture.connects).toHaveBeenCalledTimes(2);
    expect(capture.connects.mock.contexts[0]).toBe(client);
    expect(capture.connects.mock.contexts[1]).toBe(client);
    expect(getUserMedia).toHaveBeenCalledOnce();

    if (recovers) {
      second.open();
      second.message({ type: "session.updated" });
      await starting;
      await vi.advanceTimersByTimeAsync(3000);
      const sentByActiveSocket = second.sent.length;
      first.emit("open");
      first.message({ type: "input_audio_buffer.speech_started", item_id: "stale" });
      first.message({ type: "conversation.item.input_audio_transcription.text", item_id: "stale", text: "虚构旧连接" });
      first.emit("error", new Error("虚构旧连接错误"));
      first.emit("close", 1006, Buffer.from("虚构旧连接关闭"));
      expect(update).not.toHaveBeenCalled();
      expect(view.agentRealtimeClient).toBe(client);
      expect(first.sent).toHaveLength(0);
      expect(second.sent).toHaveLength(sentByActiveSocket);
      expect(second.readyState).toBe(transport.FakeSocket.OPEN);
      expect(view.agentVoiceReady).toBe(true);
      expect(view.agentVoiceRuntime.snapshot().sessionPhase).toBe("listening");
      expect(capture.tracks[0].readyState).toBe("live");
    } else {
      await vi.advanceTimersByTimeAsync(12_000);
      await starting;
      expect(second.readyState).toBe(3);
      expect(capture.tracks[0].readyState).toBe("ended");
      expect(view.agentStream).toBeNull();
      expect(view.agentRealtimeClient).toBeNull();
      expect(view.agentVoiceReady).toBe(false);
      expect(view.agentVoiceSendInFlight).toBe(false);
      expect(plugin.activeVoiceRequests.size).toBe(0);
      expect(view.agentVoiceRuntime.snapshot().sessionPhase).toBe("stopped");
      expect(view.agentVoiceRuntime.snapshot().currentTurn).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(31_000);
      expect(transport.sockets).toHaveLength(2);
      expect(getUserMedia).toHaveBeenCalledOnce();
    }
  });

  it("stops once and prompts for a restart when the open socket never acknowledges its session", async () => {
    const capture = captureFixture(false);
    transport.flags.allowFakeSockets = true;
    Object.assign(plugin.settings.realtimeVoice, { provider: "qwen-omni-realtime", mode: "cascade", asrEngine: "realtime-only" });
    view.agentMode = "voice";
    view.agentVoiceConversation = true;
    const starting = startBailianRealtimeRecording(view);
    await vi.advanceTimersByTimeAsync(0);
    const [socket] = transport.sockets;
    socket.open();
    await starting;
    await vi.advanceTimersByTimeAsync(12_000);
    expect(socket.readyState).toBe(3);
    expect(capture.tracks[0].readyState).toBe("ended");
    expect(capture.contexts).toHaveLength(1);
    expect(capture.contexts.every(context => context.state === "closed")).toBe(true);
    expect(view.agentStream).toBeNull();
    expect(view.agentRealtimeClient).toBeNull();
    expect(view.agentVoiceReady).toBe(false);
    expect(view.agentReply).toContain("请重新开始语音");
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(transport.sockets).toHaveLength(1);
    expect(getUserMedia).toHaveBeenCalledOnce();
  });

  it("retries a failed original voice selection once while keeping busy, pending and active capture protected", async () => {
    const capture = captureFixture(), [voice, text] = modeButtons();
    vi.spyOn(plugin, "buildVoiceSessionContextBlock").mockResolvedValue("纯虚构重试上下文");
    capture.connects.mockRejectedValueOnce(new Error("synthetic first connection failed"));
    const ensure = vi.spyOn(view, "ensureVoiceStandby");
    await voice.onclick(); await ensure.mock.results[0].value;
    expect(view.agentMode).toBe("voice"); expect(view.agentRecording).toBe(false);
    expect(view.agentVoiceReady).toBe(false); expect(view.agentBusy).toBe(false);
    expect(view.agentVoiceConversation).toBe(false);
    expect(view.agentVoiceRuntime.snapshot().sessionPhase).toBe("stopped");
    expect(capture.tracks[0].readyState).toBe("ended");
    ensure.mockClear();

    view.setAgentBusy(true); await voice.onclick();
    expect(ensure).not.toHaveBeenCalled(); expect(getUserMedia).toHaveBeenCalledOnce();
    view.setAgentBusy(false);
    const microphoneEntered = deferred<void>(), microphoneGate = deferred<void>();
    const acquire = getUserMedia.getMockImplementation()!;
    getUserMedia.mockImplementationOnce(async (...args: any[]) => {
      microphoneEntered.resolve(); await microphoneGate.promise;
      return Reflect.apply(acquire, undefined, args);
    });
    try {
      await voice.onclick();
      expect(ensure).toHaveBeenCalledOnce();
      await microphoneEntered.promise;
      expect(view.agentVoiceConversation).toBe(true); expect(view.agentRecording).toBe(false);
      await voice.onclick();
      expect(ensure).toHaveBeenCalledOnce(); expect(getUserMedia).toHaveBeenCalledTimes(2);
    } finally {
      microphoneGate.resolve();
      await Promise.all(ensure.mock.results.filter(row => row.type === "return").map(row => row.value));
    }
    await vi.advanceTimersByTimeAsync(3000);
    expect(view.agentRecording).toBe(true); expect(view.agentVoiceReady).toBe(true);
    expect(view.agentVoiceRuntime.snapshot().sessionPhase).toBe("listening");
    const current = view.agentRealtimeClient;
    await voice.onclick();
    expect(ensure).toHaveBeenCalledOnce(); expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(capture.connects).toHaveBeenCalledTimes(2); expect(view.agentRealtimeClient).toBe(current);
    await text.onclick();
    expect(capture.tracks.every(track => track.readyState === "ended")).toBe(true);
    expect(capture.contexts.every(context => context.state === "closed")).toBe(true);
    expect(transport.fetch).not.toHaveBeenCalled(); expect(transport.socket).not.toHaveBeenCalled();
  });

  it("preserves scheduled recovery and settles after the existing reconnect limit", async () => {
    const capture = captureFixture(); capture.connects.mockRejectedValue(new Error("synthetic reconnect failed"));
    plugin.settings.realtimeVoice.asrEngine = "realtime-only";
    vi.spyOn(plugin, "buildVoiceSessionContextBlock").mockResolvedValue("纯虚构重连上下文");
    view.agentMode = "voice"; view.agentVoiceConversation = true; view.agentVoiceReconnectAttempts = 1;
    await startBailianRealtimeRecording(view);
    expect(view.agentVoiceRuntime.snapshot().sessionPhase).toBe("recovering");
    expect(view.agentVoiceReconnectTimer).not.toBe(0); expect(view.agentVoiceReconnectAttempts).toBe(2);
    expect(view.agentStatusLabel()).toContain("恢复");
    await vi.advanceTimersByTimeAsync(31_000);
    expect(capture.connects).toHaveBeenCalledTimes(5); expect(getUserMedia).toHaveBeenCalledTimes(5);
    expect(capture.tracks).toHaveLength(5); expect(capture.tracks.every(t => t.readyState === "ended")).toBe(true);
    expect(view.agentVoiceRuntime.snapshot().sessionPhase).toBe("stopped"); expect(view.agentVoiceConversation).toBe(false);
    expect(view.agentRecording).toBe(false); expect(view.agentVoiceReconnectAttempts).toBe(0); expect(view.agentVoiceReconnectTimer).toBe(0);
    expect(view.agentStatusLabel()).not.toContain("恢复"); expect(view.agentReply).toContain("自动重连未成功");
    await vi.advanceTimersByTimeAsync(31_000); expect(getUserMedia).toHaveBeenCalledTimes(5);
  });

  it("does not let an old failure render restart a new voice session", async () => {
    const capture = captureFixture(); capture.connects.mockRejectedValueOnce(new Error("synthetic old connection failed"));
    vi.spyOn(plugin, "buildVoiceSessionContextBlock").mockResolvedValue("纯虚构重开上下文");
    const rendering = deferred<void>(), gate = deferred<void>();
    view.render.mockImplementationOnce(() => { rendering.resolve(); return gate.promise; });
    const ensure = vi.spyOn(view, "ensureVoiceStandby"), [voice, text] = modeButtons();
    view.agentMode = "voice"; view.agentVoiceConversation = true; view.agentVoiceReconnectAttempts = 1;
    const old = startBailianRealtimeRecording(view); await rendering.promise;
    await text.onclick(); await voice.onclick(); await ensure.mock.results.at(-1)!.value;
    await vi.advanceTimersByTimeAsync(3000);
    const stream = view.agentStream;
    expect(view.agentVoiceRuntime.snapshot().sessionPhase).toBe("listening");
    expect(view.agentVoiceReconnectAttempts).toBe(0); expect(getUserMedia).toHaveBeenCalledTimes(2);
    gate.resolve(); await old;
    expect(view.agentVoiceReconnectTimer).toBe(0); expect(view.agentStream).toBe(stream);
    expect(view.agentStatusLabel()).not.toContain("恢复");
    await vi.advanceTimersByTimeAsync(31_000); expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(capture.tracks.map(t => t.readyState)).toEqual(["ended", "live"]);
  });

  function modeButtons() {
    const buttons: any[] = [];
    const container = {
      createEl(_tag: string, options: any, callback: (button: any) => void) {
        const button = {
          dataset: { agentMode: options.attr["data-agent-mode"] },
          toggleClass() {}, setAttr() {}, createSpan() { return {}; }, onclick: null
        };
        buttons.push(button); callback(button); return button;
      }
    };
    view.agentModeButton(container, "mic", "语音", "voice");
    view.agentModeButton(container, "keyboard", "文字", "text");
    return buttons;
  }

  it("settles an active voice reply before stopping its runtime and keeps text usable", async () => {
    const capture = captureFixture();
    view.agentMode = "voice"; await view.ensureVoiceStandby(); await vi.advanceTimersByTimeAsync(3000);
    const runtime = view.agentVoiceRuntime;
    runtime.beginTurn({ route: "e2e", transcript: "合成在途语音" });
    runtime.transitionTurn("routing", "synthetic"); runtime.transitionTurn("generating", "synthetic");
    view.agentVoiceSendInFlight = true; view.setAgentBusy(true);
    view.agentMessages = [{ role: "assistant", content: "" }]; view.agentOmniE2eAssistantIndex = 0;
    const surfaces: unknown[] = [];
    view.refreshAgentSurfaceState.mockImplementation(() => surfaces.push({ busy: view.agentBusy, recording: view.agentRecording, phase: runtime.snapshot().sessionPhase }));
    view.stopVoiceStandby();
    expect(surfaces.at(-1)).toEqual({ busy: false, recording: false, phase: "stopped" });
    expect(view.agentBusy).toBe(false); expect(view.agentBusySince).toBe(0);
    expect(view.agentVoiceSendInFlight).toBe(false); expect(view.agentOmniE2eAssistantIndex).toBe(-1);
    expect(runtime.snapshot().sessionPhase).toBe("stopped");
    expect(capture.tracks.every(track => track.readyState === "ended")).toBe(true);
    expect(capture.contexts.every(context => context.state === "closed")).toBe(true);
    expect((await submitOrdinaryText()).reply).toBe("纯虚构文字入口正常回应");
  });

  it("does not clear an independent text request when voice standby is stopped", () => {
    view.agentMode = "text"; view.setAgentBusy(true); view.agentInput = "保留的文字草稿";
    view.stopVoiceStandby();
    expect(view.agentBusy).toBe(true); expect(view.agentBusySince).toBeGreaterThan(0);
    expect(view.agentInput).toBe("保留的文字草稿");
  });

  it("still releases recording and runtime if speech cancellation throws", async () => {
    const capture = captureFixture();
    view.agentMode = "voice"; await view.ensureVoiceStandby(); await vi.advanceTimersByTimeAsync(3000);
    vi.spyOn(view, "interruptAgentSpeech").mockImplementationOnce(() => { throw Error("synthetic cancellation failure"); });
    expect(() => view.stopVoiceStandby()).toThrow("synthetic cancellation failure");
    expect(view.agentVoiceRuntime.snapshot().sessionPhase).toBe("stopped");
    expect(view.agentStream).toBeNull(); expect(view.agentRealtimeClient).toBeNull();
    expect(capture.tracks.every(track => track.readyState === "ended")).toBe(true);
    expect(capture.contexts.every(context => context.state === "closed")).toBe(true);
  });

  async function submitOrdinaryText() {
    for (const key of ["agentTurnStream"]) {
      vi.spyOn(plugin.ai, key).mockResolvedValue({ content: "纯虚构文字入口正常回应", toolCalls: [] });
    }
    return plugin.submitAgentMessage("这是一次纯虚构文字入口核对，请只返回固定回应", [], { source: "text" });
  }

  it.each(["success", "error"] as const)("starts the selected original voice mode after an in-flight text reply settles (%s)", async outcome => {
    plugin.settings.realtimeVoice.mode = "omni-e2e";
    plugin.settings.realtimeVoice.speakReplies = false;
    const capture = captureFixture(), [voice] = modeButtons();
    const gate = deferred<any>(), entered = deferred<void>();
    vi.spyOn(plugin, "submitAgentMessageStream").mockImplementation(() => { entered.resolve(); return gate.promise; });
    view.agentInput = "纯虚构文字问候";
    const textRequest = view.sendAgentMessage("text"); await entered.promise;
    expect(view.agentBusy).toBe(true);
    await voice.onclick(); expect(view.agentMode).toBe("voice"); expect(view.agentVoiceConversation).toBe(true);
    expect(getUserMedia).not.toHaveBeenCalled();
    if (outcome === "success") gate.resolve({reply: "纯虚构文字回复", actions: []});
    else gate.reject(new Error("synthetic text provider unavailable"));
    await textRequest; await vi.advanceTimersByTimeAsync(3000);
    expect(view.agentBusy).toBe(false); expect(view.agentMode).toBe("voice");
    expect(getUserMedia).toHaveBeenCalledOnce(); expect(view.agentRecording).toBe(true); expect(view.agentVoiceReady).toBe(true);
    expect(capture.tracks).toHaveLength(1);
  });

  it.each(["text", "close", "settings", "readiness"] as const)("does not let a deferred text finisher reopen a withdrawn voice intent (%s)", async withdrawal => {
    plugin.settings.realtimeVoice.mode = "omni-e2e"; plugin.settings.realtimeVoice.speakReplies = false;
    captureFixture(); const [voice, text] = modeButtons(), gate = deferred<any>(), entered = deferred<void>();
    const logEntered = deferred<void>(), logGate = deferred<void>();
    vi.spyOn(plugin, "submitAgentMessageStream").mockImplementation(() => { entered.resolve(); return gate.promise; });
    view.appendAgentQualityLog.mockImplementationOnce(() => { logEntered.resolve(); return logGate.promise; });
    view.agentInput = "纯虚构待完成文字"; const request = view.sendAgentMessage("text"); await entered.promise;
    await voice.onclick(); gate.resolve({reply: "纯虚构文字回复", actions: []}); await logEntered.promise;
    if (withdrawal === "text") await text.onclick();
    else if (withdrawal === "close") await view.onClose();
    else { plugin.settings.realtimeVoice.dataDisclosureAccepted = false; if (withdrawal === "settings") view.invalidateVoiceSettings(); }
    logGate.resolve(); await request; await vi.advanceTimersByTimeAsync(3000);
    expect(getUserMedia).not.toHaveBeenCalled(); expect(view.agentRecording).toBe(false);
    expect(view.agentStream).toBeNull(); expect(view.agentRealtimeClient).toBeNull();
  });

  it("does not use an old text finisher to start capture or clear a newer request busy state", async () => {
    plugin.settings.realtimeVoice.mode = "omni-e2e"; plugin.settings.realtimeVoice.speakReplies = false;
    captureFixture(); const [voice] = modeButtons();
    const first = deferred<any>(), second = deferred<any>(), entered = deferred<void>(), logEntered = deferred<void>(), logGate = deferred<void>();
    vi.spyOn(plugin, "submitAgentMessageStream").mockImplementationOnce(() => { entered.resolve(); return first.promise; }).mockReturnValueOnce(second.promise);
    view.appendAgentQualityLog.mockImplementationOnce(() => { logEntered.resolve(); return logGate.promise; });
    view.agentInput = "纯虚构第一句"; const oldRequest = view.sendAgentMessage("text"); await entered.promise;
    await voice.onclick(); first.resolve({reply: "第一句完成", actions: []}); await logEntered.promise;
    view.agentInput = "纯虚构新一句"; const newRequest = view.sendAgentMessage("text"); expect(view.agentBusy).toBe(true);
    logGate.resolve(); await oldRequest;
    expect(view.agentBusy).toBe(true); expect(getUserMedia).not.toHaveBeenCalled();
    second.resolve({reply: "新一句完成", actions: []}); await newRequest; await vi.advanceTimersByTimeAsync(3000);
    expect(view.agentBusy).toBe(false); expect(getUserMedia).toHaveBeenCalledOnce(); expect(view.agentVoiceReady).toBe(true);
  });

  it("does not duplicate capture already started by a fresh original mode selection while text logging awaited", async () => {
    plugin.settings.realtimeVoice.mode = "omni-e2e"; plugin.settings.realtimeVoice.speakReplies = false;
    captureFixture(); const [voice, text] = modeButtons(), gate = deferred<any>(), entered = deferred<void>(), logEntered = deferred<void>(), logGate = deferred<void>();
    const ensure = vi.spyOn(view, "ensureVoiceStandby");
    vi.spyOn(plugin, "submitAgentMessageStream").mockImplementation(() => { entered.resolve(); return gate.promise; });
    view.appendAgentQualityLog.mockImplementationOnce(() => { logEntered.resolve(); return logGate.promise; });
    view.agentInput = "纯虚构文字"; const request = view.sendAgentMessage("text"); await entered.promise; await voice.onclick();
    gate.resolve({reply: "纯虚构回复", actions: []}); await logEntered.promise;
    await text.onclick(); await voice.onclick(); await ensure.mock.results.at(-1)!.value; await vi.advanceTimersByTimeAsync(3000);
    expect(getUserMedia).toHaveBeenCalledOnce(); expect(view.agentRecording).toBe(true);
    logGate.resolve(); await request; await vi.advanceTimersByTimeAsync(3000);
    expect(getUserMedia).toHaveBeenCalledOnce(); expect(view.agentVoiceReady).toBe(true);
  });

  it("does not restart a newer original voice startup still awaiting microphone acquisition when old text logging completes", async () => {
    plugin.settings.realtimeVoice.mode = "omni-e2e"; plugin.settings.realtimeVoice.speakReplies = false;
    const capture = captureFixture(), [voice, text] = modeButtons(), gate = deferred<any>(), entered = deferred<void>();
    const logEntered = deferred<void>(), logGate = deferred<void>(), microphoneGate = deferred<void>(), microphoneEntered = deferred<void>();
    const acquire = getUserMedia.getMockImplementation()!;
    getUserMedia.mockImplementation(async (...args: any[]) => { microphoneEntered.resolve(); await microphoneGate.promise; return Reflect.apply(acquire, undefined, args); });
    const ensure = vi.spyOn(view, "ensureVoiceStandby");
    vi.spyOn(plugin, "submitAgentMessageStream").mockImplementation(() => { entered.resolve(); return gate.promise; });
    view.appendAgentQualityLog.mockImplementationOnce(() => { logEntered.resolve(); return logGate.promise; });
    view.agentInput = "纯虚构待完成文字"; const request = view.sendAgentMessage("text"); await entered.promise; await voice.onclick();
    gate.resolve({reply: "纯虚构回复", actions: []}); await logEntered.promise;
    await text.onclick(); await voice.onclick(); await microphoneEntered.promise;
    const generation = view.agentRealtimeStartGeneration;
    expect(view.agentRecording).toBe(false); expect(getUserMedia).toHaveBeenCalledOnce();
    try {
      logGate.resolve(); await vi.advanceTimersByTimeAsync(0);
      expect(getUserMedia).toHaveBeenCalledOnce(); expect(view.agentRealtimeStartGeneration).toBe(generation);
    } finally {
      logGate.resolve(); microphoneGate.resolve();
      await Promise.all([request, ...ensure.mock.results.filter(row => row.type === "return").map(row => row.value)]);
    }
    await vi.advanceTimersByTimeAsync(3000);
    expect(getUserMedia).toHaveBeenCalledOnce(); expect(capture.tracks).toHaveLength(1);
    expect(view.agentRecording).toBe(true); expect(view.agentVoiceReady).toBe(true);
  });

  it("restarts after three silent voice/text cycles and keeps Main text usable after each stop", async () => {
    plugin.settings.realtimeVoice.mode = "omni-e2e";
    plugin.settings.realtimeVoice.speakReplies = true;
    await plugin.saveSettings();
    const capture = captureFixture(), [voice, text] = modeButtons();
    const ensure = vi.spyOn(view, "ensureVoiceStandby");
    view.agentInput = "纯虚构保留草稿";

    for (let round = 0; round < 3; round++) {
      await voice.onclick(); await ensure.mock.results.at(-1)!.value;
      await vi.advanceTimersByTimeAsync(3000);
      expect(view.agentRecording).toBe(true);
      expect(view.agentVoiceReady).toBe(true);
      expect(view.agentVoiceRuntime.snapshot().sessionPhase).toBe("listening");
      expect(view.agentReply).toContain("语音常驻监听中");
      await vi.advanceTimersByTimeAsync(20_000);
      await text.onclick(); await Promise.resolve();
      expect(view.agentMode).toBe("text");
      expect(view.agentRecording).toBe(false);
      expect(view.agentStream).toBeNull();
      expect(view.agentRealtimeClient).toBeNull();
      expect(view.agentVoiceRuntime.snapshot().sessionPhase).toBe("stopped");
      expect(view.agentInput).toBe("纯虚构保留草稿");
      expect((await submitOrdinaryText()).reply).toBe("纯虚构文字入口正常回应");
    }

    expect(capture.connects).toHaveBeenCalledTimes(3);
    expect(getUserMedia).toHaveBeenCalledTimes(3);
    expect(capture.tracks.every(track => track.readyState === "ended")).toBe(true);
    expect(capture.contexts.every(context => context.state === "closed")).toBe(true);
    expect(transport.fetch).not.toHaveBeenCalled();
    expect(transport.socket).not.toHaveBeenCalled();
  });

  it("keeps the new voice pipeline when an old microphone grant arrives after switching back", async () => {
    plugin.settings.realtimeVoice.mode = "omni-e2e";
    plugin.settings.realtimeVoice.speakReplies = true;
    await plugin.saveSettings();
    const capture = captureFixture(), late = deferred<MediaStream>(), oldStop = vi.fn();
    getUserMedia.mockImplementationOnce(() => late.promise);
    const [voice, text] = modeButtons(), ensure = vi.spyOn(view, "ensureVoiceStandby");
    await voice.onclick(); const first = ensure.mock.results[0].value;
    await text.onclick(); await voice.onclick(); const second = ensure.mock.results[1].value;
    await second; await vi.advanceTimersByTimeAsync(3000);
    const current = view.agentRealtimeClient;
    late.resolve({ getTracks: () => [{ stop: oldStop }] } as unknown as MediaStream);
    await first;

    expect(oldStop).toHaveBeenCalledOnce();
    expect(view.agentRealtimeClient).toBe(current);
    expect(view.agentRecording).toBe(true);
    expect(view.agentVoiceReady).toBe(true);
    expect(view.agentVoiceRuntime.snapshot().sessionPhase).toBe("listening");
    expect(capture.connects).toHaveBeenCalledOnce();
    await text.onclick();
    expect((await submitOrdinaryText()).reply).toBe("纯虚构文字入口正常回应");
    expect(capture.tracks.every(track => track.readyState === "ended")).toBe(true);
    expect(capture.contexts.every(context => context.state === "closed")).toBe(true);
    expect(transport.fetch).not.toHaveBeenCalled();
    expect(transport.socket).not.toHaveBeenCalled();
  });
});

describe("saving voice-critical settings stops the production session", () => {
  const changes: Array<[string, (value: LifeOpsSettings) => void]> = [
    ["realtime disabled", value => { value.realtimeVoice.provider = "off"; }],
    ["audio permission revoked", value => { value.realtimeVoice.dataDisclosureAccepted = false; }],
    ["credential storage revoked", value => { value.privacy!.plaintextCredentialStorageAccepted = false; }],
    ["realtime storage revoked", value => { value.realtimeVoice.plaintextCredentialStorageAccepted = false; }],
    ["text provider disabled", value => { value.ai.provider = "off"; }],
    ["text permission revoked", value => { value.ai.dataDisclosureAccepted = false; }],
    ["text model changed", value => { value.ai.model = "another-model"; }],
    ["fallback text provider changed", value => { value.ai.fallbackProvider = "deepseek"; }],
    ["voice key changed", value => { value.realtimeVoice.apiKey = "another-synthetic-key"; }],
    ["voice endpoint changed", value => { value.realtimeVoice.endpoint = "wss://another.synthetic.invalid/"; }],
    ["voice model changed", value => { value.realtimeVoice.model = "another-model"; }],
    ["voice mode changed", value => { value.realtimeVoice.mode = "omni-e2e"; }],
    ["TTS model changed", value => { value.realtimeVoice.ttsModel = "another-tts"; }],
    ["Breeze Python changed", value => { value.realtimeVoice.breeze!.python = "/fictional/new-python"; }],
    ["Breeze reference changed", value => { value.realtimeVoice.breeze!.referenceAudio = "/fictional/new-reference.wav"; }],
    ["recording permission changed", value => { value.voice.dataDisclosureAccepted = true; }],
    ["excluded sources changed", value => { value.privacy!.excludedVaultPrefixes = ["private"]; }],
  ];
  it.each(changes)("stops immediately before settings persistence when %s", async (_name, change) => {
    const runtime = view.agentVoiceRuntime;
    runtime.connect(); runtime.connected();
    const turn = runtime.beginTurn({ route: "brain", transcript: "合成在途问题" });
    runtime.transitionTurn("routing", "synthetic");
    runtime.transitionTurn("generating", "synthetic");
    const stop = vi.fn(), close = vi.fn(), cancel = vi.fn(), disconnect = vi.fn();
    view.agentMode = "voice"; view.agentRecording = true; view.agentVoiceConversation = true; view.agentBusy = true;
    view.agentStream = { getTracks: () => [{ stop }] };
    view.agentRealtimeClient = { close, cancelResponse: cancel };
    view.agentAudioProcessor = { onaudioprocess: vi.fn(), disconnect };
    view.agentTtsClient = { cancel };
    view.agentAudioContext = { close: vi.fn(async () => {}) };
    view.agentInput = "保留的草稿";
    const messages = [{ role: "user", content: "保留的历史" }]; view.agentMessages = messages;
    const forbidden = vi.fn();
    for (const key of ["agentVoiceResponseTimer", "agentVoiceFallbackTimer", "agentVoiceReconnectTimer", "agentVoiceAutoSendTimer", "agentVoiceWarmupTimer", "agentVoiceLocalEndpointTimer", "agentVoiceNoTranscriptTimer"]) {
      view[key] = setTimeout(forbidden, 100);
    }
    const saved = deferred<void>(); plugin.saveData = vi.fn(() => saved.promise);
    change(plugin.settings);
    const pending = plugin.saveSettings();
    expect(stop).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce(); expect(cancel).toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(turn.abortController.signal.aborted).toBe(true);
    expect(runtime.snapshot().sessionPhase).toBe("stopped");
    expect(view.agentRecording).toBe(false); expect(view.agentVoiceConversation).toBe(false); expect(view.agentBusy).toBe(false);
    expect(view.agentMode).toBe("text"); expect(view.agentInput).toBe("保留的草稿"); expect(view.agentMessages).toBe(messages);
    vi.advanceTimersByTime(1000); expect(forbidden).not.toHaveBeenCalled();
    saved.resolve(); await pending;
    expect(getUserMedia).not.toHaveBeenCalled(); expect(transport.socket).not.toHaveBeenCalled();
  });

  it("keeps ordinary UI/threshold/reply-mode edits from restarting or stopping the session", async () => {
    const invalidated = vi.spyOn(view, "invalidateVoiceSettings");
    view.agentMode = "voice"; view.agentRecording = true;
    const before = voiceSettingsRevision(plugin.settings);
    plugin.settings.ai.confidenceThreshold = 0.9;
    plugin.settings.realtimeVoice.speakReplies = false;
    plugin.settings.realtimeVoice.triggerEnabled = true;
    expect(voiceSettingsRevision(plugin.settings)).toBe(before);
    await plugin.saveSettings();
    expect(invalidated).not.toHaveBeenCalled();
    expect(view.agentRecording).toBe(true);
  });

  it("stays stopped even if saving the revoked settings fails", async () => {
    view.agentMode = "voice"; view.agentVoiceConversation = true;
    plugin.saveData = vi.fn(async () => { throw new Error("synthetic disk failure"); });
    plugin.settings.realtimeVoice.provider = "off";
    await expect(plugin.saveSettings()).rejects.toThrow("synthetic disk failure");
    expect(view.agentMode).toBe("text"); expect(view.agentVoiceConversation).toBe(false);
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it.each(["qwen", "fallback"])("discards a late microphone grant in %s startup", async kind => {
    view.agentMode = "voice";
    const media = deferred<MediaStream>(); getUserMedia.mockImplementation(() => media.promise);
    const pending = kind === "qwen" ? startBailianRealtimeRecording(view) : view.startFallbackAgentRecording();
    expect(getUserMedia).toHaveBeenCalledOnce();
    plugin.settings.realtimeVoice.provider = "off"; await plugin.saveSettings();
    const stop = vi.fn(); media.resolve({ getTracks: () => [{ stop }] } as unknown as MediaStream);
    await pending;
    expect(stop).toHaveBeenCalledOnce(); expect(transport.socket).not.toHaveBeenCalled();
    expect(view.agentStream).toBeNull(); expect(view.agentRecording).toBe(false);
    expect(view.agentVoiceRuntime.snapshot().sessionPhase).toBe("stopped");
  });

  it.each(["qwen", "fallback"])("switching to text cancels pending %s microphone startup", async kind => {
    view.agentMode = "voice"; view.agentVoiceConversation = true; view.agentInput = "保留的草稿";
    const media = deferred<MediaStream>(); getUserMedia.mockImplementation(() => media.promise);
    const context = vi.spyOn(plugin, "buildVoiceSessionContextBlock");
    const pending = kind === "qwen" ? startBailianRealtimeRecording(view) : view.startFallbackAgentRecording();
    expect(view.agentRecording).toBe(false);
    view.agentMode = "text"; view.stopVoiceStandby();
    const stop = vi.fn(); media.resolve({ getTracks: () => [{ stop }] } as unknown as MediaStream);
    await pending;
    expect(stop).toHaveBeenCalledOnce(); expect(context).not.toHaveBeenCalled(); expect(transport.socket).not.toHaveBeenCalled();
    expect(view.agentStream).toBeNull(); expect(view.agentRecording).toBe(false); expect(view.agentVoiceConversation).toBe(false);
    expect(view.agentVoiceRuntime.snapshot().sessionPhase).toBe("stopped"); expect(view.agentInput).toBe("保留的草稿");
  });


  it("does not restart after text mode stops a replacement connection before its first await returns", async () => {
    view.agentMode = "voice";
    const close = vi.fn(); view.agentRealtimeClient = { close, cancelResponse: vi.fn() };
    const pending = startBailianRealtimeRecording(view);
    view.agentMode = "text"; view.stopVoiceStandby();
    await pending;
    expect(close).toHaveBeenCalledOnce(); expect(getUserMedia).not.toHaveBeenCalled(); expect(transport.socket).not.toHaveBeenCalled();
    expect(view.agentVoiceRuntime.snapshot().sessionPhase).toBe("stopped");
  });



  it("detaches fallback stop/data callbacks and ignores an already-started late transcription", async () => {
    plugin.settings.realtimeVoice.provider = "browser-live";
    await plugin.saveSettings(); view.agentMode = "voice";
    const stop = vi.fn(); getUserMedia.mockResolvedValue({ getTracks: () => [{ stop }] });
    await view.startFallbackAgentRecording();
    const recorder = view.agentRecorder, lateData = recorder.ondataavailable, lateStop = recorder.onstop;
    const transcript = deferred<string>(); plugin.transcribeAgentAudio = vi.fn(() => transcript.promise);
    lateData({ data: new Blob(["synthetic audio"]) });
    view.stopAgentRecording(false);
    await Promise.resolve();
    expect(plugin.transcribeAgentAudio).toHaveBeenCalledOnce();
    const input = view.agentInput;
    plugin.settings.voice.provider = "openai-compatible"; await plugin.saveSettings();
    const stoppedMessage = view.agentReply;
    transcript.resolve("迟到转写不得进入输入框"); await Promise.resolve(); await Promise.resolve();
    lateData({ data: new Blob(["late"]) }); lateStop();
    expect(view.agentInput).toBe(input); expect(view.agentReply).toBe(stoppedMessage);
    expect(view.agentAudioChunks).toEqual([]); expect(view.agentBusy).toBe(false);
    expect(plugin.transcribeAgentAudio).toHaveBeenCalledOnce(); expect(stop).toHaveBeenCalledOnce();
  });

  it("silently discards buffered fallback audio when settings change before recorder stop", async () => {
    plugin.settings.realtimeVoice.provider = "browser-live"; await plugin.saveSettings(); view.agentMode = "voice";
    const stop = vi.fn(); getUserMedia.mockResolvedValue({ getTracks: () => [{ stop }] });
    await view.startFallbackAgentRecording();
    const recorder = view.agentRecorder, lateStop = recorder.onstop;
    recorder.ondataavailable({ data: new Blob(["buffered synthetic audio"]) });
    const transcribe = vi.spyOn(plugin, "transcribeAgentAudio");
    plugin.settings.voice.dataDisclosureAccepted = true; await plugin.saveSettings();
    expect(recorder.state).toBe("inactive"); expect(recorder.onstop).toBeNull(); expect(recorder.ondataavailable).toBeNull();
    lateStop(); await Promise.resolve();
    expect(transcribe).not.toHaveBeenCalled(); expect(view.agentAudioChunks).toEqual([]); expect(stop).toHaveBeenCalledOnce();
  });

  it.each([false, true])("guards completed E2E persistence without reviving the session (cancel=%s)", async cancel => {
    plugin.settings.realtimeVoice.mode = "omni-e2e"; plugin.settings.realtimeVoice.speakReplies = false;
    await plugin.saveSettings();
    view.agentMode = "voice"; view.agentRecording = true; view.agentVoiceConversation = true;
    const runtime = view.agentVoiceRuntime; runtime.connect(); runtime.connected();
    runtime.beginTurn({ route: "e2e", transcript: "合成闲聊" }); runtime.transitionTurn("routing", "synthetic"); runtime.transitionTurn("generating", "synthetic");
    view.agentMessages = [{ role: "assistant", content: "" }]; view.agentOmniE2eAssistantIndex = 0; view.agentOmniE2eUserMessage = "合成闲聊";
    const queued = vi.spyOn(view, "consumeQueuedVoiceInput"), reschedule = vi.spyOn(view, "scheduleVoiceAutoSend");
    const store = plugin.store, begun = deferred<void>(), release = deferred<void>();
    const ensureFolder = store.ensureFolder.bind(store);
    vi.spyOn(store, "ensureFolder").mockImplementation(async (...args: unknown[]) => {
      const path = String(args[0]);
      if (path.endsWith("/Conversations")) { begun.resolve(); await release.promise; }
      return ensureFolder(path);
    });
    const pending = finishOmniE2eVoiceTurn(view, "合成已完成回复");
    await begun.promise;
    expect(runtime.snapshot().currentTurn.phase).toBe("completed");
    if (cancel) { plugin.settings.realtimeVoice.dataDisclosureAccepted = false; await plugin.saveSettings(); }
    const stoppedMessage = view.agentReply;
    release.resolve(); await pending;
    const paths = vault.getMarkdownFiles().filter(file => file.path.includes("/Conversations/"));
    expect(paths).toHaveLength(cancel ? 0 : 1);
    expect(queued).not.toHaveBeenCalled(); expect(reschedule).not.toHaveBeenCalled();
    if (cancel) {
      expect(runtime.snapshot().sessionPhase).toBe("stopped"); expect(view.agentReply).toBe(stoppedMessage);
      expect(view.appendAgentQualityLog).not.toHaveBeenCalled();
      expect(await store.readPath(store.path(store.settings.folders.aiReports, "Memory", "conversation-memory.jsonl"))).toBe("");
    } else {
      expect(await vault.read(paths[0])).toContain("合成已完成回复");
      expect(view.appendAgentQualityLog).toHaveBeenCalledOnce();
      expect(runtime.snapshot().sessionPhase).toBe("listening");
    }
  });

  it("invalidates old realtime and system speech callbacks after settings change", async () => {
    view.agentMode = "voice";
    const generation = view.agentRealtimeStartGeneration;
    const onTranscript = vi.fn(), onToolCall = vi.fn();
    const callbacks = guardRealtimeCallbacks({ onTranscriptDone: onTranscript, onToolCall }, () => view.agentRealtimeStartGeneration === generation);
    view.speakAgentReplyWithSystem("合成朗读");
    const utterance = utterances[0];
    plugin.settings.realtimeVoice.model = "another-model"; await plugin.saveSettings();
    const stoppedMessage = view.agentReply;
    callbacks.onTranscriptDone?.("迟到转写"); await callbacks.onToolCall?.({ name: "create_task", arguments: {}, id: "late" });
    utterance.onstart?.(); utterance.onend?.(); utterance.onerror?.(); vi.advanceTimersByTime(5000);
    expect(onTranscript).not.toHaveBeenCalled(); expect(onToolCall).not.toHaveBeenCalled();
    expect(view.agentSpeaking).toBe(false); expect(view.agentReply).toBe(stoppedMessage);
  });

  it("suppresses late runtime system-speech callbacks without waking the stopped turn", async () => {
    view.agentMode = "voice";
    const runtime = view.agentVoiceRuntime; runtime.connect(); runtime.connected();
    runtime.beginTurn({ route: "brain", transcript: "合成问题" }); runtime.transitionTurn("routing", "synthetic"); runtime.transitionTurn("generating", "synthetic");
    startSystemSpeechForActiveTurn(view, "合成回复", "synthetic");
    const utterance = utterances[0];
    plugin.settings.ai.dataDisclosureAccepted = false; await plugin.saveSettings();
    const stoppedMessage = view.agentReply;
    utterance.onstart?.(); utterance.onend?.(); vi.advanceTimersByTime(5000);
    expect(runtime.snapshot().sessionPhase).toBe("stopped"); expect(view.agentSpeaking).toBe(false);
    expect(view.agentReply).toBe(stoppedMessage);
  });

  it("aborts a real production request and blocks its late reply, actions and conversation writes", async () => {
    const response = deferred<Response>(), started = deferred<void>(); let signal: AbortSignal | undefined;
    transport.fetch.mockImplementation((_url: string, init: RequestInit) => { signal = init.signal ?? undefined; started.resolve(); return response.promise; });
    const delivered = vi.fn(), execute = vi.spyOn(plugin, "executeToolCalls"), remembered = vi.spyOn(plugin, "recordConversationMemory");
    const appended = vi.spyOn(LifeOpsStore.prototype as any, "appendAgentConversation");
    const pending = plugin.submitAgentMessageStream("你记得我的沟通偏好吗？请深入分析。", [], delivered, { source: "voice" });
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await started.promise;
    plugin.settings.ai.model = "synthetic-new-model"; await plugin.saveSettings();
    expect(signal?.aborted).toBe(true);
    response.resolve(streamResponse("迟到的旧模型回复")); await rejected;
    expect(delivered).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
    expect(appended).not.toHaveBeenCalled(); expect(remembered).not.toHaveBeenCalled();
    expect(plugin.activeVoiceRequests.size).toBe(0);
    // An explicit new request can use the new configuration; cancellation is not a permanent lock.
    transport.fetch.mockResolvedValue(streamResponse("新的合成回答"));
    const fresh = await plugin.submitAgentMessageStream("你记得我的沟通偏好吗？请深入分析。", [], delivered, { source: "voice", selfTest: true });
    expect(fresh.reply).toBe("新的合成回答"); expect(delivered).toHaveBeenCalled();
  });
});

describe("recorded audio cancellation reaches the production transport", () => {
  beforeEach(async () => {
    plugin.settings.voice = {
      ...plugin.settings.voice, provider: "openai-compatible", endpoint: "https://voice.synthetic.invalid/transcribe",
      model: "synthetic-asr", apiKey: "synthetic-voice-key", dataDisclosureAccepted: true
    };
    await plugin.saveSettings();
  });

  it.each(["authorization", "provider"])("does not upload audio when %s changes during the egress audit", async change => {
    const entered = deferred<void>(), release = deferred<void>();
    setProviderEgressSink(async () => { entered.resolve(); await release.promise; });
    const pending = plugin.transcribeAgentAudio(new Blob(["synthetic audio"]));
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await entered.promise;
    if (change === "authorization") plugin.settings.voice.dataDisclosureAccepted = false;
    else plugin.settings.voice.provider = "off";
    await plugin.saveSettings();
    release.resolve(); await rejected;
    expect(transport.fetch).not.toHaveBeenCalled(); expect(plugin.activeVoiceRequests.size).toBe(0);
  });

  it("aborts an in-flight upload and rejects a transport that still returns a late response", async () => {
    const entered = deferred<void>(), response = deferred<Response>(); let signal: AbortSignal | undefined;
    transport.fetch.mockImplementation((_url: string, init: RequestInit) => {
      signal = init.signal ?? undefined; entered.resolve(); return response.promise;
    });
    const pending = plugin.transcribeAgentAudio(new Blob(["synthetic audio"]));
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await entered.promise;
    plugin.settings.voice.dataDisclosureAccepted = false; await plugin.saveSettings();
    expect(signal?.aborted).toBe(true);
    response.resolve(new Response(JSON.stringify({ text: "迟到转写" }))); await rejected;
    expect(plugin.activeVoiceRequests.size).toBe(0);
  });

  it("switching to text cancels a view transcription before its upload starts", async () => {
    const entered = deferred<void>(), release = deferred<void>();
    setProviderEgressSink(async () => { entered.resolve(); await release.promise; });
    view.agentMode = "voice"; view.agentInput = "保留的草稿";
    view.agentAudioChunks = [new Blob(["synthetic audio"])];
    const pending = view.finishAgentRecording("audio/webm");
    await entered.promise;
    view.agentMode = "text"; view.stopVoiceStandby();
    expect(view.agentBusy).toBe(false);
    release.resolve(); await pending;
    expect(transport.fetch).not.toHaveBeenCalled(); expect(plugin.activeVoiceRequests.size).toBe(0);
    expect(view.agentInput).toBe("保留的草稿"); expect(view.agentTranscriptionAbortController).toBeNull();
  });

  it("switching to text clears transcription busy state while its initial render is pending", async () => {
    const entered = deferred<void>(), release = deferred<void>();
    view.render.mockImplementationOnce(() => { entered.resolve(); return release.promise; });
    view.agentMode = "voice"; view.agentAudioChunks = [new Blob(["synthetic audio"])];
    const transcribe = vi.spyOn(plugin, "transcribeAgentAudio");
    const pending = view.finishAgentRecording("audio/webm");
    await entered.promise;
    view.agentMode = "text"; view.stopVoiceStandby();
    expect(view.agentBusy).toBe(false);
    release.resolve(); await pending;
    expect(transcribe).not.toHaveBeenCalled(); expect(transport.fetch).not.toHaveBeenCalled();
    expect(view.agentTranscriptionAbortController).toBeNull();
  });

  it("rejects cancellation during response parsing without publishing the late transcript", async () => {
    const entered = deferred<void>(), body = deferred<{ text: string }>();
    transport.fetch.mockResolvedValue({ ok: true, json: () => { entered.resolve(); return body.promise; } });
    const cancellation = new AbortController();
    const pending = plugin.transcribeAgentAudio(new Blob(["synthetic audio"]), cancellation.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await entered.promise; cancellation.abort(); body.resolve({ text: "迟到转写" }); await rejected;
    expect(plugin.activeVoiceRequests.size).toBe(0);
  });

  it("keeps successful transcription compatible and surfaces genuine provider and transport failures", async () => {
    transport.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ text: " 合成正常转写 " })));
    await expect(plugin.transcribeAgentAudio(new Blob(["synthetic audio"]))).resolves.toBe("合成正常转写");
    transport.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "synthetic provider failure" } }), { status: 502 }));
    await expect(plugin.transcribeAgentAudio(new Blob(["synthetic audio"]))).rejects.toMatchObject({ code: "http", providerRun: { status: "failed" } });
    const failure = new Error("synthetic transport failure"); transport.fetch.mockRejectedValueOnce(failure);
    await expect(plugin.transcribeAgentAudio(new Blob(["synthetic audio"]))).rejects.toMatchObject({ code: "network", providerRun: { status: "failed" } });
    expect(plugin.activeVoiceRequests.size).toBe(0);
  });
});
