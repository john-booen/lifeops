export type VoiceRuntimeSessionPhase =
  | "stopped"
  | "connecting"
  | "listening"
  | "recovering"
  | "stopping";

export type VoiceRuntimeTurnPhase =
  | "capturing"
  | "endpointing"
  | "routing"
  | "generating"
  | "synthesizing"
  | "playing"
  | "completed"
  | "interrupted"
  | "failed";

export type VoiceRuntimeTurnRoute = "e2e" | "brain" | "action";
export type VoiceRuntimeOutputOwner = "none" | "native-e2e" | "fallback-tts" | "system";
export type VoiceRuntimeTerminalPhase = Extract<
  VoiceRuntimeTurnPhase,
  "completed" | "interrupted" | "failed"
>;
export type VoiceRuntimeInputPriority = "normal" | "interrupt";

export interface VoiceRuntimeTurn {
  turnId: string;
  generation: number;
  phase: VoiceRuntimeTurnPhase;
  route: VoiceRuntimeTurnRoute;
  inputItemId: string | null;
  responseId: string | null;
  playbackId: string | null;
  outputOwner: VoiceRuntimeOutputOwner;
  transcript: string;
  assistantText: string;
  nativeAudioStarted: boolean;
  nativeAudioDone: boolean;
  modelDone: boolean;
  playbackDrained: boolean;
  startedAt: number;
  updatedAt: number;
  settledAt: number | null;
  terminalReason: string | null;
  abortController: AbortController;
}

export interface VoiceRuntimeQueuedInput {
  id: string;
  text: string;
  priority: VoiceRuntimeInputPriority;
  createdAt: number;
}

export interface VoiceRuntimeSnapshot {
  sessionId: string;
  sessionPhase: VoiceRuntimeSessionPhase;
  generation: number;
  currentTurn: VoiceRuntimeTurn | null;
  inputQueue: readonly VoiceRuntimeQueuedInput[];
  lastErrorCode: string | null;
}

export interface VoiceRuntimeCallbackIdentity {
  generation: number;
  turnId: string;
  responseId?: string | null;
  playbackId?: string | null;
}

export interface VoiceRuntimeEvent {
  timestamp: number;
  sessionId: string;
  generation: number;
  turnId?: string;
  provider?: string;
  providerTraceId?: string;
  route?: VoiceRuntimeTurnRoute;
  eventType: string;
  responseId?: string;
  playbackId?: string;
  stateBefore: string;
  stateAfter: string;
  latencyMs?: number;
  errorCode?: string;
  textLength?: number;
}

export interface VoiceRuntimeControllerOptions {
  now?: () => number;
  createId?: (prefix: string) => string;
  journal?: VoiceRuntimeJournal;
  provider?: string;
}

export interface BeginVoiceRuntimeTurnOptions {
  turnId?: string;
  route?: VoiceRuntimeTurnRoute;
  transcript?: string;
}

export interface QueueVoiceRuntimeInputOptions {
  id?: string;
  priority?: VoiceRuntimeInputPriority;
}

const SESSION_TRANSITIONS: Readonly<Record<VoiceRuntimeSessionPhase, readonly VoiceRuntimeSessionPhase[]>> = {
  stopped: ["connecting"],
  connecting: ["listening", "recovering", "stopping"],
  listening: ["recovering", "stopping"],
  recovering: ["connecting", "listening", "stopping"],
  stopping: ["stopped"]
};

const TURN_TRANSITIONS: Readonly<Record<VoiceRuntimeTurnPhase, readonly VoiceRuntimeTurnPhase[]>> = {
  capturing: ["endpointing", "routing", "interrupted", "failed"],
  endpointing: ["routing", "interrupted", "failed"],
  routing: ["generating", "synthesizing", "playing", "completed", "interrupted", "failed"],
  generating: ["synthesizing", "playing", "completed", "interrupted", "failed"],
  synthesizing: ["playing", "completed", "interrupted", "failed"],
  playing: ["completed", "interrupted", "failed"],
  completed: [],
  interrupted: [],
  failed: []
};

const TERMINAL_TURN_PHASES = new Set<VoiceRuntimeTurnPhase>(["completed", "interrupted", "failed"]);

export class VoiceRuntimeJournal {
  private readonly entries: VoiceRuntimeEvent[] = [];

