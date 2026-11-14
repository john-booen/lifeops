export type AudioOutputOwner = "native-e2e" | "fallback-tts" | "system";
export type AudioOutputStatus =
  | "idle"
  | "preparing"
  | "ready"
  | "playing"
  | "draining"
  | "completed"
  | "cancelled"
  | "failed";

export interface AudioOutputPlayback {
  playbackId: string;
  owner: AudioOutputOwner;
  status: AudioOutputStatus;
  startedAt: number;
  firstAudioAt: number | null;
  completedAt: number | null;
  chunksQueued: number;
  gain: number;
}

export type AudioOutputEventType =
  | "prepared"
  | "started"
  | "cue"
  | "drained"
  | "drain-timeout"
  | "cancelled"
  | "failed"
  | "first-audio-timeout"
  | "context-suspended"
  | "ducked"
  | "restored";

export interface AudioOutputEvent {
  type: AudioOutputEventType;
  playbackId: string;
  owner: AudioOutputOwner;
  timestamp: number;
  latencyMs?: number;
  errorCode?: string;
  cue?: string;
}

export interface AudioOutputContextLike {
  readonly sampleRate: number;
  readonly state: AudioContextState;
  readonly baseLatency?: number;
  readonly outputLatency?: number;
  readonly destination: AudioDestinationNode;
  readonly audioWorklet: {
    addModule(moduleUrl: string): Promise<void>;
  };
  resume(): Promise<void>;
  suspend?(): Promise<void>;
  close(): Promise<void>;
}

export interface AudioOutputPortLike {
  onmessage: ((event: MessageEvent<AudioOutputWorkletMessage>) => void) | null;
  postMessage(message: AudioOutputCommand, transfer?: Transferable[]): void;
}

export interface AudioOutputNodeLike {
  readonly port: AudioOutputPortLike;
  connect(destination: AudioDestinationNode): unknown;
  disconnect(): void;
}

export interface AudioOutputActorOptions {
  createContext?: () => AudioOutputContextLike;
  createNode?: (context: AudioOutputContextLike) => AudioOutputNodeLike;
  createModuleUrl?: () => string;
  revokeModuleUrl?: (moduleUrl: string) => void;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => number;
  clearTimer?: (timerId: number) => void;
  firstAudioTimeoutMs?: number;
  drainTimeoutMs?: number;
  onEvent?: (event: AudioOutputEvent) => void;
}

// Only the worklet uses these per-start IDs; public events retain the runtime playbackId.
export type AudioOutputCommand =
  | { type: "start"; playbackId: string }
  | { type: "chunk"; playbackId: string; samples: Float32Array; cue?: string }
  | { type: "cue"; playbackId: string; cue: string }
  | { type: "finish"; playbackId: string }
  | { type: "cancel"; playbackId: string }
  | { type: "gain"; playbackId: string; gain: number; rampFrames: number };

export type AudioOutputWorkletMessage =
  | { type: "started"; playbackId: string }
  | { type: "cue"; playbackId: string; cue: string }
  | { type: "drained"; playbackId: string }
  | { type: "cancelled"; playbackId: string }
  | { type: "failed"; playbackId: string; errorCode?: string };

const DEFAULT_FIRST_AUDIO_TIMEOUT_MS = 2_500;
const DEFAULT_DRAIN_TIMEOUT_MS = 30_000;
const DRAIN_SAFETY_MARGIN_MS = 5_000;
const IDLE_SUSPEND_MIN_GRACE_MS = 250;

