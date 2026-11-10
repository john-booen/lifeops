export type VoicePhase =
  | "idle"
  | "warming"
  | "listening"
  | "processing"
  | "speaking"
  | "stopping"
  | "error";

export type VoiceInputSource = "voice" | "text";
export type VoiceInputPriority = "normal" | "interrupt";

export interface QueuedVoiceInput {
  id: string;
  text: string;
  source: VoiceInputSource;
  turnId: string;
  createdAt: string;
  priority: VoiceInputPriority;
  serverFinal?: true;
}

export interface VoiceSessionState {
  phase: VoicePhase;
  generation: number;
  currentTurnId: string | null;
  turnText: string;
  inputQueue: QueuedVoiceInput[];
  lastError: string | null;
  sentTurnTexts: Set<string>;
}

export interface BeginNewTurnOptions {
  turnId?: string;
  resetQueue?: boolean;
}

export interface EchoMemory {
  text: string;
  normalizedText: string;
  expiresAt: number;
  source: "tts" | "assistant";
}

export type VoiceTurnDecision = "idle" | "hold" | "duplicate" | "queue" | "send";
export type VoiceControlEventKind = "repair_keep_listening";

export interface VoiceTurnReadinessInput {
  mode: "voice" | "text";
  recording: boolean;
  busy: boolean;
  text: string;
  visibleText?: string;
  recentDuplicate: boolean;
  alreadySent: boolean;
}

export interface VoiceTurnReadiness {
  decision: VoiceTurnDecision;
  reason: string;
}

export interface AssistantSpeechSuppressionInput {
  queueLength: number;
  interruptedWhileBusy: boolean;
}

export interface LocalVoiceEndpointInput extends VoiceTurnReadinessInput {
  silenceMs: number;
  minSilenceMs?: number;
}

export interface VoiceControlEvent {
  kind: VoiceControlEventKind;
  reply: string;
  signature: string;
}

export interface VoiceControlHoldInput {
  text: string;
  heldSignature: string;
  nowMs: number;
  holdUntilMs: number;
  minGrowthChars?: number;
}

export interface VoiceSpeechStartInput {
  agentBusy: boolean;
  assistantSpeaking: boolean;
  nowMs: number;
  ignoreUntilMs: number;
}

export interface AssistantTranscriptInterruptionInput {
  assistantSpeaking: boolean;
  transcript: string;
  controlEvent?: boolean;
}

export const VALID_TRANSITIONS: Readonly<Record<VoicePhase, readonly VoicePhase[]>> = {
  idle: ["warming"],
  warming: ["listening", "idle", "stopping", "error"],
  listening: ["processing", "idle", "stopping", "error"],
  processing: ["speaking", "listening", "idle", "stopping", "error"],
  speaking: ["listening", "idle", "stopping", "error"],
  stopping: ["idle", "error"],
  error: ["idle"]
};

export const DEFAULT_ECHO_TTL_MS = 10_000;
export const ECHO_OVERLAP_THRESHOLD = 0.5;
export const VOICE_ENDPOINT_DELAYS = {
  quickMs: 2200,
  normalMs: 3600,
  shortFragmentMs: 6500,
  longMs: 5200,
  maxMs: 8000
};

export const LOCAL_VOICE_ENDPOINT_MIN_SILENCE_MS = 2200;

const echoMemories: EchoMemory[] = [];

export function createVoiceSession(): VoiceSessionState {
  return {
    phase: "idle",
    generation: 0,
    currentTurnId: null,
    turnText: "",
    inputQueue: [],
    lastError: null,
    sentTurnTexts: new Set()
  };
}

export function canTransition(from: VoicePhase, to: VoicePhase): boolean {
  return VALID_TRANSITIONS[from].includes(to);
}

export function transition(session: VoiceSessionState, to: VoicePhase, reason?: string): VoiceSessionState {
  if (!canTransition(session.phase, to)) {
    throw new Error(
      `[VoiceSession] Illegal transition: ${session.phase} -> ${to}` +
        (reason ? ` (${reason})` : "")
    );
  }

  return {
    ...session,
    phase: to,
    lastError: to === "error" ? reason ?? "Unknown voice session error" : to === "idle" ? null : session.lastError,
    currentTurnId: to === "idle" ? null : session.currentTurnId,
    turnText: to === "idle" ? "" : session.turnText
  };
}

