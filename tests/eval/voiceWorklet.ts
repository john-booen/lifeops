import { runInNewContext } from "node:vm";
import { AudioOutputActor, lifeOpsPcmOutputWorkletSource, type AudioOutputCommand, type AudioOutputContextLike,
  type AudioOutputEvent, type AudioOutputWorkletMessage } from "../../src/voice/audioOutput";

interface PcmProcessor {
  handleCommand(command: AudioOutputCommand): void;
  process(inputs: unknown[], outputs: Float32Array[][]): boolean;
}

/** Render the production PCM worklet in Node without sending sound to a device. */
export function createVoiceWorklet(onEvent: (event: AudioOutputEvent) => void) {
  let Processor!: new () => PcmProcessor;
  const replies: AudioOutputWorkletMessage[] = [];
  runInNewContext(lifeOpsPcmOutputWorkletSource(), {
    AudioWorkletProcessor: class { port = { onmessage: null, postMessage: (message: AudioOutputWorkletMessage) => replies.push(message) }; },
    registerProcessor: (_name: string, type: typeof Processor) => { Processor = type; }
  });
  const processor = new Processor();
  const port = {
    onmessage: null as ((event: MessageEvent<AudioOutputWorkletMessage>) => void) | null,
    postMessage: (message: AudioOutputCommand) => processor.handleCommand(message)
  };
  const context: AudioOutputContextLike = {
    sampleRate: 48_000, state: "running", destination: {} as AudioDestinationNode,
    audioWorklet: { addModule: async () => {} }, resume: async () => {}, close: async () => {}
  };
  const actor = new AudioOutputActor({ createContext: () => context, createModuleUrl: () => "blob:voice-eval",
    revokeModuleUrl: () => {}, createNode: () => ({ port, connect: () => {}, disconnect: () => {} }), onEvent });
  return { actor, render() {
    const samples = new Float32Array(128);
    processor.process([], [[samples]]);
    for (const data of replies.splice(0)) port.onmessage?.({ data } as MessageEvent<AudioOutputWorkletMessage>);
    return samples;
  } };
}