export class AudioOutputActor {
  private readonly createContext: () => AudioOutputContextLike;
  private readonly createNode: (context: AudioOutputContextLike) => AudioOutputNodeLike;
  private readonly createModuleUrl: () => string;
  private readonly revokeModuleUrl: (moduleUrl: string) => void;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, delayMs: number) => number;
  private readonly clearTimer: (timerId: number) => void;
  private readonly firstAudioTimeoutMs: number;
  private readonly drainTimeoutMs: number;
  private readonly onEvent?: (event: AudioOutputEvent) => void;
  private context: AudioOutputContextLike | null = null;
  private node: AudioOutputNodeLike | null = null;
  private moduleUrl = "";
  private playback: AudioOutputPlayback | null = null;
  private workletGeneration = 0;
  private workletPlaybackId = "";
  private queuedAudioDurationMs = 0;
  private firstAudioTimer = 0;
  private drainTimer = 0;
  private initializing: Promise<void> | null = null;
  private lifecycleGeneration = 0;
  private idleSuspendTimer = 0;
  private idleSuspendPromise: Promise<void> | null = null;
  private idleSuspendError: string | null = null;

  constructor(options: AudioOutputActorOptions = {}) {
    this.createContext = options.createContext ?? defaultAudioContextFactory;
    this.createNode = options.createNode ?? defaultAudioWorkletNodeFactory;
    this.createModuleUrl = options.createModuleUrl ?? defaultAudioOutputModuleUrl;
    this.revokeModuleUrl = options.revokeModuleUrl ?? ((moduleUrl) => URL.revokeObjectURL(moduleUrl));
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((callback, delayMs) => window.setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimer ?? ((timerId) => window.clearTimeout(timerId));
    this.firstAudioTimeoutMs = Math.max(250, options.firstAudioTimeoutMs ?? DEFAULT_FIRST_AUDIO_TIMEOUT_MS);
    this.drainTimeoutMs = Math.max(500, options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS);
    this.onEvent = options.onEvent;
  }

  snapshot(): AudioOutputPlayback | null {
    return this.playback ? { ...this.playback } : null;
  }

  async start(playbackId: string, owner: AudioOutputOwner): Promise<AudioOutputPlayback> {
    const normalizedId = playbackId.trim();
    if (!normalizedId) throw new Error("[AudioOutput] playbackId cannot be empty");
    if (this.playback && !isTerminalAudioStatus(this.playback.status)) {
      this.cancel(this.playback.playbackId, "replaced_by_new_playback");
    }
    this.clearIdleSuspendTimer();

    const workletPlaybackId = `lifeops-output-${++this.workletGeneration}`;
    this.workletPlaybackId = workletPlaybackId;

    const now = this.now();
    this.queuedAudioDurationMs = 0;
    this.playback = {
      playbackId: normalizedId,
      owner,
      status: "preparing",
      startedAt: now,
      firstAudioAt: null,
      completedAt: null,
      chunksQueued: 0,
      gain: 1
    };

    const generation = this.lifecycleGeneration;
    let ownedPlayback = this.playback;
    try {
      await this.ensureReady();
      if (generation !== this.lifecycleGeneration || this.playback !== ownedPlayback
        || isTerminalAudioStatus(this.playback.status)) {
        throw new Error("[AudioOutput] Playback was stopped or replaced while preparing");
      }
      this.playback = { ...this.playback, status: "ready" };
      ownedPlayback = this.playback;
      this.node?.port.postMessage({ type: "start", playbackId: workletPlaybackId });
      this.armFirstAudioTimer(normalizedId);
      this.emit("prepared", this.playback);
      return { ...this.playback };
    } catch (error) {
      // A replacement may reuse this ID for another output owner while we await readiness.
      if (generation === this.lifecycleGeneration && this.playback === ownedPlayback) {
        this.fail(normalizedId, normalizeAudioErrorCode(error));
      }
      throw error;
    }
  }

  appendPcm16(playbackId: string, pcm: Int16Array, inputSampleRate: number, cue?: string): boolean {
    const current = this.playback;
    if (!current || current.playbackId !== playbackId || isTerminalAudioStatus(current.status)) return false;
    if (!this.node || !this.context || pcm.length === 0) return false;

    const samples = resamplePcm16ToFloat32(pcm, inputSampleRate, this.context.sampleRate);
    if (samples.length === 0) return false;
    this.playback = {
      ...current,
      chunksQueued: current.chunksQueued + 1
    };
    this.queuedAudioDurationMs += samples.length / this.context.sampleRate * 1000;
    this.node.port.postMessage(
      { type: "chunk", playbackId: this.workletPlaybackId, samples, ...(cue ? { cue } : {}) },
      [samples.buffer]
    );
    return true;
  }

  appendCue(playbackId: string, cue: string): boolean {
    const current = this.playback;
    if (!current || current.playbackId !== playbackId || isTerminalAudioStatus(current.status) || !this.node || !cue) return false;
    this.node.port.postMessage({ type: "cue", playbackId: this.workletPlaybackId, cue });
    return true;
  }

  finish(playbackId: string): boolean {
    const current = this.playback;
    if (!current || current.playbackId !== playbackId || isTerminalAudioStatus(current.status)) return false;
    if (current.status === "draining") return true;
    this.playback = { ...current, status: "draining" };
    this.node?.port.postMessage({ type: "finish", playbackId: this.workletPlaybackId });
    this.armDrainTimer(playbackId);
    return true;
  }

  duck(playbackId: string, gain = 0.2, rampMs = 80): boolean {
    return this.setGain(playbackId, gain, rampMs, "ducked");
  }

  restore(playbackId: string, rampMs = 120): boolean {
    return this.setGain(playbackId, 1, rampMs, "restored");
  }

  cancel(playbackId: string, reason = "playback_cancelled"): boolean {
    const current = this.playback;
    if (!current || current.playbackId !== playbackId || isTerminalAudioStatus(current.status)) return false;
    this.clearFirstAudioTimer();
    this.clearDrainTimer();
    this.stopWorkletPlayback();
    const now = this.now();
    this.playback = {
      ...current,
      status: "cancelled",
      completedAt: now
    };
    this.armIdleSuspendTimer();
    this.emit("cancelled", this.playback, { errorCode: reason });
    return true;
  }

  fail(playbackId: string, errorCode = "audio_output_failed"): boolean {
    const current = this.playback;
    if (!current || current.playbackId !== playbackId || isTerminalAudioStatus(current.status)) return false;
    this.clearFirstAudioTimer();
    this.clearDrainTimer();
    // Retire queued samples before notifying the host. A later cancel cannot
    // do this once the playback has entered its terminal failed state.
    this.stopWorkletPlayback();
    const now = this.now();
    this.playback = {
      ...current,
      status: "failed",
      completedAt: now
    };
    this.armIdleSuspendTimer();
    this.emit("failed", this.playback, { errorCode });
    return true;
  }

  private stopWorkletPlayback(): void {
    try {
      this.node?.port.postMessage({ type: "cancel", playbackId: this.workletPlaybackId });
    } catch {
      // Disconnect immediately if the port cannot tell the processor to discard its queued samples.
      this.disconnectWorklet();
    }
  }

  async resume(): Promise<boolean> {
    const context = this.context;
    const generation = this.lifecycleGeneration;
    const workletPlaybackId = this.workletPlaybackId;
    if (!context) return false;
    this.clearIdleSuspendTimer();
    if (this.idleSuspendPromise) {
      const playback = this.playback;
      await this.idleSuspendPromise;
      if (generation !== this.lifecycleGeneration || context !== this.context
        || workletPlaybackId !== this.workletPlaybackId || playback !== this.playback) return false;
    }
    if (context.state === "running") {
      if (this.playback && isTerminalAudioStatus(this.playback.status)) this.armIdleSuspendTimer();
      return true;
    }
    try {
      await context.resume();
    } catch {
      if (generation !== this.lifecycleGeneration || context !== this.context
        || workletPlaybackId !== this.workletPlaybackId) return false;
      const current = this.playback;
      if (current && !isTerminalAudioStatus(current.status)) {
        this.fail(current.playbackId, "audio_context_resume_failed");
      }
      return false;
    }
    if (generation !== this.lifecycleGeneration || context !== this.context
      || workletPlaybackId !== this.workletPlaybackId) return false;
    const resumedState = this.context.state as AudioContextState;
    if (resumedState !== "running") {
      const current = this.playback;
      if (current && !isTerminalAudioStatus(current.status)) {
        this.emit("context-suspended", current, { errorCode: "audio_context_suspended" });
      }
      return false;
    }
    if (this.playback && isTerminalAudioStatus(this.playback.status)) this.armIdleSuspendTimer();
    return true;
  }

  async close(): Promise<void> {
    this.lifecycleGeneration += 1;
    this.idleSuspendPromise = null;
    const current = this.playback;
    if (current && !isTerminalAudioStatus(current.status)) {
      this.cancel(current.playbackId, "audio_output_closed");
    }
    this.clearIdleSuspendTimer();
    this.clearFirstAudioTimer();
    this.clearDrainTimer();
    this.disconnectWorklet();
    const context = this.context;
    this.context = null;
    this.initializing = null;
    if (this.moduleUrl) {
      this.revokeModuleUrl(this.moduleUrl);
      this.moduleUrl = "";
    }
    await context?.close().catch(() => undefined);
  }

  private disconnectWorklet(): void {
    const node = this.node;
    this.node = null;
    if (!node) return;
    node.port.onmessage = null;
    node.disconnect();
  }

  private async ensureReady(): Promise<void> {
    if (this.node && this.context) {
      if ((this.idleSuspendPromise || this.context.state !== "running") && !(await this.resume())) {
        throw new Error("audio_context_suspended");
      }
      return;
    }
    if (this.initializing) return this.initializing;

    const generation = this.lifecycleGeneration;
    const assertCurrent = () => {
      if (generation !== this.lifecycleGeneration) throw new Error("audio_output_closed_while_preparing");
    };
    const initializing = (async () => {
      const context = this.context ?? this.createContext();
      this.context = context;
      if (context.state !== "running") {
        try {
          await context.resume();
        } catch {
          throw new Error("audio_context_resume_failed");
        }
      }
      assertCurrent();
      if (context.state !== "running") throw new Error("audio_context_suspended");

      if (!this.moduleUrl) this.moduleUrl = this.createModuleUrl();
      await context.audioWorklet.addModule(this.moduleUrl);
      assertCurrent();
      const node = this.createNode(context);
      node.port.onmessage = (event) => {
        if (generation === this.lifecycleGeneration) this.handleWorkletMessage(event.data);
      };
      node.connect(context.destination);
      this.node = node;
    })();
    this.initializing = initializing;

    try {
      await initializing;
    } finally {
      if (this.initializing === initializing) this.initializing = null;
    }
  }

  private setGain(
    playbackId: string,
    gain: number,
    rampMs: number,
    eventType: Extract<AudioOutputEventType, "ducked" | "restored">
  ): boolean {
    const current = this.playback;
    if (!current || current.playbackId !== playbackId || isTerminalAudioStatus(current.status)) return false;
    const normalizedGain = Math.max(0, Math.min(1, Number.isFinite(gain) ? gain : 1));
    if (current.gain === normalizedGain) return true;
    const sampleRate = this.context?.sampleRate ?? 48_000;
    const rampFrames = Math.max(1, Math.round(sampleRate * Math.max(0, rampMs) / 1000));
    this.playback = {
      ...current,
      gain: normalizedGain
    };
    this.node?.port.postMessage({
      type: "gain",
      playbackId: this.workletPlaybackId,
      gain: normalizedGain,
      rampFrames
    });
    this.emit(eventType, this.playback);
    return true;
  }

  private handleWorkletMessage(message: AudioOutputWorkletMessage): void {
    const current = this.playback;
    if (!current || message.playbackId !== this.workletPlaybackId || isTerminalAudioStatus(current.status)) return;
    if (message.type === "cue") { this.emit("cue", current, { cue: message.cue }); return; }
    if (message.type === "started") {
      if (current.firstAudioAt !== null) return;
      this.clearFirstAudioTimer();
      const now = this.now();
      this.playback = {
        ...current,
        status: current.status === "draining" ? "draining" : "playing",
        firstAudioAt: now
      };
      this.emit("started", this.playback, {
        latencyMs: Math.max(0, now - current.startedAt)
      });
      return;
    }
    if (message.type === "drained") {
      this.clearFirstAudioTimer();
      this.clearDrainTimer();
      const now = this.now();
      this.playback = {
        ...current,
        status: "completed",
        completedAt: now
      };
      this.armIdleSuspendTimer();
      this.emit("drained", this.playback, {
        latencyMs: Math.max(0, now - current.startedAt)
      });
      return;
    }
    if (message.type === "cancelled") {
      this.cancel(current.playbackId, "worklet_cancelled");
      return;
    }
    this.fail(current.playbackId, message.errorCode ?? "audio_worklet_failed");
  }

  private armFirstAudioTimer(playbackId: string): void {
    this.clearFirstAudioTimer();
    const workletPlaybackId = this.workletPlaybackId;
    this.firstAudioTimer = this.setTimer(() => {
      if (this.workletPlaybackId !== workletPlaybackId) return;
      this.firstAudioTimer = 0;
      const current = this.playback;
      if (!current || current.playbackId !== playbackId || current.firstAudioAt !== null) return;
      if (isTerminalAudioStatus(current.status)) return;
      this.emit("first-audio-timeout", current, {
        latencyMs: Math.max(0, this.now() - current.startedAt),
        errorCode: "audio_first_frame_timeout"
      });
    }, this.firstAudioTimeoutMs);
  }

  private clearFirstAudioTimer(): void {
    if (!this.firstAudioTimer) return;
    this.clearTimer(this.firstAudioTimer);
    this.firstAudioTimer = 0;
  }

  private armDrainTimer(playbackId: string): void {
    this.clearDrainTimer();
    const workletPlaybackId = this.workletPlaybackId;
    const current = this.playback;
    const elapsedPlaybackMs = current?.firstAudioAt === null || current?.firstAudioAt === undefined
      ? 0
      : Math.max(0, this.now() - current.firstAudioAt);
    const estimatedRemainingAudioMs = Math.max(0, this.queuedAudioDurationMs - elapsedPlaybackMs);
    const timeoutMs = Math.max(
      this.drainTimeoutMs,
      Math.ceil(estimatedRemainingAudioMs + DRAIN_SAFETY_MARGIN_MS)
    );
    this.drainTimer = this.setTimer(() => {
      if (this.workletPlaybackId !== workletPlaybackId) return;
      this.drainTimer = 0;
      const latest = this.playback;
      if (!latest || latest.playbackId !== playbackId || latest.status !== "draining") return;
      this.emit("drain-timeout", latest, {
        latencyMs: Math.max(0, this.now() - latest.startedAt),
        errorCode: "audio_drain_timeout"
      });
    }, timeoutMs);
  }

  private clearDrainTimer(): void {
    if (!this.drainTimer) return;
    this.clearTimer(this.drainTimer);
    this.drainTimer = 0;
  }

  private clearIdleSuspendTimer(): void {
    if (!this.idleSuspendTimer) return;
    this.clearTimer(this.idleSuspendTimer);
    this.idleSuspendTimer = 0;
  }

  private armIdleSuspendTimer(): void {
    this.clearIdleSuspendTimer();
    const context = this.context, playback = this.playback, generation = this.lifecycleGeneration;
    const suspend = context?.suspend;
    if (!context || !this.node || !playback || !isTerminalAudioStatus(playback.status)
      || context.state !== "running" || typeof suspend !== "function" || this.idleSuspendPromise) return;
    // Drained is before the device's final buffered samples. Reported latency
    // plus a margin, with a conservative default, avoids an immediate cut-off.
    const latency = (value: number | undefined) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
    const graceMs = Math.max(IDLE_SUSPEND_MIN_GRACE_MS,
      Math.ceil((latency(context.baseLatency) + latency(context.outputLatency)) * 1000) + 50);
    if (!Number.isFinite(graceMs) || graceMs > 2_147_483_647) return;
    const stillIdle = () => generation === this.lifecycleGeneration && context === this.context
      && playback === this.playback && isTerminalAudioStatus(playback.status);
    const timer = this.setTimer(() => {
      if (this.idleSuspendTimer !== timer) return;
      this.idleSuspendTimer = 0;
      if (!stillIdle() || context.state !== "running" || this.idleSuspendPromise) return;
      this.idleSuspendError = null;
      const pending = Promise.resolve().then(async () => {
        if (stillIdle()) await Reflect.apply(suspend, context, []);
      }).catch(error => {
        if (generation === this.lifecycleGeneration && context === this.context) {
          this.idleSuspendError = error instanceof Error ? error.name.slice(0, 64) : "UnknownSuspendError";
        }
      });
      this.idleSuspendPromise = pending;
      void pending.then(() => {
        if (this.idleSuspendPromise === pending) this.idleSuspendPromise = null;
      });
    }, graceMs);
    this.idleSuspendTimer = timer;
  }

  private emit(
    type: AudioOutputEventType,
    playback: AudioOutputPlayback,
    extra: Pick<AudioOutputEvent, "latencyMs" | "errorCode" | "cue"> = {}
  ): void {
    this.onEvent?.({
      type,
      playbackId: playback.playbackId,
      owner: playback.owner,
      timestamp: this.now(),
      ...extra
    });
  }
}