export function beginNewTurn(
  session: VoiceSessionState,
  options: BeginNewTurnOptions = {}
): VoiceSessionState {
  return {
    ...session,
    generation: session.generation + 1,
    currentTurnId: options.turnId ?? createTurnId(),
    turnText: "",
    inputQueue: options.resetQueue ? [] : session.inputQueue
  };
}

export function appendTurnText(session: VoiceSessionState, delta: string): VoiceSessionState {
  return {
    ...session,
    turnText: mergeTurnText(session.turnText, delta)
  };
}

export function finalizeTurn(session: VoiceSessionState, text = session.turnText): VoiceSessionState {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) return session;
  const sentTurnTexts = new Set(session.sentTurnTexts);
  sentTurnTexts.add(cleaned);
  return { ...session, sentTurnTexts };
}

export function enqueueInput(
  session: VoiceSessionState,
  input: Omit<QueuedVoiceInput, "id" | "createdAt">
): VoiceSessionState {
  const text = input.text.replace(/\s+/g, " ").trim();
  if (!text) return session;
  const queued: QueuedVoiceInput = {
    ...input,
    text,
    id: createQueueId(),
    createdAt: new Date().toISOString()
  };
  return {
    ...session,
    inputQueue: [...session.inputQueue, queued]
  };
}

export function dequeueInput(session: VoiceSessionState): {
  session: VoiceSessionState;
  next: QueuedVoiceInput | null;
} {
  const [next, ...rest] = session.inputQueue;
  if (!next) return { session, next: null };
  return {
    session: { ...session, inputQueue: rest },
    next
  };
}

export function isStaleCallback(
  session: VoiceSessionState,
  generation: number,
  turnId?: string | null
): boolean {
  if (generation !== session.generation) return true;
  if (turnId && turnId !== session.currentTurnId) return true;
  return false;
}

export function isAlreadySent(session: VoiceSessionState, text: string): boolean {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) return true;
  const comparableCleaned = comparableText(cleaned);
  if (!comparableCleaned) return true;

  for (const sent of session.sentTurnTexts) {
    const comparableSent = comparableText(sent);
    if (!comparableSent) continue;
    if (sent === cleaned || comparableSent === comparableCleaned) return true;
    const shorterLength = Math.min(comparableSent.length, comparableCleaned.length);
    if (
      shorterLength <= 5
      && shorterLength >= 2
      && (comparableSent.includes(comparableCleaned) || comparableCleaned.includes(comparableSent))
    ) {
      return true;
    }
    if (comparableSent.includes(comparableCleaned) || comparableCleaned.includes(comparableSent)) {
      const overlapRatio = shorterLength / Math.max(comparableSent.length, comparableCleaned.length);
      if (overlapRatio >= 0.8) return true;
    }
  }

  return false;
}

export function addEchoText(
  text: string,
  ttlMs = DEFAULT_ECHO_TTL_MS,
  source: EchoMemory["source"] = "tts"
): void {
  const trimmed = text.replace(/\s+/g, " ").trim();
  const normalizedText = normalizeEchoText(trimmed);
  if (!normalizedText) return;

  echoMemories.push({
    text: trimmed,
    normalizedText,
    expiresAt: Date.now() + ttlMs,
    source
  });

  if (echoMemories.length > 20) {
    echoMemories.splice(0, echoMemories.length - 20);
  }
}

export function isEchoTranscript(transcript: string, now = Date.now()): boolean {
  pruneExpired(now);
  const normalizedTranscript = normalizeEchoText(transcript);

  if (!normalizedTranscript) return true;

  for (const memory of echoMemories) {
    if (memory.normalizedText === normalizedTranscript) return true;
    if (normalizedTranscript.length === 1) continue;
    if (memory.normalizedText.includes(normalizedTranscript)) return true;
    if (normalizedTranscript.includes(memory.normalizedText)) return true;
    if (charOverlapRatio(memory.normalizedText, normalizedTranscript) > ECHO_OVERLAP_THRESHOLD) {
      return true;
    }
  }

  return false;
}

