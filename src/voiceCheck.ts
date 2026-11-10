import type { AgentConversationMessage, AgentResponse } from "./types";
import { VoiceBargeInController } from "./voice/voiceBargeIn";
import {
  VoiceSessionController,
  voiceRuntimeInvariantFailures
} from "./voice/voiceRuntime";
import {
  beginNewTurn,
  createVoiceSession,
  decideLocalVoiceEndpoint,
  decideVoiceTurnReadiness,
  dequeueInput,
  detectVoiceControlEvent,
  enqueueInput,
  finalizeTurn,
  shouldHoldVoiceTurnForControl,
  shouldSuppressAssistantSpeech,
  stripVoiceControlPhrases,
  transition
} from "./voiceSession";

export interface VoiceRuntimeSelfTestCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface VoiceRuntimeSelfTestReport {
  ok: boolean;
  ranAt: string;
  events: string[];
  checks: VoiceRuntimeSelfTestCheck[];
  summary: string;
}

export interface VoiceAgentSelfTestCaseResult {
  name: string;
  input: string;
  reply: string;
  actions: number;
  ok: boolean;
  failures: string[];
}

export interface VoiceAgentSelfTestReport {
  ok: boolean;
  ranAt: string;
  cases: VoiceAgentSelfTestCaseResult[];
  summary: string;
}

export type VoiceAgentSubmitter = (
  message: string,
  history: AgentConversationMessage[],
  onText: (content: string) => void
) => Promise<AgentResponse>;

export interface VoiceAgentSelfTestCase {
  name: string;
  input: string;
  require: RegExp[];
  forbid: RegExp[];
}

const CASES: VoiceAgentSelfTestCase[] = [
  {
    name: "casual companion voice",
    input: "今天还可以吧，想跟你随便聊聊",
    require: [/还可以|听着|想聊|聊|我在|随便|有空|想说就说|挺好|挺好的|安排也行/],
    forbid: [/待确认|创建任务|新建任务|任务面板|交易复盘|Obsidian|vault|日记模板|写入/]
  },
  {
    name: "interruption repair voice",
    input: "喂，能听到我说话吗？我还没说完吧，你刚才干啥呢",
    require: [/我在|在呢|在的|听到|听着|能听到/, /继续|你说|你接着说|不打断|先听/],
    forbid: [/待确认|创建任务|新建任务|任务面板|交易复盘|日报|总结|写入/]
  },
  {
    name: "task-flow correction voice",
    input: "又卡住了，我刚才不是让你创建任务，我只是想聊天",
    require: [/我在|听着|不创建|不会创建|聊天|陪你|不动|你聊|抢答|慢慢聊|不急|接活|反应过度|想聊|太急|自作聪明|聊呗|吐槽|听你的|就聊|不乱动|不是在下任务|下任务/],
    forbid: [/待确认|任务卡片|已创建|已经创建|马上创建|写入任务/]
  }
];

