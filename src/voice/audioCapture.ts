import type { BailianRealtimeClient } from "../bailianRealtime";

interface CaptureView {
  controller: { settings: { realtimeVoice: { provider: string } } };
  agentStream?: MediaStream | null;
  agentAudioContext?: AudioContext | null;
  agentAudioSource?: MediaStreamAudioSourceNode | null;
  agentAudioProcessor?: ScriptProcessorNode | null;
  agentAudioWorklet?: AudioWorkletNode | null;
  agentRealtimeClient?: BailianRealtimeClient | null;
  agentVoiceReady: boolean;
  agentRecording: boolean;
  setVoiceCaptureMode(mode: "audio-worklet" | "script-processor"): void;
}

type ObserveInput = (input: Float32Array) => void;

export async function startPcmAudioCapture(
  view: CaptureView,
  client: BailianRealtimeClient,
  isCurrent: () => boolean = () => true,
  observeInput?: ObserveInput
): Promise<void> {
  const stream = view.agentStream;
  if (!stream) throw new Error("麦克风流未准备好。");
  const AudioContextConstructor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextConstructor) throw new Error("当前环境不支持 Web Audio。");

  let audioContext: AudioContext | undefined;
  // Cascade ASR uses the same 16k PCM input as Omni; keep their capture geometry
  // aligned so quantum-local resampling cannot shorten daily conversation audio.
  if (view.controller.settings.realtimeVoice.provider === "qwen-omni-realtime") {
    if ("setSinkId" in AudioContextConstructor.prototype) {
      try {
        const options: AudioContextOptions & { sinkId: { type: "none" } } = {
          sampleRate: 16_000, sinkId: { type: "none" }, latencyHint: 0.04
        };
        audioContext = new AudioContextConstructor(options);
      } catch {
        // The optional sink request must fall back to the established capture path.
      }
    }
    if (!audioContext) {
      try {
        audioContext = new AudioContextConstructor({ sampleRate: 16_000 });
      } catch (error) {
        if (!(error instanceof DOMException) || error.name !== "NotSupportedError") throw error;
        audioContext = new AudioContextConstructor();
      }
    }
  } else {
    audioContext = new AudioContextConstructor();
  }
  if (audioContext.state === "suspended") {
    await audioContext.resume().catch(() => undefined);
  }
  if (!isCurrent()) { await audioContext.close(); return; }
  let source: MediaStreamAudioSourceNode;
  try {
    source = audioContext.createMediaStreamSource(stream);
  } catch (error) {
    await audioContext.close().catch(() => undefined);
    throw error;
  }
  view.agentAudioContext = audioContext;
  view.agentAudioSource = source;

  const worklet = await startAudioWorkletCapture(view, audioContext, source, client, isCurrent, observeInput);
  if (!isCurrent()) {
    // The stop path may already have disconnected and closed this exact context.
    if (view.agentAudioContext === audioContext) cleanupCaptureNodes(view);
    return;
  }
  if (worklet) {
    view.setVoiceCaptureMode("audio-worklet");
    return;
  }

  const processor = audioContext.createScriptProcessor(1024, 1, 1);
  const sink = audioContext.createGain();
  sink.gain.value = 0;
  processor.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0);
    if (!isCurrent() || view.agentAudioProcessor !== processor || !canSendRealtimeAudio(view, client)) return;
    observeInput?.(input);
    const pcm = floatTo16kPcm(input, audioContext.sampleRate);
    if (pcm.byteLength > 0) {
      client.appendPcm16(pcm16ToBase64(pcm));
    }
  };
  source.connect(processor);
  processor.connect(sink);
  sink.connect(audioContext.destination);
  view.agentAudioProcessor = processor;
  view.setVoiceCaptureMode("script-processor");
}