export function clearEchoMemories(): void {
  echoMemories.length = 0;
}

export function pruneExpired(now = Date.now()): void {
  for (let index = echoMemories.length - 1; index >= 0; index -= 1) {
    if (echoMemories[index].expiresAt <= now) {
      echoMemories.splice(index, 1);
    }
  }
}

export function charOverlapRatio(a: string, b: string): number {
  const setA = new Set(Array.from(normalizeEchoText(a)));
  const setB = new Set(Array.from(normalizeEchoText(b)));
  if (setA.size === 0 || setB.size === 0) return 0;

  let overlap = 0;
  for (const char of setA) {
    if (setB.has(char)) overlap += 1;
  }

  return overlap / Math.min(setA.size, setB.size);
}

export function voiceEndpointDelayMs(text: string): number {
  const value = text.replace(/\s+/g, " ").trim();
  if (!value) return 0;
  if (isVoiceHoldOnlyTurn(value)) return VOICE_ENDPOINT_DELAYS.maxMs;

  const length = Array.from(value.replace(/\s+/g, "")).length;
  const incomplete = looksIncompleteVoiceTurn(value);
  const fastComplete = looksFastCompleteVoiceTurn(value);
  const complete = fastComplete || looksCompleteVoiceTurn(value);

  if (!complete && looksLikeShortUnfinishedFragment(value)) return VOICE_ENDPOINT_DELAYS.shortFragmentMs;
  if (incomplete) return VOICE_ENDPOINT_DELAYS.longMs;
  if (length <= 18 && fastComplete) return VOICE_ENDPOINT_DELAYS.quickMs;
  if (length <= 18 && complete) return 3200;
  if (length <= 32 && complete) return 3600;
  if (length >= 90) return complete ? 3800 : VOICE_ENDPOINT_DELAYS.longMs;
  if (length >= 55 && !complete) return VOICE_ENDPOINT_DELAYS.longMs;
  if (length >= 55) return 3800;
  if (!complete && length >= 28) return 4200;
  return VOICE_ENDPOINT_DELAYS.normalMs;
}

export function isVoiceBackchannelOnly(text: string): boolean {
  const value = normalizeComparableVoiceTurn(text);
  if (!value) return false;
  return /^(嗯+|呃+|额+|啊+|哦+|噢+|喔+|对+|是+|好+|行+|可以+|ok+|okay+|yes+|yeah+)$/iu.test(value);
}

export function isVoiceHoldOnlyTurn(text: string): boolean {
  const value = normalizeComparableVoiceTurn(text);
  if (!value) return false;
  if (isVoiceBackchannelOnly(value)) return true;
  return /^(我想一下|我想想|怎么说呢|不是不是|不对不对|等我一下)$/u.test(value);
}

export function isVoiceClearlyIncompleteTurn(text: string): boolean {
  const value = text.replace(/\s+/g, " ").trim();
  if (!value || isVoiceHoldOnlyTurn(value)) return true;
  return looksIncompleteVoiceTurn(value) || looksLikeShortUnfinishedFragment(value);
}

export function isVoiceLikelyCompleteTurn(text: string): boolean {
  const value = text.replace(/\s+/g, " ").trim();
  if (!value || isVoiceHoldOnlyTurn(value)) return false;
  return looksCompleteVoiceTurn(value) && !looksIncompleteVoiceTurn(value);
}

export function mergeVoiceTurnText(existing: string, incoming: string): string {
  return mergeTurnText(existing, incoming);
}

export function decideVoiceTurnReadiness(input: VoiceTurnReadinessInput): VoiceTurnReadiness {
  const text = input.text.trim();
  const visibleText = (input.visibleText ?? text).trim();
  if (input.mode !== "voice" || !text) return { decision: "idle", reason: "no_voice_text" };
  if (isVoiceHoldOnlyTurn(visibleText || text)) return { decision: "hold", reason: "hold_only_turn" };
  if (input.recentDuplicate || input.alreadySent) return { decision: "duplicate", reason: "duplicate_turn" };
  if (input.busy) return { decision: "queue", reason: "agent_busy" };
  if (!input.recording) return { decision: "idle", reason: "not_recording" };
  return { decision: "send", reason: "ready" };
}