export function runVoiceRuntimeSelfTest(ranAt = new Date().toISOString()): VoiceRuntimeSelfTestReport {
  const events: string[] = [];
  const checks: VoiceRuntimeSelfTestCheck[] = [];
  let session = createVoiceSession();

  session = transition(session, "warming", "self-test start");
  events.push("phase:warming");
  session = transition(session, "listening", "self-test listening");
  events.push("phase:listening");
  session = beginNewTurn(session, { turnId: "self-test-turn-1" });
  events.push("begin:self-test-turn-1");

  const holdDecision = decideVoiceTurnReadiness({
    mode: "voice",
    recording: true,
    busy: false,
    text: "嗯",
    visibleText: "嗯",
    recentDuplicate: false,
    alreadySent: false
  });
  check(checks, "backchannel hold", holdDecision.decision === "hold", holdDecision.reason);

  const firstText = "今天还可以吧，我想跟你随便聊聊";
  const localEndpointDecision = decideLocalVoiceEndpoint({
    mode: "voice",
    recording: true,
    busy: false,
    text: "今天还可以吧",
    visibleText: "今天还可以吧",
    recentDuplicate: false,
    alreadySent: false,
    silenceMs: 2300
  });
  check(checks, "local endpoint sends complete turn", localEndpointDecision.decision === "send", localEndpointDecision.reason);

  const incompleteEndpointDecision = decideLocalVoiceEndpoint({
    mode: "voice",
    recording: true,
    busy: false,
    text: "但是我还想说",
    visibleText: "但是我还想说",
    recentDuplicate: false,
    alreadySent: false,
    silenceMs: 2300
  });
  check(checks, "local endpoint holds incomplete turn", incompleteEndpointDecision.decision === "hold", incompleteEndpointDecision.reason);

  const firstDecision = decideVoiceTurnReadiness({
    mode: "voice",
    recording: true,
    busy: false,
    text: firstText,
    visibleText: firstText,
    recentDuplicate: false,
    alreadySent: false
  });
  check(checks, "first turn sends", firstDecision.decision === "send", firstDecision.reason);
  session = finalizeTurn(session, firstText);
  events.push("finalize:self-test-turn-1");
  session = transition(session, "processing", "self-test first turn submitted");
  events.push("phase:processing");

  check(checks, "interrupt suppresses old speech", shouldSuppressAssistantSpeech({
    queueLength: session.inputQueue.length,
    interruptedWhileBusy: true
  }), "interrupted before transcript finalizes");
  events.push("suppress:interrupt-before-transcript");

  const interruptedText = "等一下，我还没说完，后面还有一句";
  const queuedDecision = decideVoiceTurnReadiness({
    mode: "voice",
    recording: true,
    busy: true,
    text: interruptedText,
    visibleText: interruptedText,
    recentDuplicate: false,
    alreadySent: false
  });
  check(checks, "busy speech queues", queuedDecision.decision === "queue", queuedDecision.reason);
  session = enqueueInput(session, {
    text: interruptedText,
    source: "voice",
    turnId: "self-test-turn-2",
    priority: "interrupt"
  });
  events.push("queue:self-test-turn-2");
  check(checks, "queued input suppresses old speech", shouldSuppressAssistantSpeech({
    queueLength: session.inputQueue.length,
    interruptedWhileBusy: false
  }), `queueLength=${session.inputQueue.length}`);

  session = transition(session, "listening", "self-test queued reply suppressed");
  events.push("phase:listening");
  const result = dequeueInput(session);
  session = result.session;
  check(checks, "queue consumes next input", result.next?.text === interruptedText && session.inputQueue.length === 0, result.next?.text ?? "missing");
  if (result.next) {
    session = beginNewTurn(session, { turnId: result.next.turnId, resetQueue: false });
    events.push(`begin:${result.next.turnId}`);
  }

  const controlText = "喂，能听到我说话吗？我还没说完吧";
  const controlEvent = detectVoiceControlEvent(controlText);
  check(checks, "repair control event detected before LLM", controlEvent?.kind === "repair_keep_listening", controlEvent?.kind ?? "none");
  check(checks, "repair control holds current turn", shouldHoldVoiceTurnForControl({
    text: controlText,
    heldSignature: controlEvent?.signature ?? "",
    nowMs: 1000,
    holdUntilMs: 5000
  }), controlEvent?.signature ?? "missing");
  check(checks, "repair control strips before recovered send", stripVoiceControlPhrases(`${controlText}，后面我想说今天状态其实还可以`) === "后面我想说今天状态其实还可以", stripVoiceControlPhrases(`${controlText}，后面我想说今天状态其实还可以`));

  let runtimeId = 0;
  const managedRuntime = new VoiceSessionController({
    provider: "self-test",
    createId: (prefix) => `${prefix}-${++runtimeId}`
  });
  managedRuntime.connect();
  managedRuntime.connected();
  check(checks, "managed runtime connects", managedRuntime.snapshot().sessionPhase === "listening", managedRuntime.snapshot().sessionPhase);
  events.push("managed-session:listening");

  managedRuntime.beginTurn({
    turnId: "managed-e2e-turn",
    route: "e2e",
    transcript: "第一轮普通对话"
  });
  managedRuntime.transitionTurn("endpointing");
  managedRuntime.transitionTurn("routing");
  managedRuntime.transitionTurn("generating");
  managedRuntime.bindResponse("managed-response-1");
  managedRuntime.bindPlayback("managed-playback-1");
  managedRuntime.markNativeAudioStarted();
  managedRuntime.selectOutputOwner("native-e2e");
  managedRuntime.updateAssistantText("第一轮语音回复");
  managedRuntime.markModelDone();
  managedRuntime.markNativeAudioDone();
  managedRuntime.markPlaybackDrained();
  managedRuntime.complete("self_test_e2e_complete");
  const completedE2e = managedRuntime.snapshot().currentTurn;
  check(
    checks,
    "managed e2e waits for model and playback",
    completedE2e?.phase === "completed"
      && completedE2e.modelDone
      && completedE2e.nativeAudioDone
      && completedE2e.playbackDrained,
    completedE2e?.phase ?? "missing"
  );
  events.push("managed-turn:e2e-completed");

  const cascadeTurn = managedRuntime.beginTurn({
    turnId: "managed-cascade-turn",
    route: "brain",
    transcript: "第二轮走备用主脑"
  });
  managedRuntime.transitionTurn("endpointing");
  managedRuntime.transitionTurn("routing");
  managedRuntime.transitionTurn("generating");
  let cascadeAborted = false;
  cascadeTurn.abortController.signal.addEventListener("abort", () => {
    cascadeAborted = true;
  }, { once: true });
  let timerId = 0;
  const pendingTimers = new Set<number>();
  const bargeIn = new VoiceBargeInController({
    confirmationMs: 500,
    setTimer: () => {
      const id = ++timerId;
      pendingTimers.add(id);
      return id;
    },
    clearTimer: (id) => {
      pendingTimers.delete(id);
    },
    onEvent: (event) => {
      if (event.type === "confirmed") {
        managedRuntime.interrupt(`self_test_barge_in:${event.reason}`);
      }
    }
  });
  const cascadeIdentity = {
    generation: cascadeTurn.generation,
    turnId: cascadeTurn.turnId,
    playbackId: cascadeTurn.playbackId
  };
  bargeIn.suspect(cascadeIdentity);
  bargeIn.observeTranscript("嗯", { meaningful: false });
  bargeIn.speechStopped();
  check(
    checks,
    "managed noise suspicion is reversible",
    managedRuntime.snapshot().currentTurn?.phase === "generating" && !cascadeAborted,
    managedRuntime.snapshot().currentTurn?.phase ?? "missing"
  );
  events.push("managed-barge-in:false-alarm");

  bargeIn.suspect(cascadeIdentity);
  bargeIn.observeTranscript("等一下，我换一个问题", {
    controlIntent: true,
    meaningful: true
  });
  const interruptedCascade = managedRuntime.snapshot().currentTurn;
  check(
    checks,
    "managed cascade interruption aborts active turn",
    interruptedCascade?.phase === "interrupted" && cascadeAborted,
    `${interruptedCascade?.phase ?? "missing"}/aborted=${cascadeAborted}`
  );
  events.push("managed-turn:cascade-interrupted");

  managedRuntime.beginTurn({
    turnId: "managed-next-turn",
    route: "brain",
    transcript: "第三轮继续回答"
  });
  managedRuntime.transitionTurn("endpointing");
  managedRuntime.transitionTurn("routing");
  managedRuntime.transitionTurn("generating");
  managedRuntime.updateAssistantText("第三轮已经正常接上");
  managedRuntime.markModelDone();
  managedRuntime.complete("self_test_next_turn_complete");
  const completedNext = managedRuntime.snapshot().currentTurn;
  check(
    checks,
    "managed next turn starts after interruption",
    completedNext?.phase === "completed"
      && completedNext.route === "brain"
      && completedNext.transcript === "第三轮继续回答",
    `${completedNext?.phase ?? "missing"}/${completedNext?.route ?? "missing"}`
  );
  events.push("managed-turn:next-completed");
  const invariantFailures = voiceRuntimeInvariantFailures(managedRuntime.snapshot());
  check(
    checks,
    "managed runtime invariants hold",
    invariantFailures.length === 0,
    invariantFailures.join("; ") || "ok"
  );

  const ok = checks.every((item) => item.ok);
  return {
    ok,
    ranAt,
    events,
    checks,
    summary: ok
      ? "Voice runtime self-test passed: legacy turn readiness and the managed E2E/cascade runtime, interruption, recovery, and invariants are coherent."
      : "Voice runtime self-test failed. See checks for details."
  };
}