  constructor(
    private readonly maxEntries = 500,
    private readonly sink?: (event: VoiceRuntimeEvent) => void
  ) {}

  record(event: VoiceRuntimeEvent): void {
    const sanitized = sanitizeRuntimeEvent(event);
    this.entries.push(sanitized);
    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries);
    }
    this.sink?.(sanitized);
  }

  snapshot(): readonly VoiceRuntimeEvent[] {
    return this.entries.map((event) => ({ ...event }));
  }

  clear(): void {
    this.entries.length = 0;
  }
}

export class VoiceSessionController {
  private readonly now: () => number;
  private readonly createId: (prefix: string) => string;
  private readonly journal: VoiceRuntimeJournal;
  private readonly provider: string;
  private state: VoiceRuntimeSnapshot;
  private readonly retiredResponseIds = new Set<string>();

  constructor(options: VoiceRuntimeControllerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? defaultRuntimeId;
    this.journal = options.journal ?? new VoiceRuntimeJournal();
    this.provider = options.provider ?? "unknown";
    this.state = {
      sessionId: this.createId("voice-session"),
      sessionPhase: "stopped",
      generation: 0,
      currentTurn: null,
      inputQueue: [],
      lastErrorCode: null
    };
  }

  snapshot(): VoiceRuntimeSnapshot {
    return {
      ...this.state,
      currentTurn: this.state.currentTurn ? cloneRuntimeTurn(this.state.currentTurn) : null,
      inputQueue: this.state.inputQueue.map((input) => ({ ...input }))
    };
  }

  eventJournal(): VoiceRuntimeJournal {
    return this.journal;
  }

  connect(): void {
    this.transitionSession("connecting", "session.connect");
  }

  connected(): void {
    this.transitionSession("listening", "session.connected");
  }

  reconnect(errorCode = "voice_connection_lost"): void {
    this.settleCurrentTurn("failed", errorCode);
    if (this.state.sessionPhase === "listening" || this.state.sessionPhase === "connecting") {
      this.transitionSession("recovering", "session.recovering", errorCode);
    }
  }

  recovered(): void {
    if (this.state.sessionPhase === "recovering") {
      this.transitionSession("listening", "session.recovered");
    }
  }

  beginTurn(options: BeginVoiceRuntimeTurnOptions = {}): VoiceRuntimeTurn {
    if (this.state.sessionPhase !== "listening") {
      throw new Error(`[VoiceRuntime] Cannot begin a turn while session is ${this.state.sessionPhase}`);
    }
    if (this.state.currentTurn && !isTerminalTurnPhase(this.state.currentTurn.phase)) {
      throw new Error(`[VoiceRuntime] Turn ${this.state.currentTurn.turnId} is still active`);
    }

    const now = this.now();
    const generation = this.state.generation + 1;
    this.retiredResponseIds.clear();
    const turn: VoiceRuntimeTurn = {
      turnId: options.turnId ?? this.createId("voice-turn"),
      generation,
      phase: "capturing",
      route: options.route ?? "e2e",
      inputItemId: null,
      responseId: null,
      playbackId: null,
      outputOwner: "none",
      transcript: normalizeRuntimeText(options.transcript ?? ""),
      assistantText: "",
      nativeAudioStarted: false,
      nativeAudioDone: false,
      modelDone: false,
      playbackDrained: false,
      startedAt: now,
      updatedAt: now,
      settledAt: null,
      terminalReason: null,
      abortController: new AbortController()
    };
    const before = stateLabel(this.state);
    this.state = {
      ...this.state,
      generation,
      currentTurn: turn,
      lastErrorCode: null
    };
    this.record("turn.started", before, stateLabel(this.state), turn, {
      textLength: turn.transcript.length
    });
    this.assertInvariants();
    return cloneRuntimeTurn(turn);
  }