export function decideLocalVoiceEndpoint(input: LocalVoiceEndpointInput): VoiceTurnReadiness {
  const minSilenceMs = input.minSilenceMs ?? LOCAL_VOICE_ENDPOINT_MIN_SILENCE_MS;
  const text = input.text.trim();
  const visibleText = (input.visibleText ?? text).trim();
  if (input.silenceMs < minSilenceMs) return { decision: "idle", reason: "local_silence_too_short" };
  if (!isVoiceLikelyCompleteTurn(visibleText || text) || isVoiceClearlyIncompleteTurn(visibleText || text)) {
    return { decision: "hold", reason: "local_endpoint_incomplete_turn" };
  }
  return decideVoiceTurnReadiness(input);
}

export function shouldSuppressAssistantSpeechForQueue(queueLength: number): boolean {
  return queueLength > 0;
}

export function shouldSuppressAssistantSpeech(input: AssistantSpeechSuppressionInput): boolean {
  return input.queueLength > 0 || input.interruptedWhileBusy;
}

export function shouldIgnoreVoiceSpeechStart(input: VoiceSpeechStartInput): boolean {
  if (input.assistantSpeaking) return true;
  if (input.nowMs >= input.ignoreUntilMs) return false;
  return input.agentBusy;
}

export function shouldInterruptAssistantForTranscript(input: AssistantTranscriptInterruptionInput): boolean {
  if (!input.assistantSpeaking) return false;
  const transcript = input.transcript.replace(/\s+/g, " ").trim();
  if (!transcript) return false;
  if (input.controlEvent) return true;
  return !isVoiceHoldOnlyTurn(transcript);
}

export function detectVoiceControlEvent(text: string): VoiceControlEvent | null {
  const value = text.replace(/\s+/g, " ").trim();
  if (!value) return null;
  const comparable = comparableVoiceRuntimeText(value);
  if (!comparable) return null;
  if (
    /(我还没说完|还没说完|没说完|别打断|先别说|你别说|等一下|等下|等等|喂.{0,6}(能听到|听得到|听得见)|能听到我|听得到我|听得到吗|听得见吗|你干啥|你在干嘛|卡住|又卡|不是我跟你说话|我跟你说话呢)/u.test(value)
    || /(我还没说完|还没说完|没说完|别打断|先别说|你别说|等一下|等下|等等|喂.{0,6}(能听到|听得到|听得见)|能听到我|听得到我|听得到吗|听得见吗|你干啥|你在干嘛|卡住|又卡|不是我跟你说话|我跟你说话呢)/u.test(comparable)
  ) {
    return {
      kind: "repair_keep_listening",
      reply: "我在，刚才我先不抢。你继续说，我听着。",
      signature: comparable
    };
  }
  return null;
}

export function shouldHoldVoiceTurnForControl(input: VoiceControlHoldInput): boolean {
  const held = input.heldSignature;
  if (!held) return false;
  const current = comparableVoiceRuntimeText(input.text);
  if (!current) return false;
  const substantiveRemainder = stripVoiceControlPhrases(input.text);
  if (substantiveRemainder && !isVoiceHoldOnlyTurn(substantiveRemainder)) return false;
  if (current === held || held.includes(current)) return true;
  if (input.nowMs < input.holdUntilMs && (current.includes(held) || held.includes(current))) return true;
  if (detectVoiceControlEvent(input.text) && input.nowMs < input.holdUntilMs) return true;

  const minGrowthChars = input.minGrowthChars ?? 8;
  const heldIndex = current.indexOf(held);
  if (heldIndex >= 0) {
    const growth = current.length - held.length;
    return growth < minGrowthChars;
  }
  return false;
}