export async function runVoiceAgentSelfTest(
  submit: VoiceAgentSubmitter,
  ranAt = new Date().toISOString()
): Promise<VoiceAgentSelfTestReport> {
  const cases: VoiceAgentSelfTestCaseResult[] = [];
  const history: AgentConversationMessage[] = [];

  for (const item of CASES) {
    const streamed: string[] = [];
    const response = await submit(item.input, history.slice(-4), (content) => streamed.push(content));
    const reply = response.reply.trim();
    const failures = validateVoiceAgentReply(item, reply, response.actions.length);
    cases.push({
      name: item.name,
      input: item.input,
      reply,
      actions: response.actions.length,
      ok: failures.length === 0,
      failures
    });
    history.push({ role: "user", content: item.input }, { role: "assistant", content: reply });
  }

  const ok = cases.every((item) => item.ok);
  return {
    ok,
    ranAt,
    cases,
    summary: ok
      ? "Voice agent self-test passed: realtime voice companion prompts produce natural replies without action pollution."
      : "Voice agent self-test failed. See case failures for details."
  };
}

export function validateVoiceAgentReply(
  testCase: VoiceAgentSelfTestCase,
  reply: string,
  actions: number
): string[] {
  const failures: string[] = [];
  if (!reply.trim()) failures.push("empty reply");
  if (reply.length > 220) failures.push(`reply too long: ${reply.length}`);
  if (/^#{1,6}\s|^\s*[-*]\s|^\s*\d+[.)、]|```|\|/m.test(reply)) failures.push("markdown/table/list detected");
  if (actions > 0) failures.push(`unexpected actions: ${actions}`);
  for (const pattern of testCase.require) {
    if (!pattern.test(reply)) failures.push(`missing required semantics: ${pattern}`);
  }
  for (const pattern of testCase.forbid) {
    if (pattern.test(reply)) failures.push(`forbidden content: ${pattern}`);
  }
  return failures;
}

function check(checks: VoiceRuntimeSelfTestCheck[], name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
}