  transitionTurn(to: VoiceRuntimeTurnPhase, eventType = `turn.${to}`): VoiceRuntimeTurn {
    const current = this.requireActiveTurn();
    if (!TURN_TRANSITIONS[current.phase].includes(to)) {
      throw new Error(`[VoiceRuntime] Illegal turn transition: ${current.phase} -> ${to}`);
    }
    if (isTerminalTurnPhase(to)) {
      this.settleCurrentTurn(to, eventType);
      return cloneRuntimeTurn(this.requireCurrentTurn());
    }

    const before = stateLabel(this.state);
    const next = {
      ...current,
      phase: to,
      updatedAt: this.now()
    };
    this.state = { ...this.state, currentTurn: next };
    this.record(eventType, before, stateLabel(this.state), next);
    this.assertInvariants();
    return cloneRuntimeTurn(next);
  }

  setRoute(route: VoiceRuntimeTurnRoute): VoiceRuntimeTurn {
    const current = this.requireActiveTurn();
    const before = stateLabel(this.state);
    const next = {
      ...current,
      route,
      updatedAt: this.now()
    };
    this.state = { ...this.state, currentTurn: next };
    this.record("turn.route.selected", before, stateLabel(this.state), next);
    this.assertInvariants();
    return cloneRuntimeTurn(next);
  }

  updateTranscript(text: string): VoiceRuntimeTurn {
    const current = this.requireActiveTurn();
    const transcript = normalizeRuntimeText(text);
    const before = stateLabel(this.state);
    const next = {
      ...current,
      transcript,
      updatedAt: this.now()
    };
    this.state = { ...this.state, currentTurn: next };
    this.record("turn.transcript.updated", before, stateLabel(this.state), next, {
      textLength: transcript.length
    });
    return cloneRuntimeTurn(next);
  }

  updateAssistantText(text: string): VoiceRuntimeTurn {
    const current = this.requireActiveTurn();
    const assistantText = normalizeRuntimeText(text);
    const before = stateLabel(this.state);
    const next = {
      ...current,
      assistantText,
      updatedAt: this.now()
    };
    this.state = { ...this.state, currentTurn: next };
    this.record("turn.assistant_text.updated", before, stateLabel(this.state), next, {
      textLength: assistantText.length
    });
    return cloneRuntimeTurn(next);
  }

  bindInputItem(inputItemId: string): VoiceRuntimeTurn {
    return this.bindIdentity("inputItemId", inputItemId, "turn.input_item.bound");
  }

  bindResponse(responseId: string): VoiceRuntimeTurn {
    return this.bindIdentity("responseId", responseId, "turn.response.bound");
  }

  retryResponse(previousResponseId: string, responseId: string): VoiceRuntimeTurn {
    const current = this.requireActiveTurn();
    const previous = previousResponseId.trim();
    const nextId = responseId.trim();
    if (current.route !== "e2e" || !previous || current.responseId !== previous
      || !nextId || nextId === previous || this.retiredResponseIds.has(nextId)
      || current.nativeAudioStarted || current.modelDone) {
      throw new Error("[VoiceRuntime] Invalid response retry");
    }
    const before = stateLabel(this.state);
    this.rememberRetiredResponse(previous);
    const next = { ...current, responseId: nextId, updatedAt: this.now() };
    this.state = { ...this.state, currentTurn: next };
    this.record("turn.response.retried", before, stateLabel(this.state), next);
    this.assertInvariants();
    return cloneRuntimeTurn(next);
  }

  continueToolResponse(previousResponseId: string, responseId: string, callIds: readonly string[]): VoiceRuntimeTurn {
    const current = this.requireActiveTurn();
    const previous = previousResponseId.trim();
    const nextId = responseId.trim();
    if (current.route !== "e2e" || !previous || current.responseId !== previous
      || !nextId || nextId === previous || this.retiredResponseIds.has(nextId)
      || callIds.length === 0 || callIds.some((id) => !id.trim())) {
      throw new Error("[VoiceRuntime] Invalid tool response continuation");
    }
    const before = stateLabel(this.state);
    this.rememberRetiredResponse(previous);
    const next = {
      ...current,
      responseId: nextId,
      nativeAudioDone: false,
      modelDone: false,
      playbackDrained: false,
      updatedAt: this.now()
    };
    this.state = { ...this.state, currentTurn: next };
    this.record("turn.tool_response.continued", before, stateLabel(this.state), next);
    this.assertInvariants();
    return cloneRuntimeTurn(next);
  }

  bindPlayback(playbackId: string): VoiceRuntimeTurn {
    return this.bindIdentity("playbackId", playbackId, "turn.playback.bound");
  }