export function resamplePcm16ToFloat32(
  pcm: Int16Array,
  inputSampleRate: number,
  outputSampleRate: number
): Float32Array {
  if (pcm.length === 0) return new Float32Array();
  const fromRate = normalizeSampleRate(inputSampleRate);
  const toRate = normalizeSampleRate(outputSampleRate);
  if (fromRate === toRate) {
    const output = new Float32Array(pcm.length);
    for (let index = 0; index < pcm.length; index += 1) {
      output[index] = pcm[index] / 0x8000;
    }
    return output;
  }

  const outputLength = Math.max(1, Math.round(pcm.length * toRate / fromRate));
  const output = new Float32Array(outputLength);
  const sourceScale = fromRate / toRate;
  for (let index = 0; index < outputLength; index += 1) {
    const sourcePosition = index * sourceScale;
    const lower = Math.min(pcm.length - 1, Math.floor(sourcePosition));
    const upper = Math.min(pcm.length - 1, lower + 1);
    const fraction = sourcePosition - lower;
    const sample = pcm[lower] + (pcm[upper] - pcm[lower]) * fraction;
    output[index] = Math.max(-1, Math.min(1, sample / 0x8000));
  }
  return output;
}

export function lifeOpsPcmOutputWorkletSource(): string {
  return `
class LifeOpsPcmOutputProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.playbackId = "";
    this.queue = [];
    this.current = null;
    this.currentCue = "";
    this.offset = 0;
    this.inputFinished = false;
    this.started = false;
    this.drained = false;
    this.currentGain = 1;
    this.targetGain = 1;
    this.gainStep = 0;
    this.gainFramesRemaining = 0;
    this.port.onmessage = (event) => this.handleCommand(event.data);
  }

  handleCommand(command) {
    if (!command || typeof command.type !== "string") return;
    if (command.type === "start") {
      this.playbackId = String(command.playbackId || "");
      this.queue = [];
      this.current = null;
      this.currentCue = "";
      this.offset = 0;
      this.inputFinished = false;
      this.started = false;
      this.drained = false;
      this.currentGain = 1;
      this.targetGain = 1;
      this.gainStep = 0;
      this.gainFramesRemaining = 0;
      return;
    }
    if (!this.playbackId || command.playbackId !== this.playbackId) return;
    if (command.type === "chunk" && command.samples) {
      this.queue.push({ samples: command.samples, cue: command.cue });
      return;
    }
    if (command.type === "cue" && command.cue) {
      this.queue.push({ cue: command.cue });
      return;
    }
    if (command.type === "finish") {
      this.inputFinished = true;
      return;
    }
    if (command.type === "gain") {
      this.targetGain = Math.max(0, Math.min(1, Number(command.gain)));
      this.gainFramesRemaining = Math.max(1, Math.floor(Number(command.rampFrames) || 1));
      this.gainStep = (this.targetGain - this.currentGain) / this.gainFramesRemaining;
      return;
    }
    if (command.type === "cancel") {
      this.queue = [];
      this.current = null;
      this.currentCue = "";
      this.offset = 0;
      this.inputFinished = true;
      this.drained = true;
      this.port.postMessage({ type: "cancelled", playbackId: this.playbackId });
    }
  }

  process(_inputs, outputs) {
    const channel = outputs[0] && outputs[0][0];
    if (!channel) return true;
    channel.fill(0);
    if (!this.playbackId || this.drained) return true;

    let writeOffset = 0;
    while (writeOffset < channel.length) {
      if (!this.current || this.offset >= this.current.length) {
        const chunk = this.queue.shift();
        this.current = chunk && chunk.samples || null;
        this.currentCue = chunk && chunk.cue || "";
        this.offset = 0;
        if (!this.current && this.currentCue) {
          this.port.postMessage({ type: "cue", playbackId: this.playbackId, cue: this.currentCue });
          this.currentCue = "";
          continue;
        }
      }
      if (!this.current) break;
      const available = this.current.length - this.offset;
      const writable = channel.length - writeOffset;
      const count = Math.min(available, writable);
      for (let index = 0; index < count; index += 1) {
        if (this.gainFramesRemaining > 0) {
          this.currentGain += this.gainStep;
          this.gainFramesRemaining -= 1;
          if (this.gainFramesRemaining === 0) this.currentGain = this.targetGain;
        }
        channel[writeOffset + index] = this.current[this.offset + index] * this.currentGain;
      }
      this.offset += count;
      writeOffset += count;
      if (!this.started && count > 0) {
        this.started = true;
        this.port.postMessage({ type: "started", playbackId: this.playbackId });
      }
      if (this.currentCue && count > 0) {
        this.port.postMessage({ type: "cue", playbackId: this.playbackId, cue: this.currentCue });
        this.currentCue = "";
      }
    }

    if (
      this.inputFinished
      && !this.drained
      && !this.current
      && this.queue.length === 0
    ) {
      this.drained = true;
      this.port.postMessage({ type: "drained", playbackId: this.playbackId });
    }
    return true;
  }
}

registerProcessor("lifeops-pcm-output", LifeOpsPcmOutputProcessor);
`;
}

