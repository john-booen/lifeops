import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanupAudioWorkletCapture, cleanupRealtimeAudio, floatTo16kPcm, lifeOpsAudioWorkletSource,
  startAudioWorkletCapture, startPcmAudioCapture
} from "../src/voice/voiceRealtime";

vi.mock("obsidian", () => ({ Notice: class {} }));

interface Processor { process(inputs: Float32Array[][]): boolean }
function worklet(code: string, rate: number, deliver?: (data: Float32Array) => void) {
  let Factory!: new () => Processor;
  const messages: Float32Array[] = [], transferred: ArrayBuffer[] = [];
  class Base {
    port = { postMessage(data: Float32Array, buffers: ArrayBuffer[]) {
      expect(buffers).toEqual([data.buffer]);
      transferred.push(buffers[0]);
      // Exercise actual transfer detachment, rather than a copying-only mock.
      const received = structuredClone(data, { transfer: buffers });
      messages.push(received); deliver?.(received);
    } };
  }
  runInNewContext(code, {
    sampleRate: rate, Float32Array, Math, AudioWorkletProcessor: Base,
    registerProcessor(name: string, ctor: new () => Processor) {
      expect(name).toBe("lifeops-pcm-capture"); Factory = ctor;
    }
  }, { timeout: 1_000 });
  return { processor: new Factory(), messages, transferred };
}
function feed(processor: Processor, input: Float32Array, quanta = [128]): void {
  let offset = 0, next = 0;
  while (offset < input.length) {
    const end = Math.min(input.length, offset + quanta[next++ % quanta.length]);
    expect(processor.process([[input.subarray(offset, end)]])).toBe(true);
    offset = end;
  }
}
function signal(length: number): Float32Array {
  return Float32Array.from({ length }, (_, i) => ((i * 73) % 1999 - 999) / 1250);
}
function flatten(messages: Float32Array[]): Float32Array {
  const result = new Float32Array(messages.reduce((n, row) => n + row.length, 0));
  let offset = 0; for (const row of messages) { result.set(row, offset); offset += row.length; }
  return result;
}
function pcmFor(messages: Float32Array[], rate: number): Int16Array {
  const chunks = messages.map(row => floatTo16kPcm(row, rate));
  const result = new Int16Array(chunks.reduce((n, row) => n + row.length, 0));
  let offset = 0; for (const row of chunks) { result.set(row, offset); offset += row.length; }
  return result;
}