export async function startAudioWorkletCapture(
  view: CaptureView,
  audioContext: AudioContext,
  source: MediaStreamAudioSourceNode,
  client: BailianRealtimeClient,
  isCurrent: () => boolean = () => true,
  observeInput?: ObserveInput
): Promise<boolean> {
  if (!audioContext.audioWorklet || typeof AudioWorkletNode === "undefined") return false;
  let moduleUrl: string | undefined;
  let node: AudioWorkletNode | undefined;
  let sink: GainNode | undefined;
  try {
    const batch40ms = view.controller.settings.realtimeVoice.provider === "qwen-omni-realtime"
      && [16_000, 44_100, 48_000].includes(audioContext.sampleRate);
    moduleUrl = URL.createObjectURL(new Blob([lifeOpsAudioWorkletSource(batch40ms)], { type: "text/javascript" }));
    await audioContext.audioWorklet.addModule(moduleUrl);
    if (!isCurrent()) return false;
    node = new AudioWorkletNode(audioContext, "lifeops-pcm-capture");
    sink = audioContext.createGain();
    sink.gain.value = 0;
    node.port.onmessage = (event: MessageEvent<Float32Array>) => {
      if (!isCurrent() || view.agentAudioWorklet !== node || !canSendRealtimeAudio(view, client)) return;
      const input = event.data;
      observeInput?.(input);
      const pcm = floatTo16kPcm(input, audioContext.sampleRate);
      if (pcm.byteLength > 0) client.appendPcm16(pcm16ToBase64(pcm));
    };
    source.connect(node);
    node.connect(sink);
    sink.connect(audioContext.destination);
    view.agentAudioWorklet = node;
    return true;
  } catch {
    if (node) {
      node.port.onmessage = null;
      node.disconnect();
    }
    sink?.disconnect();
    return false;
  } finally {
    if (moduleUrl) URL.revokeObjectURL(moduleUrl);
  }
}

export function canSendRealtimeAudio(view: CaptureView, client: BailianRealtimeClient): boolean {
  return view.agentVoiceReady && view.agentRecording && view.agentRealtimeClient === client;
}

export function cleanupCaptureNodes(view: CaptureView): void {
  cleanupAudioWorkletCapture(view);
  if (view.agentAudioProcessor) {
    view.agentAudioProcessor.onaudioprocess = null;
    view.agentAudioProcessor.disconnect();
  }
  view.agentAudioSource?.disconnect();
  void view.agentAudioContext?.close().catch(() => undefined);
  view.agentAudioProcessor = null;
  view.agentAudioSource = null;
  view.agentAudioContext = null;
}

export function cleanupAudioWorkletCapture(view: CaptureView): void {
  if (view.agentAudioWorklet) {
    view.agentAudioWorklet.port.onmessage = null;
    view.agentAudioWorklet.disconnect();
  }
  view.agentAudioWorklet = null;
}

export function floatTo16kPcm(input: Float32Array, inputSampleRate: number): Int16Array {
  const outputSampleRate = 16_000;
  const ratio = inputSampleRate / outputSampleRate;
  const length = Math.floor(input.length / ratio);
  const output = new Int16Array(length);
  for (let index = 0; index < length; index += 1) {
    const sourceIndex = Math.floor(index * ratio);
    const sample = Math.max(-1, Math.min(1, input[sourceIndex] ?? 0));
    output[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return output;
}

export function audioRms(input: Float32Array): number {
  if (input.length === 0) return 0;
  let sum = 0;
  for (let index = 0; index < input.length; index += 1) {
    const value = input[index] ?? 0;
    sum += value * value;
  }
  return Math.sqrt(sum / input.length);
}

export function pcm16ToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const toBase64 = (bytes as Uint8Array & { toBase64?: () => string }).toBase64;
  if (typeof toBase64 === "function") return toBase64.call(bytes);
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return window.btoa(binary);
}

export function lifeOpsAudioWorkletSource(omniBatch40ms = false): string {
  return `
class LifeOpsPcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // Standard capture rates have an integral 40ms input size. Rechunk before
    // resampling so quantum-local flooring cannot lose fractional output.
    this.batchFrames = ${omniBatch40ms} && [16000, 44100, 48000].includes(sampleRate) ? sampleRate / 25 : 0;
    this.pending = this.batchFrames ? new Float32Array(this.batchFrames) : null;
    this.pendingFrames = 0;
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length > 0) {
      if (!this.batchFrames) {
        const copy = new Float32Array(channel.length);
        copy.set(channel);
        this.port.postMessage(copy, [copy.buffer]);
      } else {
        let offset = 0;
        while (offset < channel.length) {
          const count = Math.min(channel.length - offset, this.batchFrames - this.pendingFrames);
          this.pending.set(channel.subarray(offset, offset + count), this.pendingFrames);
          this.pendingFrames += count;
          offset += count;
          if (this.pendingFrames === this.batchFrames) {
            const full = this.pending;
            this.pending = new Float32Array(this.batchFrames);
            this.pendingFrames = 0;
            this.port.postMessage(full, [full.buffer]);
          }
        }
      }
    }
    return true;
  }
}

registerProcessor("lifeops-pcm-capture", LifeOpsPcmCaptureProcessor);
`;
}

export function base64ToPcm16(base64Audio: string): Int16Array {
  if (!base64Audio) return new Int16Array();
  const binary = window.atob(base64Audio);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
}