  selectOutputOwner(outputOwner: VoiceRuntimeOutputOwner): VoiceRuntimeTurn {
    const current = this.requireActiveTurn();
    const before = stateLabel(this.state);
    const next = {
      ...current,
      outputOwner,
      playbackDrained: false,
      updatedAt: this.now()
    };
    this.state = { ...this.state, currentTurn: next };
    this.record("turn.output.selected", before, stateLabel(this.state), next);
    this.assertInvariants();
    return cloneRuntimeTurn(next);
  }

  markNativeAudioStarted(): VoiceRuntimeTurn {
    return this.markTurnFlag("nativeAudioStarted", "turn.native_audio.started", true);
  }

  markNativeAudioDone(): VoiceRuntimeTurn {
    return this.markTurnFlag("nativeAudioDone", "turn.native_audio.done");
  }

  markModelDone(): VoiceRuntimeTurn {
    return this.markTurnFlag("modelDone", "turn.model.done");
  }

  markPlaybackDrained(): VoiceRuntimeTurn {
    return this.markTurnFlag("playbackDrained", "turn.playback.drained");
  }

  accepts(identity: VoiceRuntimeCallbackIdentity): boolean {
    const current = this.state.currentTurn;
    if (!current || isTerminalTurnPhase(current.phase)) return false;
    if (identity.generation !== current.generation || identity.turnId !== current.turnId) return false;
    if (identity.responseId && identity.responseId !== current.responseId) return false;
    if (identity.playbackId && identity.playbackId !== current.playbackId) return false;
    return true;
  }

  complete(reason = "turn_completed"): boolean {
    return this.settleCurrentTurn("completed", reason);
  }

  interrupt(reason = "user_interrupted"): boolean {
    return this.settleCurrentTurn("interrupted", reason);
  }

  fail(errorCode = "voice_turn_failed"): boolean {
    return this.settleCurrentTurn("failed", errorCode);
  }

  queueInput(text: string, options: QueueVoiceRuntimeInputOptions = {}): VoiceRuntimeQueuedInput | null {
    const normalized = normalizeRuntimeText(text);
    if (!normalized) return null;
    const queued: VoiceRuntimeQueuedInput = {
      id: options.id ?? this.createId("voice-input"),
      text: normalized,
      priority: options.priority ?? "normal",
      createdAt: this.now()
    };
    const before = stateLabel(this.state);
    const queue = this.state.inputQueue.slice();
    if (queued.priority === "interrupt") {
      const firstNormal = queue.findIndex((input) => input.priority === "normal");
      if (firstNormal >= 0) queue.splice(firstNormal, 0, queued);
      else queue.push(queued);
    } else {
      queue.push(queued);
    }
    this.state = { ...this.state, inputQueue: queue };
    this.record("input.queued", before, stateLabel(this.state), this.state.currentTurn, {
      textLength: normalized.length
    });
    return { ...queued };
  }

  dequeueInput(): VoiceRuntimeQueuedInput | null {
    if (this.state.sessionPhase !== "listening") return null;
    if (this.state.currentTurn && !isTerminalTurnPhase(this.state.currentTurn.phase)) return null;
    const [next, ...rest] = this.state.inputQueue;
    if (!next) return null;
    const before = stateLabel(this.state);
    this.state = { ...this.state, inputQueue: rest };
    this.record("input.dequeued", before, stateLabel(this.state), this.state.currentTurn, {
      textLength: next.text.length
    });
    return { ...next };
  }

  stop(): void {
    if (this.state.sessionPhase === "stopped") return;
    this.settleCurrentTurn("interrupted", "session_stopping");
    if (this.state.sessionPhase !== "stopping") {
      this.transitionSession("stopping", "session.stopping");
    }
    const before = stateLabel(this.state);
    this.state = {
      ...this.state,
      sessionPhase: "stopped",
      inputQueue: []
    };
    this.record("session.stopped", before, stateLabel(this.state), this.state.currentTurn);
    this.assertInvariants();
  }

  assertInvariants(): void {
    const failures = voiceRuntimeInvariantFailures(this.state);
    if (failures.length > 0) {
      throw new Error(`[VoiceRuntime] Invariant failed: ${failures.join("; ")}`);
    }
  }