export function stripVoiceControlPhrases(text: string): string {
  return text
    .replace(/喂[，,。.!！?？、\s]*(?=能听到|听得到|听得见)/gu, " ")
    .replace(/(我还没说完吧?应该是?|我还没说完吧?|还没说完吧?|没说完|别打断|先别说|你别说|等一下|等下|等等|能听到我说话吗|能听到我吗|能听到吗|听得到我吗|听得到吗|听得见吗|你干啥呢?|你在干嘛|卡住了?|又卡住了?|又卡|不是我跟你说话呢?|我跟你说话呢)/gu, " ")
    .replace(/[，,。.!！?？、;；:：]\s*[，,。.!！?？、;；:：]+/g, " ")
    .replace(/^[，,。.!！?？、;；:：\s]+|[，,。.!！?？、;；:：\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function createTurnId(): string {
  return `turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function createQueueId(): string {
  return `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function mergeTurnText(existing: string, incoming: string): string {
  const base = normalizeText(existing);
  const next = normalizeText(incoming);
  if (!base) return next;
  if (!next) return base;

  const comparableBase = comparableText(base);
  const comparableNext = comparableText(next);
  if (!comparableNext) return base;
  if (!comparableBase) return next;
  if (comparableNext.includes(comparableBase) && next.length >= base.length) return next;
  if (comparableBase.includes(comparableNext)) return base;

  return `${base} ${next}`.replace(/\s+/g, " ").trim();
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function normalizeEchoText(text: string): string {
  return comparableText(text);
}

function looksIncompleteVoiceTurn(text: string): boolean {
  const value = text.replace(/\s+/g, "").replace(/[。.!！?？]+$/u, "");
  if (!value) return false;
  return /(然后|然后呢|但是|可是|不过|因为|所以|比如|比如说|我觉得|我想|我想说|我还想说|我想问|我想把|我要|我需要|我不是|不是我|不是你|不是说|不是让|不是要|不要|不需要|不用|还有|还有一个问题|第一|第一点|第二|第二点|首先|接下来|另外|刚才|其实|就是|这个|那个|包括|如果|假如|等一下|我先想想|怎么说|到底|到底要不要|要不要|要不要现在|现在|不应|不应该)$/u.test(value)
    || /(帮我|给我|请)?(把|将)?(这个|那个|这条|那条|这件|那件|这|那).{1,30}的$/u.test(value)
    || /(我|你|他|她|它|这个|那个|这条|那条|任务|习惯)?.{0,18}(修|删|改|搞|弄|做|处理|写|记|记录)$/u.test(value)
    || /^我.*(在想|想想|考虑|纠结|犹豫)(啊|呢)?$/u.test(value)
    || /(要不要|该不该|怎么办|怎么选).{0,8}$/u.test(value);
}

function looksLikeShortUnfinishedFragment(text: string): boolean {
  const value = text.replace(/\s+/g, "").replace(/[。.!！?？]+$/u, "");
  if (!value) return false;
  const length = Array.from(value).length;
  if (/^(不是|不对|没有|不要|不用|别|不是我|不是你|你不是|我想|我要|我说|这个|那个|其实|就是|到底|要不要|现在)$/u.test(value)) {
    return true;
  }
  if (length <= 4 && /^(不|没|别|我|你|这|那|其实|就是)/u.test(value)) {
    return true;
  }
  return length <= 3 && !looksCompleteVoiceTurn(text);
}

function looksCompleteVoiceTurn(text: string): boolean {
  const value = text.trim();
  if (/[。.!！?？]$/u.test(value)) return true;
  if (/(吗|么|呢|吧|呀|啊|嘛|了|的)$/u.test(value) && !looksIncompleteVoiceTurn(value)) return true;
  return looksFastCompleteVoiceTurn(value);
}

function looksFastCompleteVoiceTurn(text: string): boolean {
  const value = text.trim();
  if (/[?？]$/u.test(value) && Array.from(value.replace(/\s+/g, "")).length <= 18) return true;
  if (/^(你好|在吗|听得到|测试一下|继续)$/u.test(value.replace(/\s+/g, ""))) return true;
  return false;
}

function normalizeComparableVoiceTurn(text: string): string {
  return comparableText(text.replace(/[。.!！?？,，;；:：、~～\s]+$/g, ""));
}

function comparableVoiceRuntimeText(text: string): string {
  return comparableText(text);
}

function comparableText(text: string): string {
  return Array.from(text)
    .filter((char) => /[\p{L}\p{N}]/u.test(char))
    .join("")
    .toLocaleLowerCase();
}
