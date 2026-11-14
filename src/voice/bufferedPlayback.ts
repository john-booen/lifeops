import { createOutputSliceBudget, createOutputSliceYield } from "./outputSliceYield";
import type { AudioOutputActor, AudioOutputOwner, AudioOutputPlayback } from "./audioOutput";
import type { BailianRealtimeClient } from "../bailianRealtime";
import type { VoiceSessionController } from "./voiceRuntime";

type AudioChunk = { pcm: Int16Array; sampleRate: number; cue?: string };

interface BufferedPlaybackHost {
  agentVoiceRuntime?: VoiceSessionController;
  agentAudioOutput?: AudioOutputActor;
  agentRealtimeClient?: BailianRealtimeClient | null;
  agentOmniPlaybackReady?: Promise<AudioOutputPlayback | undefined> | null;
  agentOmniPendingAudio: AudioChunk[];
}

interface BufferedPlaybackHooks {
  capturePresentation(view: BufferedPlaybackHost): () => boolean;
  checkSources(view: BufferedPlaybackHost): Promise<boolean>;
  nativePlaybackBlocked(view: BufferedPlaybackHost): boolean;
  sourceChanged(view: BufferedPlaybackHost): void;
}

interface BufferedPlaybackDrain {
  ready: Promise<AudioOutputPlayback | undefined>;
  queue: AudioChunk[];
  current: () => boolean;
  drain?: Promise<void>;
  finishRequested: boolean;
  finished: boolean;
  sliceYield: ReturnType<typeof createOutputSliceYield>;
  startBudget: ReturnType<typeof createOutputSliceBudget>;
}

export function createBufferedVoicePlayback(hooks: BufferedPlaybackHooks) {
  const playbackDrains = new WeakMap<BufferedPlaybackHost, BufferedPlaybackDrain>();

  function retirePlaybackDrain(view: BufferedPlaybackHost): void {
    const held = playbackDrains.get(view);
    if (!held) return;
    playbackDrains.delete(view);
    held.sliceYield.dispose();
  }

  async function ensureBufferedPlayback(
    view: BufferedPlaybackHost,
    owner: Extract<AudioOutputOwner, "native-e2e" | "fallback-tts">,
    finishRequested = false
  ): Promise<void> {
    const runtime = view.agentVoiceRuntime;
    const output = view.agentAudioOutput;
    if (!runtime || !output) return;
    let turn = runtime.snapshot().currentTurn;
    if (!turn) return;
    if (!turn.playbackId) {
      runtime.bindPlayback(`${turn.turnId}-output-${turn.generation}`);
      turn = runtime.snapshot().currentTurn;
    }
    if (turn?.outputOwner !== owner) {
      runtime.selectOutputOwner(owner);
      turn = runtime.snapshot().currentTurn;
    }
    const playbackId = turn?.playbackId;
    if (!turn || !playbackId) return;
    if (!view.agentOmniPlaybackReady) {
      view.agentOmniPlaybackReady = output.start(playbackId, owner).catch(() => undefined);
    }
    const ready = view.agentOmniPlaybackReady;
    let state = playbackDrains.get(view);
    if (!state || state.ready !== ready || !state.current()) {
      retirePlaybackDrain(view);
      const client = view.agentRealtimeClient;
      const queue = view.agentOmniPendingAudio;
      const identity = { generation: turn.generation, turnId: turn.turnId, playbackId };
      const presentationCurrent = hooks.capturePresentation(view);
      const captured: BufferedPlaybackDrain = {
        ready, queue, finishRequested: false, finished: false,
        sliceYield: createOutputSliceYield(), startBudget: createOutputSliceBudget(),
        current: () => playbackDrains.get(view) === captured
          && view.agentOmniPlaybackReady === ready && view.agentOmniPendingAudio === queue
          && view.agentVoiceRuntime === runtime && view.agentAudioOutput === output
          && view.agentRealtimeClient === client && presentationCurrent()
          && runtime.snapshot().currentTurn?.outputOwner === owner && runtime.accepts(identity)
          && !(owner === "native-e2e" && hooks.nativePlaybackBlocked(view))
      };
      state = captured;
      playbackDrains.set(view, state);
    }
    state.finishRequested ||= finishRequested;
    if (state.finished) {
      if (state.current() && state.queue.length) {
        state.queue.splice(0);
        output.fail(playbackId, "audio_chunk_enqueue_failed");
      }
      return;
    }
    if (state.drain) return;
    const held = state;
    const client = view.agentRealtimeClient;
    let flight: Promise<void>;
    flight = Promise.resolve().then(async () => {
      await ready;
      let published = false;
      while (held.current()) {
        // Membership is fixed before the raw read. Later chunks need their own read.
        const chunks = held.queue.splice(0);
        if (chunks.length) {
          let offset = 0;
          while (offset < chunks.length) {
            const slice = Object.freeze(chunks.slice(offset, offset + 32));
            if (published) await held.sliceYield.wait();
            if (!held.current()) return;
            if (client?.hasProtectedContextSources?.() && !await hooks.checkSources(view)) return;
            if (!held.current()) return;
            const exhausted = held.startBudget();
            for (const chunk of slice) {
              if (!held.current()) return;
              try {
                client?.assertContextSourcesCurrentNow?.();
              } catch {
                if (held.current()) hooks.sourceChanged(view);
                return;
              }
              if (!held.current()) return;
              const appended = chunk.cue && !chunk.pcm.length ? output.appendCue(playbackId, chunk.cue)
                : chunk.cue ? output.appendPcm16(playbackId, chunk.pcm, chunk.sampleRate, chunk.cue)
                : output.appendPcm16(playbackId, chunk.pcm, chunk.sampleRate);
              if (!appended) {
                held.finished = true;
                output.fail(playbackId, "audio_chunk_enqueue_failed");
                return;
              }
              offset++;
              if (exhausted()) break;
            }
            published = true;
          }
          continue;
        }
        if (!held.finishRequested) return;
        // Terminal validation stays fresh and runs only after every queued batch.
        if (client?.hasProtectedContextSources?.() && !await hooks.checkSources(view)) return;
        if (!held.current()) return;
        if (held.queue.length) continue;
        try {
          client?.assertContextSourcesCurrentNow?.();
        } catch {
          if (held.current()) hooks.sourceChanged(view);
          return;
        }
        if (!held.current()) return;
        held.finished = true;
        output.finish(playbackId);
        return;
      }
    }).catch(() => { held.finished = true; }).finally(() => {
      // A retired flight cannot release or consume a replacement turn's queue.
      if (playbackDrains.get(view) !== held || held.drain !== flight) return;
      held.sliceYield.cancel();
      held.drain = undefined;
      if (held.current() && !held.finished && (held.queue.length || held.finishRequested)) {
        void ensureBufferedPlayback(view, owner);
      }
    });
    held.drain = flight;
  }

  function finishBufferedPlaybackWhenReady(view: BufferedPlaybackHost): void {
    const owner = view.agentVoiceRuntime?.snapshot().currentTurn?.outputOwner;
    if (owner === "native-e2e" || owner === "fallback-tts") {
      void ensureBufferedPlayback(view, owner, true);
    }
  }

  return { ensureBufferedPlayback, finishBufferedPlaybackWhenReady, retirePlaybackDrain };
}