  private transitionSession(
    to: VoiceRuntimeSessionPhase,
    eventType: string,
    errorCode?: string
  ): void {
    const from = this.state.sessionPhase;
    if (!SESSION_TRANSITIONS[from].includes(to)) {
      throw new Error(`[VoiceRuntime] Illegal session transition: ${from} -> ${to}`);
    }
    const before = stateLabel(this.state);
    this.state = {
      ...this.state,
      sessionPhase: to,
      lastErrorCode: errorCode ?? (to === "listening" ? null : this.state.lastErrorCode)
    };
    this.record(eventType, before, stateLabel(this.state), this.state.currentTurn, { errorCode });
    this.assertInvariants();
  }

  private settleCurrentTurn(phase: VoiceRuntimeTerminalPhase, reason: string): boolean {
    const current = this.state.currentTurn;
    if (!current || isTerminalTurnPhase(current.phase)) return false;

    const before = stateLabel(this.state);
    const now = this.now();
    const settled: VoiceRuntimeTurn = {
      ...current,
      phase,
      updatedAt: now,
      settledAt: now,
      terminalReason: reason
    };
    this.state = {
      ...this.state,
      currentTurn: settled,
      lastErrorCode: phase === "failed" ? reason : this.state.lastErrorCode
    };
    current.abortController.abort(reason);
    this.record(`turn.${phase}`, before, stateLabel(this.state), settled, {
      latencyMs: Math.max(0, now - settled.startedAt),
      errorCode: phase === "failed" ? reason : undefined
    });
    this.assertInvariants();
    return true;
  }

  private bindIdentity(
    key: "inputItemId" | "responseId" | "playbackId",
    value: string,
    eventType: string
  ): VoiceRuntimeTurn {
    const current = this.requireActiveTurn();
    const normalized = value.trim();
    if (!normalized) throw new Error(`[VoiceRuntime] ${key} cannot be empty`);
    const existing = current[key];
    if (existing && existing !== normalized) {
      throw new Error(`[VoiceRuntime] ${key} is already bound to ${existing}`);
    }
    if (existing === normalized) return cloneRuntimeTurn(current);

    const before = stateLabel(this.state);
    const next = {
      ...current,
      [key]: normalized,
      updatedAt: this.now()
    };
    this.state = { ...this.state, currentTurn: next };
    this.record(eventType, before, stateLabel(this.state), next);
    this.assertInvariants();
    return cloneRuntimeTurn(next);
  }

  private rememberRetiredResponse(id: string): void {
    if (this.retiredResponseIds.has(id)) return;
    if (this.retiredResponseIds.size >= 512) this.retiredResponseIds.delete(this.retiredResponseIds.values().next().value!);
    this.retiredResponseIds.add(id);
  }

  private markTurnFlag(
    key: "nativeAudioStarted" | "nativeAudioDone" | "modelDone" | "playbackDrained",
    eventType: string,
    includeLatency = false
  ): VoiceRuntimeTurn {
    const current = this.requireActiveTurn();
    if (current[key]) return cloneRuntimeTurn(current);
    const before = stateLabel(this.state);
    const next = {
      ...current,
      [key]: true,
      updatedAt: this.now()
    };
    this.state = { ...this.state, currentTurn: next };
    this.record(eventType, before, stateLabel(this.state), next, includeLatency ? {
      latencyMs: Math.max(0, next.updatedAt - next.startedAt)
    } : {});
    return cloneRuntimeTurn(next);
  }

  private requireCurrentTurn(): VoiceRuntimeTurn {
    if (!this.state.currentTurn) throw new Error("[VoiceRuntime] No current turn");
    return this.state.currentTurn;
  }

  private requireActiveTurn(): VoiceRuntimeTurn {
    const current = this.requireCurrentTurn();
    if (isTerminalTurnPhase(current.phase)) {
      throw new Error(`[VoiceRuntime] Turn ${current.turnId} is already ${current.phase}`);
    }
    return current;
  }

