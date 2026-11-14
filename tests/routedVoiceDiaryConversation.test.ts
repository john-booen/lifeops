import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/defaults';
import { todayString } from '../src/date';
import { setProviderEgressSink } from '../src/privacy';
const wire = vi.hoisted(() => {
  const sockets: any[] = [], state: any = { http: undefined, ttsUsage: { characters: 12 } };
  class Socket {
    static OPEN = 1; static CLOSED = 3; readyState = 0; sent: any[] = []; handlers = new Map<string, Function[]>();
    constructor(readonly url: string) { sockets.push(this); queueMicrotask(() => { if (this.readyState === 0) this.emit('open'); }); }
    on(n: string, f: Function) { this.handlers.set(n, [...(this.handlers.get(n) ?? []), f]); return this; }
    prependListener(n: string, f: Function) { this.handlers.set(n, [f, ...(this.handlers.get(n) ?? [])]); return this; }
    off(n: string, f: Function) { this.handlers.set(n, (this.handlers.get(n) ?? []).filter((x) => x !== f)); return this; }
    emit(n: string, ...args: any[]) { if (n === 'open') this.readyState = 1; if (n === 'close') this.readyState = 3; for (const f of [...(this.handlers.get(n) ?? [])]) f(...args); }
    message(v: any) { this.emit('message', Buffer.from(JSON.stringify(v))); }
    send(raw: string) { const p = JSON.parse(raw); this.sent.push(p); if (p.type === 'session.update'&&!state.holdAck?.(this,p)) queueMicrotask(() => this.message({ type: 'session.updated', session: { ...p.session, model: new URL(this.url).searchParams.get('model') } }));
      if (p.type === 'input_text_buffer.commit') queueMicrotask(() => { const id = 'tts_' + sockets.indexOf(this); this.message({ type: 'response.audio.delta', response_id: id, delta: 'AQACAA==' }); this.message({ type: 'response.done', response: { id, status: 'completed', usage: state.ttsUsage } }); });
    }
    close() { if (this.readyState !== 3) this.emit('close', 1000, Buffer.alloc(0)); } terminate() { this.close(); }
  }
  const api: any = { App: class {}, Plugin: class { constructor(readonly app: any, readonly manifest: any) {} }, TFile: class {}, TFolder: class {}, WorkspaceLeaf: class {}, ItemView: class {}, Modal: class {}, PluginSettingTab: class {}, Setting: class {}, Platform: { isDesktopApp: false }, Notice: class {}, setIcon() {}, normalizePath: (p: string) => p.replace(/\\/g, '/').replace(/\/{2,}/g, '/'), requestUrl: (...args: any[]) => state.http(...args) };
  return { Socket, sockets, state, api };
});
vi.mock('ws', () => ({ default: wire.Socket }));
vi.mock('obsidian', () => wire.api);
const { default: LifeOpsPlugin } = await import('../src/main');
const { LifeOpsView } = await import('../src/lifeOpsView');
const { LifeOpsAi } = await import('../src/ai');
const { LifeOpsStore } = await import('../src/store');
const { DiskVault } = await import('./helpers/diskVault');
const endpoint = 'https://api.moonshot.cn/v1/chat/completions', model = 'kimi-k2.6', used = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 };
let dir: string, plugin: any, view: any, vault: any, store: any, http: any, fetchWire: any, tracks: any[], contexts: any[], settings: any, mainCompletion: Promise<any> | null;
const line = (v: any) => 'data: ' + JSON.stringify(v) + '\n\n'; let counter = 0;
function response(content = '纯虚构固定分析。') { return { status: 200, json: { id: 'finite_' + ++counter, model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: used } }; }
function streamReply(content = '纯虚构固定分析。') { const id = 'stream_' + ++counter; return new Response(line({ id, model, choices: [{ index: 0, delta: { content }, finish_reason: 'stop' }], usage: used }) + 'data: [DONE]\n\n'); }
beforeEach(async () => {
  plugin = view = store = undefined; mainCompletion = null;
  wire.api.Platform.isDesktopApp=false;
  wire.state.holdAck=undefined;
  vi.useRealTimers(); vi.stubGlobal('window', globalThis); tracks = []; contexts = []; counter = 0; wire.sockets.length = 0; wire.state.ttsUsage = { characters: 12 }; wire.state.holdDrain = false; wire.state.outputMessages = [];
  vi.stubGlobal('MediaRecorder', class {}); vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(async () => { const t = { readyState: 'live', stop() { this.readyState = 'ended'; } }; tracks.push(t); return { getTracks: () => [t] }; }) } });
  const node = () => ({ connect() {}, disconnect() {}, gain: { value: 1 }, onaudioprocess: null });
  vi.stubGlobal('AudioContext', class { state = 'running'; sampleRate = 16000; currentTime = 0; destination = {}; audioWorklet = { addModule: async () => {} }; constructor() { contexts.push(this); } createMediaStreamSource = node; createScriptProcessor = node; createGain = node; async close() { this.state = 'closed'; } async resume() { this.state = 'running'; } createBuffer(_n: number, length: number, rate: number) { return { duration: length / rate, getChannelData: () => new Float32Array(length) }; } createBufferSource() { return { ...node(), onended: null as Function | null, start() { queueMicrotask(() => this.onended?.()); }, stop() {} }; } });
  vi.stubGlobal('AudioWorkletNode', class { connect() {} disconnect() {} port = { onmessage: null as Function | null, close() {}, postMessage(p: any) { wire.state.outputMessages.push(p); if (['start', 'finish', 'cancel'].includes(p.type) && !(p.type === 'finish' && wire.state.holdDrain)) queueMicrotask(() => this.onmessage?.({ data: { type: p.type === 'start' ? 'started' : p.type === 'finish' ? 'drained' : 'cancelled', playbackId: p.playbackId } })); } }; });
  vi.stubGlobal('speechSynthesis', { speak: vi.fn(), cancel: vi.fn() });
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lifeops-main-shared-'))); fs.mkdirSync(path.join(dir, 'vault')); vault = new DiskVault(path.join(dir, 'vault')); const leaves: any[] = [], app: any = { vault, workspace: { getLeavesOfType: () => leaves } };
  settings = structuredClone(DEFAULT_SETTINGS); Object.assign(settings.ai, { provider: 'openai-compatible', endpoint, model, apiKey: 'fictional-only', dataDisclosureAccepted: true }); settings.privacy.plaintextCredentialStorageAccepted = true;
  Object.assign(settings.realtimeVoice, { mode: 'cascade', apiKey: 'fictional-only', cloudFallback: false, speakReplies: true, ttsEngine: "bailian", dataDisclosureAccepted: true, plaintextCredentialStorageAccepted: true });
  store = new LifeOpsStore(app, settings); await store.initializeVault();
  plugin = Object.assign(new LifeOpsPlugin(app, { id: 'lifeops-assistant' } as never), { store, settings, ai: new LifeOpsAi(settings), unloaded: false, lifecycleGeneration: 1, savedVoiceSettingsRevision: 'fixture', updateStatusBar: vi.fn(async () => {}), refreshViews: vi.fn(async () => {}), buildSemanticContext: vi.fn(async () => '') });
  view = new LifeOpsView({} as never, plugin); leaves.push({ view }); view.render = vi.fn(async () => {}); view.refreshAgentSurfaceState = vi.fn(); view.agentMode = 'voice'; view.agentVoiceConversation = true;
  http = vi.fn(async () => response()); wire.state.http = http; fetchWire = vi.fn(async () => streamReply()); vi.stubGlobal('fetch', fetchWire);

});
afterEach(async () => {
  view?.stopVoiceStandby(); if (view) await view.stopBailianRealtimeRecording(true); if (mainCompletion) await mainCompletion.catch(() => {}); await tick(200); setProviderEgressSink(null); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); if (dir) fs.rmSync(dir, { recursive: true, force: true });
});
async function tick(ms: number) { if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(ms); else await new Promise((r) => setTimeout(r, ms)); }
async function start() { await view.ensureVoiceStandby(); await vi.waitFor(() => expect(Boolean(view.agentRealtimeClient?.initialInstructions?.slot)).toBe(false)); await tick(3000); expect(view.agentVoiceRuntime.snapshot().sessionPhase).toBe('listening'); return { client: view.agentRealtimeClient, socket: wire.sockets[0] }; }
async function transcript(socket: any, text: string) {
  const item_id = 'asr_' + ++counter;
  socket.message({ type: 'input_audio_buffer.speech_started', item_id, audio_start_ms: 100 });
  socket.message({ type: 'input_audio_buffer.speech_stopped', item_id, audio_end_ms: 1400 });
  socket.message({ type: 'conversation.item.input_audio_transcription.completed', item_id, transcript: text });
}
it.each([true,false])("uses the text agent for ASR and saves a completed turn once (speech=%s)",async speech=>{
 settings.realtimeVoice.speakReplies=speech;
 const append=vi.spyOn(store,"appendAgentConversation");
 const content="这是一段纯虚构回复。";
 const {socket}=await start();
 fetchWire.mockImplementation(async()=>streamReply(content));
 http.mockImplementation(async()=>response(content));
 await transcript(socket,"请回复这句虚构的语音消息。");
 await vi.waitFor(()=>expect(view.agentVoiceRuntime.snapshot().currentTurn?.phase).toBe("completed"),{timeout:5000});
 expect(view.agentReply).toBe(content);
 expect(append).toHaveBeenCalledTimes(1);
 expect(socket.sent.some((packet:any)=>packet.type==="response.create")).toBe(false);
 const conversation=store.path(settings.folders.aiReports,"Conversations",todayString()+".md");
 await vi.waitFor(async () => expect((await vault.bytes(conversation)).split(content)).toHaveLength(2));
 if(speech) expect(wire.state.outputMessages.some((message:any)=>message.type==="finish")).toBe(true);
},15000);