it.each([48_000, 44_100, 16_000])("preserves a continuous%iHz second with25messages and16000 ordered PCM samples", rate => {
  const input = signal(rate), { processor, messages, transferred } = worklet(lifeOpsAudioWorkletSource(true), rate);
  feed(processor, input);
  expect(messages).toHaveLength(25);
  expect(messages.every(row => row.length === rate / 25)).toBe(true);
  expect(flatten(messages).findIndex((value, i) => value !== input[i])).toBe(-1);
  const pcm = pcmFor(messages, rate), expected = new Int16Array(16_000);
  for (let i = 0; i < expected.length; i++) {
    const sample = input[Math.floor(i * rate / 16_000)];
    expected[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  expect(pcm).toHaveLength(16_000);
  expect(pcm.findIndex((value, i) => value !== expected[i])).toBe(-1);
  expect(new Set(transferred).size).toBe(25);
  expect(transferred.every(buffer => buffer.byteLength === 0)).toBe(true);
});
it.each([48_000, 44_100, 16_000])("carries%iHz quantum remainders through irregular render blocks", rate => {
  const input = signal(rate * 2), { processor, messages } = worklet(lifeOpsAudioWorkletSource(true), rate);
  feed(processor, input, [128, 17, 256, 3, 1024, 65]);
  expect(messages).toHaveLength(50);
  expect(flatten(messages).length).toBe(input.length);
  expect(flatten(messages).findIndex((value, i) => value !== input[i])).toBe(-1);
  expect(pcmFor(messages, rate)).toHaveLength(32_000);
});
it("retains a partial batch without flushing empty quanta or mutating transferred buffers", () => {
  const { processor, messages, transferred } = worklet(lifeOpsAudioWorkletSource(true), 48_000);
  feed(processor, new Float32Array(1919).fill(0.25));
  expect(processor.process([])).toBe(true); expect(messages).toHaveLength(0);
  feed(processor, new Float32Array([0.25]));
  feed(processor, new Float32Array(1920).fill(0.75));
  expect(messages).toHaveLength(2);
  expect(messages[0].every(value => value === 0.25)).toBe(true);
  expect(messages[1].every(value => value === 0.75)).toBe(true);
  expect(transferred.every(buffer => buffer.byteLength === 0)).toBe(true);
});
it("keeps each node's partial batch out of another node's epoch", () => {
  const first = worklet(lifeOpsAudioWorkletSource(true), 48_000);
  const second = worklet(lifeOpsAudioWorkletSource(true), 48_000);
  feed(first.processor, new Float32Array(1919).fill(0.25));
  feed(second.processor, new Float32Array(1919).fill(0.75));
  expect(first.messages).toHaveLength(0); expect(second.messages).toHaveLength(0);
  feed(second.processor, new Float32Array([0.75]));
  expect(second.messages[0].every(value => value === 0.75)).toBe(true);
  expect(first.messages).toHaveLength(0);
});
it.each([48_000, 44_100, 16_000])("keeps legacy%iHz Worklet messages at the original128sample cadence", rate => {
  const { processor, messages } = worklet(lifeOpsAudioWorkletSource(), rate);
  const input = signal(128 * 5); feed(processor, input);
  expect(messages).toHaveLength(5); expect(messages.every(row => row.length === 128)).toBe(true);
  expect(flatten(messages).findIndex((value, i) => value !== input[i])).toBe(-1);
});
it("retains the original quantum behavior for an unsupported capture rate", () => {
  const { processor, messages } = worklet(lifeOpsAudioWorkletSource(true), 96_000);
  feed(processor, signal(128 * 3));
  expect(messages).toHaveLength(3); expect(messages.every(row => row.length === 128)).toBe(true);
});

const blobs = new Map<string, Blob>();
const setupErrors: string[] = [];
class FakeNode {
  readonly port: { onmessage: ((event: MessageEvent<Float32Array>) => void) | null } = { onmessage: null };
  readonly vm: ReturnType<typeof worklet>;
  readonly connect = vi.fn();
  readonly disconnect = vi.fn();
  constructor(context: { sampleRate: number; moduleSource: string }) {
    this.vm = worklet(context.moduleSource, context.sampleRate, data => this.port.onmessage?.({ data } as MessageEvent<Float32Array>));
  }
}
beforeEach(() => {
  blobs.clear();
  setupErrors.length = 0;
  vi.stubGlobal("window", {
    btoa: (text: string) => Buffer.from(text, "binary").toString("base64"),
    atob: (text: string) => Buffer.from(text, "base64").toString("binary")
  });
  vi.stubGlobal("AudioWorkletNode", FakeNode);
  vi.spyOn(URL, "createObjectURL").mockImplementation(blob => {
    const url = "blob:owned-capture-" + blobs.size; blobs.set(url, blob as Blob); return url;
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function capture(rate: number, omni = true, provider = "qwen-omni-realtime") {
  const client = { appendPcm16: vi.fn() }, generation = { current: true };
  const view: any = {
    controller: { settings: { realtimeVoice: { provider, mode: omni ? "omni-e2e" : "cascade" } } },
    agentVoiceReady: true, agentRecording: true, agentRealtimeClient: client,
    agentMode: "voice", agentAudioWorklet: null,
    agentVoiceLocalSpeechActive: true, clearVoiceLocalEndpointTimer: vi.fn()
  };
  const context: any = {
    sampleRate: rate, moduleSource: "", destination: {},
    audioWorklet: { addModule: vi.fn(async (url: string) => {
      try { context.moduleSource = await blobs.get(url)!.text(); }
      catch (error) { setupErrors.push(String(error)); throw error; }
    }) },
    createGain: () => ({ gain: { value: 1 }, connect: vi.fn() })
  };
  const source: any = { connect: vi.fn() };
  expect(await startAudioWorkletCapture(view, context, source, client as any, () => generation.current), setupErrors.join("\n")).toBe(true);
  return { view, context, source, client, generation, node: view.agentAudioWorklet as FakeNode };
}
it.each([48_000, 44_100, 16_000])("sends all-silent%iHz audio through the original handler without waiting for speech", async rate => {
  const { node, client, view } = await capture(rate);
  feed(node.vm.processor, new Float32Array(rate));
  expect(client.appendPcm16).toHaveBeenCalledTimes(25);
  for (const [encoded] of client.appendPcm16.mock.calls) {
    const bytes = Buffer.from(encoded, "base64");
    expect(bytes.length).toBe(1280); expect(bytes.every(byte => byte === 0)).toBe(true);
  }
  expect(view.clearVoiceLocalEndpointTimer).not.toHaveBeenCalled();
});
it("keeps non-Qwen local VAD and original per-quantum resampling unchanged", async () => {
  const { node, client, view } = await capture(48_000, false, "off");
  feed(node.vm.processor, new Float32Array(128 * 4).fill(0.1));
  expect(client.appendPcm16).toHaveBeenCalledTimes(4);
  expect(client.appendPcm16.mock.calls.every(([text]) => Buffer.from(text, "base64").length === 42 * 2)).toBe(true);
  expect(view.clearVoiceLocalEndpointTimer).toHaveBeenCalledTimes(4);
});
it.each([48_000, 44_100, 16_000])("preserves a full cascade%iHz second as16000 ordered PCM samples in25packets", async rate => {
  const { node, client, view } = await capture(rate, false), input = signal(rate);
  feed(node.vm.processor, input);
  const rows = client.appendPcm16.mock.calls.map(([text]) => Buffer.from(text, "base64"));
  expect(rows).toHaveLength(25);
  expect(rows.every(row => row.length === 1280)).toBe(true);
  const joined = Buffer.concat(rows); expect(joined.length).toBe(32_000);
  for (let i = 0; i < 16_000; i++) {
    const sample = input[Math.floor(i * rate / 16_000)];
    const expected = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    expect(joined.readInt16LE(i * 2)).toBe(Math.trunc(expected));
  }
  expect(view.clearVoiceLocalEndpointTimer).toHaveBeenCalledTimes(25);
});
it("keeps unsupported Omni rates on the original handler and quantum cadence", async () => {
  const { node, client } = await capture(96_000);
  feed(node.vm.processor, new Float32Array(128).fill(0.1));
  expect(node.vm.messages).toHaveLength(1);
  expect(node.vm.messages[0]).toHaveLength(128);
  expect(client.appendPcm16).toHaveBeenCalledOnce();
  expect(Buffer.from(client.appendPcm16.mock.calls[0][0], "base64").length).toBe(21 * 2);
});
it("keeps the original ready, recording and client identity send guards", async () => {
  const { node, client, view } = await capture(48_000), handler = node.port.onmessage!;
  const event = { data: new Float32Array(1920) } as MessageEvent<Float32Array>;
  view.agentVoiceReady = false; handler(event);
  view.agentVoiceReady = true; view.agentRecording = false; handler(event);
  view.agentRecording = true; view.agentRealtimeClient = {}; handler(event);
  expect(client.appendPcm16).not.toHaveBeenCalled();
  view.agentRealtimeClient = client; handler(event); expect(client.appendPcm16).toHaveBeenCalledOnce();
});
it.each([true, false])("rejects stopped, replaced and expired-generation Qwen callbacks withOmni=%s", async omni => {
  const { node, client, view, context, source, generation } = await capture(48_000, omni);
  feed(node.vm.processor, new Float32Array(1919).fill(0.25));
  const oldHandler = node.port.onmessage!;
  cleanupAudioWorkletCapture(view);
  expect(node.port.onmessage).toBeNull(); expect(node.disconnect).toHaveBeenCalledOnce();
  expect(await startAudioWorkletCapture(view, context, source, client as any, () => generation.current)).toBe(true);
  const current = view.agentAudioWorklet as FakeNode;
  feed(current.vm.processor, new Float32Array(1919).fill(0.75));
  expect(client.appendPcm16).not.toHaveBeenCalled();
  oldHandler({ data: new Float32Array(1920).fill(0.25) } as MessageEvent<Float32Array>);
  expect(client.appendPcm16).not.toHaveBeenCalled();
  feed(current.vm.processor, new Float32Array([0.75])); expect(client.appendPcm16).toHaveBeenCalledOnce();
  generation.current = false; current.port.onmessage!({ data: new Float32Array(1920) } as MessageEvent<Float32Array>);
  expect(client.appendPcm16).toHaveBeenCalledOnce();
});

it.each([["off", 48_000], ["qwen-omni-realtime", 96_000]] as const)("rejects an old unbatched callback from %s at %i Hz", async (provider, rate) => {
  const { client, context, source, view, node } = await capture(rate, false, provider);
  const oldHandler = node.port.onmessage!;
  cleanupAudioWorkletCapture(view);
  expect(await startAudioWorkletCapture(view, context, source, client as any)).toBe(true);
  const current = view.agentAudioWorklet as FakeNode;
  const event = { data: new Float32Array(128).fill(0.25) } as MessageEvent<Float32Array>;
  oldHandler(event);
  expect(client.appendPcm16).not.toHaveBeenCalled();
  current.port.onmessage!(event);
  expect(client.appendPcm16).toHaveBeenCalledOnce();
});

it("releases each module URL when an older capture expires while its module is loading", async () => {
  const { client, context, source, view } = await capture(48_000);
  const original = view.agentAudioWorklet;
  let finishOld: () => void = () => {};
  const pending = new Promise<void>(resolve => { finishOld = resolve; });
  context.audioWorklet.addModule.mockImplementationOnce(() => pending);
  let oldCurrent = true;
  const startOld = startAudioWorkletCapture(view, context, source, client as any, () => oldCurrent);
  expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
  oldCurrent = false;
  expect(await startAudioWorkletCapture(view, context, source, client as any)).toBe(true);
  const replacement = view.agentAudioWorklet;
  expect(replacement).not.toBe(original);
  finishOld();
  expect(await startOld).toBe(false);
  expect(view.agentAudioWorklet).toBe(replacement);
  expect(URL.revokeObjectURL).toHaveBeenNthCalledWith(2, "blob:owned-capture-2");
  expect(URL.revokeObjectURL).toHaveBeenNthCalledWith(3, "blob:owned-capture-1");
});

function captureFactory(omni = true, firstError?: Error | DOMException | (Error | DOMException | undefined)[], provider = "qwen-omni-realtime") {
  const attempts: unknown[][] = [], contexts: any[] = [];
  class Factory {
    constructor(...args: [AudioContextOptions?]) {
      attempts.push(args);
      const failure = Array.isArray(firstError) ? firstError[attempts.length - 1] : attempts.length === 1 ? firstError : undefined;
      if (failure) throw failure;
      const context: any = {
        sampleRate: args[0]?.sampleRate ?? 48_000,
        state: "suspended", moduleSource: "", destination: {},
        resume: vi.fn(async () => { context.state = "running"; }),
        close: vi.fn(async () => { context.state = "closed"; }),
        createMediaStreamSource: vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() })),
        audioWorklet: { addModule: vi.fn(async (url: string) => { context.moduleSource = await blobs.get(url)!.text(); }) },
        createGain: () => ({ gain: { value: 1 }, connect: vi.fn() })
      };
      contexts.push(context);
      return context;
    }
  }
  window.AudioContext = Factory as unknown as typeof AudioContext;
  const client = { appendPcm16: vi.fn() }, view: any = {
    controller: { settings: { realtimeVoice: { provider, mode: omni ? "omni-e2e" : "cascade" } } },
    agentStream: {}, agentVoiceReady: true, agentRecording: true, agentRealtimeClient: client,
    agentMode: "voice", agentAudioWorklet: null,
    agentVoiceLocalSpeechActive: true, clearVoiceLocalEndpointTimer: vi.fn(), setVoiceCaptureMode: vi.fn()
  };
  return { attempts, contexts, client, view, Factory };
}
it("requests16k for Omni capture, then resumes and uses the original40ms Worklet path", async () => {
  const { attempts, contexts, client, view } = captureFactory();
  await startPcmAudioCapture(view, client as any);
  expect(attempts).toEqual([[{ sampleRate: 16_000 }]]);
  expect(contexts[0].resume).toHaveBeenCalledOnce();
  expect(contexts[0].createMediaStreamSource).toHaveBeenCalledWith(view.agentStream);
  expect(view.agentAudioContext).toBe(contexts[0]);
  expect(view.setVoiceCaptureMode).toHaveBeenCalledWith("audio-worklet");
  feed((view.agentAudioWorklet as FakeNode).vm.processor, new Float32Array(16_000));
  expect(client.appendPcm16).toHaveBeenCalledTimes(25);
  expect(client.appendPcm16.mock.calls.reduce((n, [text]) => n + Buffer.from(text, "base64").length / 2, 0)).toBe(16_000);
});
it("keeps non-Qwen capture AudioContext construction at the original zero arguments", async () => {
  const { attempts, contexts, view, client } = captureFactory(false, undefined, "off");
  await startPcmAudioCapture(view, client as any);
  expect(attempts).toEqual([[]]);
  expect(contexts[0].sampleRate).toBe(48_000);
  expect(contexts[0].resume).toHaveBeenCalledOnce();
});
it("requests16k for daily cascade and preserves the continuous input duration", async () => {
  const { attempts, contexts, view, client } = captureFactory(false);
  await startPcmAudioCapture(view, client as any);
  expect(attempts).toEqual([[{ sampleRate: 16_000 }]]);
  expect(contexts[0].resume).toHaveBeenCalledOnce();
  feed((view.agentAudioWorklet as FakeNode).vm.processor, signal(16_000));
  expect(client.appendPcm16).toHaveBeenCalledTimes(25);
  expect(client.appendPcm16.mock.calls.reduce((n, [text]) => n + Buffer.from(text, "base64").length / 2, 0)).toBe(16_000);
});
it("preserves cascade duration when16k is unsupported and the original48k fallback is used", async () => {
  const { attempts, contexts, view, client } = captureFactory(false, new DOMException("rate unavailable", "NotSupportedError"));
  await startPcmAudioCapture(view, client as any);
  expect(attempts).toEqual([[{ sampleRate: 16_000 }], []]);
  expect(contexts[0].sampleRate).toBe(48_000);
  feed((view.agentAudioWorklet as FakeNode).vm.processor, signal(48_000));
  expect(client.appendPcm16).toHaveBeenCalledTimes(25);
  expect(Buffer.concat(client.appendPcm16.mock.calls.map(([text]) => Buffer.from(text, "base64"))).length).toBe(32_000);
});
it("falls back once to the original default context only for explicit NotSupportedError", async () => {
  const { attempts, contexts, view, client } = captureFactory(true, new DOMException("rate not supported", "NotSupportedError"));
  await startPcmAudioCapture(view, client as any);
  expect(attempts).toEqual([[{ sampleRate: 16_000 }], []]);
  expect(contexts).toHaveLength(1); expect(contexts[0].sampleRate).toBe(48_000);
  expect(contexts[0].resume).toHaveBeenCalledOnce();
});
it.each([new DOMException("capture denied", "SecurityError"), new Error("unexpected constructor failure")])("propagates other context constructor errors without retry or capture setup: %s", async error => {
  const { attempts, contexts, view, client } = captureFactory(true, error);
  await expect(startPcmAudioCapture(view, client as any)).rejects.toBe(error);
  expect(attempts).toEqual([[{ sampleRate: 16_000 }]]);
  expect(contexts).toHaveLength(0); expect(view.agentAudioWorklet).toBeNull();
  expect(view.setVoiceCaptureMode).not.toHaveBeenCalled();
});
it("closes a newly created Omni context when the original generation check is stale", async () => {
  const { attempts, contexts, view, client } = captureFactory();
  await startPcmAudioCapture(view, client as any, () => false);
  expect(attempts).toEqual([[{ sampleRate: 16_000 }]]);
  expect(contexts[0].resume).toHaveBeenCalledOnce(); expect(contexts[0].close).toHaveBeenCalledOnce();
  expect(contexts[0].createMediaStreamSource).not.toHaveBeenCalled();
  expect(contexts[0].audioWorklet.addModule).not.toHaveBeenCalled();
  expect(view.agentAudioWorklet).toBeNull(); expect(view.setVoiceCaptureMode).not.toHaveBeenCalled();
});

function silentSinkFactory(omni = true, failures?: Error | DOMException | (Error | DOMException | undefined)[], provider = "qwen-omni-realtime") {
  const fixture = captureFactory(omni, failures, provider);
  Object.defineProperty(fixture.Factory.prototype, "setSinkId", { value: vi.fn() });
  return fixture;
}
it("requests a silent16k sink for Omni and retains one context, graph and40ms PCM stream", async () => {
  const { attempts, contexts, view, client } = silentSinkFactory();
  const output = Object.freeze({ setSinkId: vi.fn() }); view.agentAudioOutput = output;
  await startPcmAudioCapture(view, client as any);
  expect(attempts).toEqual([[{ sampleRate: 16_000, sinkId: { type: "none" }, latencyHint: 0.04 }]]);
  expect(contexts).toHaveLength(1); expect(contexts[0].resume).toHaveBeenCalledOnce();
  expect(contexts[0].createMediaStreamSource).toHaveBeenCalledWith(view.agentStream);
  expect(view.agentAudioContext).toBe(contexts[0]); expect(view.agentAudioOutput).toBe(output);
  expect(output.setSinkId).not.toHaveBeenCalled();
  feed((view.agentAudioWorklet as FakeNode).vm.processor, new Float32Array(16_000));
  expect(client.appendPcm16).toHaveBeenCalledTimes(25);
  expect(client.appendPcm16.mock.calls.every(([text]) => Buffer.from(text, "base64").length === 1280)).toBe(true);
});
it.each([new TypeError("sink option unsupported"), new DOMException("silent sink unsupported", "NotSupportedError"), new Error("silent request failed")])("falls back from optional silent construction to the original16k request: %s", async error => {
  const { attempts, contexts, view, client } = silentSinkFactory(true, error);
  await startPcmAudioCapture(view, client as any);
  expect(attempts).toEqual([[{ sampleRate: 16_000, sinkId: { type: "none" }, latencyHint: 0.04 }], [{ sampleRate: 16_000 }]]);
  expect(contexts).toHaveLength(1); expect(contexts[0].sampleRate).toBe(16_000);
  expect(contexts[0].resume).toHaveBeenCalledOnce(); expect(view.agentAudioContext).toBe(contexts[0]);
});
it("uses zero-argument default only after the legacy16k request itself reports NotSupportedError", async () => {
  const { attempts, contexts, view, client } = silentSinkFactory(true, [new TypeError("silent unavailable"), new DOMException("16k unavailable", "NotSupportedError")]);
  await startPcmAudioCapture(view, client as any);
  expect(attempts).toEqual([[{ sampleRate: 16_000, sinkId: { type: "none" }, latencyHint: 0.04 }], [{ sampleRate: 16_000 }], []]);
  expect(contexts).toHaveLength(1); expect(contexts[0].sampleRate).toBe(48_000);
  feed((view.agentAudioWorklet as FakeNode).vm.processor, new Float32Array(48_000));
  expect(client.appendPcm16).toHaveBeenCalledTimes(25);
});
it.each([new DOMException("legacy capture denied", "SecurityError"), new Error("legacy constructor failure")])("keeps original16k failures visible after a silent request failed: %s", async legacyError => {
  const { attempts, contexts, view, client } = silentSinkFactory(true, [new TypeError("silent unavailable"), legacyError]);
  await expect(startPcmAudioCapture(view, client as any)).rejects.toBe(legacyError);
  expect(attempts).toHaveLength(2); expect(attempts[1]).toEqual([{ sampleRate: 16_000 }]);
  expect(contexts).toHaveLength(0); expect(view.agentAudioWorklet).toBeNull();
  expect(view.setVoiceCaptureMode).not.toHaveBeenCalled();
});
it("propagates default constructor failure without another retry or leaked returned context", async () => {
  const finalError = new Error("default failed");
  const { attempts, contexts, view, client } = silentSinkFactory(true, [new TypeError("silent unavailable"), new DOMException("16k unavailable", "NotSupportedError"), finalError]);
  await expect(startPcmAudioCapture(view, client as any)).rejects.toBe(finalError);
  expect(attempts).toHaveLength(3); expect(attempts[2]).toEqual([]); expect(contexts).toHaveLength(0);
});
it("keeps non-Qwen zero-argument construction even when silent sink support is advertised", async () => {
  const { attempts, contexts, view, client } = silentSinkFactory(false, undefined, "off");
  await startPcmAudioCapture(view, client as any);
  expect(attempts).toEqual([[]]); expect(contexts).toHaveLength(1); expect(contexts[0].sampleRate).toBe(48_000);
});
it("uses the existing silent16k capture graph for cascade without changing speech output", async () => {
  const { attempts, contexts, view, client } = silentSinkFactory(false);
  const output = Object.freeze({ setSinkId: vi.fn() }); view.agentAudioOutput = output;
  await startPcmAudioCapture(view, client as any);
  expect(attempts).toEqual([[{ sampleRate: 16_000, sinkId: { type: "none" }, latencyHint: 0.04 }]]);
  expect(contexts).toHaveLength(1); expect(view.agentAudioOutput).toBe(output);
  expect(output.setSinkId).not.toHaveBeenCalled();
  feed((view.agentAudioWorklet as FakeNode).vm.processor, signal(16_000));
  expect(client.appendPcm16).toHaveBeenCalledTimes(25);
});
it("closes the single silent-request context on the existing stale-generation boundary", async () => {
  const { attempts, contexts, view, client } = silentSinkFactory();
  await startPcmAudioCapture(view, client as any, () => false);
  expect(attempts).toHaveLength(1); expect(contexts).toHaveLength(1);
  expect(contexts[0].resume).toHaveBeenCalledOnce(); expect(contexts[0].close).toHaveBeenCalledOnce();
  expect(contexts[0].createMediaStreamSource).not.toHaveBeenCalled();
  expect(contexts[0].audioWorklet.addModule).not.toHaveBeenCalled(); expect(view.agentAudioWorklet).toBeNull();
});
it("closes the input context when the microphone source cannot be connected", async () => {
  const { contexts, view, client } = captureFactory(false);
  const error = new DOMException("Synthetic ended input track", "InvalidStateError");
  const start = startPcmAudioCapture(view, client as any);
  contexts[0].createMediaStreamSource.mockImplementation(() => { throw error; });
  await expect(start).rejects.toBe(error);
  expect(contexts[0].close).toHaveBeenCalledOnce();
  expect(view.agentAudioContext).toBeUndefined();
  expect(view.setVoiceCaptureMode).not.toHaveBeenCalled();
});
it("does not close an old context twice or lose its replacement when a retired capture finishes loading", async () => {
  const { contexts, view, client } = captureFactory(false);
  Object.assign(view, {
    clearVoiceWarmupTimer: vi.fn(),
    clearVoiceNoTranscriptTimer: vi.fn(),
    cleanupAgentMedia: vi.fn()
  });
  let current = true;
  let finishOld!: () => void;
  const start = startPcmAudioCapture(view, client as any, () => current);
  const old = contexts[0];
  old.audioWorklet.addModule.mockImplementationOnce(() => new Promise<void>(resolve => { finishOld = resolve; }));
  await vi.waitFor(() => expect(old.audioWorklet.addModule).toHaveBeenCalledOnce());
  current = false;
  cleanupRealtimeAudio(view);
  await startPcmAudioCapture(view, client as any);
  const replacement = view.agentAudioWorklet;
  finishOld();
  await start;

  expect(old.close).toHaveBeenCalledOnce();
  expect(view.agentAudioContext).toBe(contexts[1]);
  expect(view.agentAudioWorklet).toBe(replacement);
  expect(view.setVoiceCaptureMode).toHaveBeenCalledExactlyOnceWith("audio-worklet");
  cleanupRealtimeAudio(view);
});
it.each([16_000, 48_000])("detects local speech and leaves cascade dispatch to the server at %i Hz", async rate => {
  const { node, client, view } = await capture(rate, false);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  Object.assign(window, { setTimeout, clearTimeout });
  view.agentVoiceLocalSpeechActive = false;
  view.agentVoiceLocalLastSpeechAt = 0; view.agentVoiceLastTranscriptAt = 0;
  view.handleVoiceSpeechStarted = vi.fn(); view.sendVoiceTurnIfReady = vi.fn();
  view.clearVoiceNoTranscriptTimer = vi.fn(() => { clearTimeout(view.agentVoiceNoTranscriptTimer); view.agentVoiceNoTranscriptTimer = 0; });
  view.clearVoiceLocalEndpointTimer = vi.fn(() => { clearTimeout(view.agentVoiceLocalEndpointTimer); view.agentVoiceLocalEndpointTimer = 0; });
  try {
    vi.advanceTimersByTime(10);
    feed(node.vm.processor, new Float32Array(rate / 25).fill(0.003));
    expect(view.handleVoiceSpeechStarted).not.toHaveBeenCalled();
    feed(node.vm.processor, new Float32Array(rate / 25).fill(0.1));
    feed(node.vm.processor, new Float32Array(rate / 25).fill(0.1));
    expect(view.handleVoiceSpeechStarted).toHaveBeenCalledExactlyOnceWith("local-vad");
    expect(view.agentVoiceLocalSpeechActive).toBe(true);
    vi.advanceTimersByTime(1199);
    feed(node.vm.processor, new Float32Array(rate / 25));
    expect(view.agentVoiceLocalSpeechActive).toBe(true);
    expect(view.sendVoiceTurnIfReady).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    feed(node.vm.processor, new Float32Array(rate / 25));
    expect(view.agentVoiceLocalSpeechActive).toBe(false);
    vi.advanceTimersByTime(5000);
    expect(view.sendVoiceTurnIfReady).not.toHaveBeenCalled();
    const sent = client.appendPcm16.mock.calls.length, oldHandler = node.port.onmessage!;
    cleanupAudioWorkletCapture(view);
    oldHandler({ data: new Float32Array(rate / 25).fill(0.1) } as MessageEvent<Float32Array>);
    expect(client.appendPcm16).toHaveBeenCalledTimes(sent);
  } finally {
    clearTimeout(view.agentVoiceNoTranscriptTimer); clearTimeout(view.agentVoiceLocalEndpointTimer);
    vi.useRealTimers();
  }
});