  private record(
    eventType: string,
    stateBefore: string,
    stateAfter: string,
    turn: VoiceRuntimeTurn | null,
    extra: Partial<Pick<VoiceRuntimeEvent, "latencyMs" | "errorCode" | "textLength">> = {}
  ): void {
    this.journal.record({
      timestamp: this.now(),
      sessionId: this.state.sessionId,
      generation: turn?.generation ?? this.state.generation,
      ...(turn?.turnId ? { turnId: turn.turnId } : {}),
      provider: this.provider,
      ...(turn?.route ? { route: turn.route } : {}),
      eventType,
      ...(turn?.responseId ? { responseId: turn.responseId } : {}),
      ...(turn?.playbackId ? { playbackId: turn.playbackId } : {}),
      stateBefore,
      stateAfter,
      ...extra
    });
  }
}

export function isTerminalTurnPhase(
  phase: VoiceRuntimeTurnPhase
): phase is VoiceRuntimeTerminalPhase {
  return TERMINAL_TURN_PHASES.has(phase);
}

export function voiceRuntimeInvariantFailures(state: VoiceRuntimeSnapshot): string[] {
  const failures: string[] = [];
  const turn = state.currentTurn;
  if (state.generation < 0 || !Number.isInteger(state.generation)) {
    failures.push("generation must be a non-negative integer");
  }
  if (turn) {
    if (turn.generation !== state.generation) failures.push("current turn generation must match session generation");
    if (!turn.turnId.trim()) failures.push("current turn id cannot be empty");
    if (turn.settledAt !== null && !isTerminalTurnPhase(turn.phase)) {
      failures.push("only terminal turns can have settledAt");
    }
    if (isTerminalTurnPhase(turn.phase) && turn.settledAt === null) {
      failures.push("terminal turn must have settledAt");
    }
    if (isTerminalTurnPhase(turn.phase) && !turn.abortController.signal.aborted) {
      failures.push("terminal turn must abort its pipeline");
    }
    if (!isTerminalTurnPhase(turn.phase) && turn.abortController.signal.aborted) {
      failures.push("active turn pipeline cannot already be aborted");
    }
  }
  if (state.sessionPhase === "stopped" && state.inputQueue.length > 0) {
    failures.push("stopped session cannot retain queued input");
  }
  return failures;
}

function cloneRuntimeTurn(turn: VoiceRuntimeTurn): VoiceRuntimeTurn {
  return { ...turn };
}

function stateLabel(state: VoiceRuntimeSnapshot): string {
  return state.currentTurn
    ? `${state.sessionPhase}/${state.currentTurn.phase}`
    : `${state.sessionPhase}/none`;
}

function normalizeRuntimeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function sanitizeRuntimeEvent(event: VoiceRuntimeEvent): VoiceRuntimeEvent {
  return {
    timestamp: finiteNonNegative(event.timestamp),
    sessionId: sanitizeIdentifier(event.sessionId, "unknown-session"),
    generation: Math.max(0, Math.trunc(finiteNonNegative(event.generation))),
    ...(event.turnId ? { turnId: sanitizeIdentifier(event.turnId, "unknown-turn") } : {}),
    ...(event.provider ? { provider: sanitizeIdentifier(event.provider, "unknown") } : {}),
    ...(event.providerTraceId && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(event.providerTraceId) ? { providerTraceId: event.providerTraceId } : {}),
    ...(event.route ? { route: event.route } : {}),
    eventType: sanitizeIdentifier(event.eventType, "unknown-event"),
    ...(event.responseId ? { responseId: sanitizeIdentifier(event.responseId, "unknown-response") } : {}),
    ...(event.playbackId ? { playbackId: sanitizeIdentifier(event.playbackId, "unknown-playback") } : {}),
    stateBefore: sanitizeIdentifier(event.stateBefore, "unknown"),
    stateAfter: sanitizeIdentifier(event.stateAfter, "unknown"),
    ...(event.latencyMs === undefined ? {} : { latencyMs: finiteNonNegative(event.latencyMs) }),
    ...(event.errorCode ? { errorCode: sanitizeIdentifier(event.errorCode, "voice_error") } : {}),
    ...(event.textLength === undefined ? {} : { textLength: Math.max(0, Math.trunc(finiteNonNegative(event.textLength))) })
  };
}

function sanitizeIdentifier(value: string, fallback: string): string {
  const sanitized = value
    .replace(/[^\p{L}\p{N}._:/-]+/gu, "_")
    .slice(0, 160);
  return sanitized || fallback;
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function defaultRuntimeId(prefix: string): string {
  const random = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  return `${prefix}-${random}`;
}