function isTerminalAudioStatus(status: AudioOutputStatus): boolean {
  return status === "completed" || status === "cancelled" || status === "failed";
}

function normalizeSampleRate(sampleRate: number): number {
  return Number.isFinite(sampleRate) && sampleRate > 0 ? Math.round(sampleRate) : 24_000;
}

function normalizeAudioErrorCode(error: unknown): string {
  if (!(error instanceof Error)) return "audio_output_failed";
  if (/resume/i.test(error.message)) return "audio_context_resume_failed";
  if (/suspended/i.test(error.message)) return "audio_context_suspended";
  if (/worklet/i.test(error.message)) return "audio_worklet_init_failed";
  if (/replaced/i.test(error.message)) return "audio_playback_replaced";
  return "audio_output_failed";
}

function defaultAudioContextFactory(): AudioOutputContextLike {
  const AudioContextConstructor = window.AudioContext
    ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextConstructor) throw new Error("audio_context_unavailable");
  return new AudioContextConstructor();
}

function defaultAudioWorkletNodeFactory(context: AudioOutputContextLike): AudioOutputNodeLike {
  return new AudioWorkletNode(context as AudioContext, "lifeops-pcm-output", {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [1]
  });
}

function defaultAudioOutputModuleUrl(): string {
  return URL.createObjectURL(new Blob(
    [lifeOpsPcmOutputWorkletSource()],
    { type: "application/javascript" }
  ));
}
