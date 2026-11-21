import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentActionSuggestion, AgentResponse, ProviderRunResult } from "../src/types";
import { runProviderRequest } from "../src/providerRun";
import { createVoiceSession } from "../src/voiceSession";
import { mergePendingAgentActions, PENDING_ACTION_CONFLICT_NOTICE } from "../src/pendingAgentActions";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { createPersonalMemory, reviewPersonalMemoryRecord } from "../src/personalMemory";
import { personalMemoryContextRevision } from "../src/personalMemoryContext";
import { memorySourcePolicy } from "../src/personalMemorySources";
import { attestAgentHistoryResponse, projectPersonalMemoryHistory } from "../src/personalMemoryHistory";
import type { StoreHost } from "../src/store/settingsSlice";

const notices = vi.hoisted(() => [] as string[]);
vi.mock("obsidian", () => ({
  Notice: class { constructor(message: string) { notices.push(message); } },
  ItemView: class {}, WorkspaceLeaf: class {}, setIcon: vi.fn()
}));

const { applyMessageListPanel, cancelMessageListRequest } = await import("../src/panel/messageList");
const { recordRevision } = await import("../src/operationIdentity");

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function card(id: string, title = id): AgentActionSuggestion {
  return { id, title, type: "create_task", description: "待用户确认", content: title, date: "2026-09-13" };
}

type Route = "text" | "voice";

function fixture() {
  const response = deferred<AgentResponse>();
  let onText: (text: string) => void = () => { throw new Error("No request started"); };
  const bubble = { textContent: "", classList: { remove: vi.fn() }, remove: vi.fn() };
  class Panel {}
  applyMessageListPanel(Panel);
  const host: any = Object.assign(new Panel(), {
    viewClosed: false,
    agentTextRequestGeneration: 7,
    agentVoicePipelineGeneration: 3,
    agentVoiceSendInFlight: true,
    agentVoiceQueuedAfterBusy: false,
    agentVoiceConversation: true,
    agentCameraPersonaHint: "",
    agentMode: "voice",
    agentBusy: false,
    agentInput: "请帮我整理今天",
    agentReply: "上一条回复",
    agentMessages: [],
    agentVoiceTrace: {},
    pendingAgentActions: [card("old-card", "用户尚未处理的卡")],
    voiceSession: createVoiceSession(),
    controller: {
      settings: { realtimeVoice: { speakReplies: true } },
      submitAgentMessageStream: vi.fn((_message: string, _history: unknown, update: (text: string) => void) => {
        onText = update;
        return response.promise;
      })
    },
    recoverTimedOutAgentBusy: vi.fn(),
    setAgentBusy: vi.fn((busy: boolean) => { host.agentBusy = busy; }),
    setAgentInput: vi.fn((input: string) => { host.agentInput = input; }),
    appendAgentMessage: vi.fn((message: { role: string }) => message.role === "assistant" ? bubble : null),
    setAgentMessageBubbleContent: vi.fn((element: typeof bubble, content: string) => { element.textContent = content; }),
    scrollAgentTranscriptToBottom: vi.fn(),
    refreshAgentSuggestions: vi.fn(),
    refreshAgentSurfaceState: vi.fn(),
    transitionVoiceSession: vi.fn(),
    speakAgentReply: vi.fn(),
    appendAgentQualityLog: vi.fn(async () => {}),
    markVoiceTrace: vi.fn(),
    consumeQueuedVoiceInput: vi.fn(async () => false),
    currentVoiceMessageText: vi.fn(() => ""),
    clearVoiceAutoSendTimer: vi.fn(),
    scheduleVoiceAutoSend: vi.fn(),
    ensureVoiceStandby: vi.fn(async () => {}),
    resetCurrentVoiceTurnDraft: vi.fn(),
    prepareVoiceMessageForSend: vi.fn((text: string) => text),
    tryAcceptPendingActionFromVoice: vi.fn(async () => false)
  });
  const start = (route: Route): Promise<void> => route === "text"
    ? host.sendAgentMessage()
    : host.sendAgentMessageWithPipeline("请帮我整理今天", [], host.agentVoicePipelineGeneration);
  const uiSpies = [
    host.setAgentBusy, host.setAgentInput, host.appendAgentMessage, host.setAgentMessageBubbleContent,
    host.scrollAgentTranscriptToBottom, host.refreshAgentSuggestions, host.refreshAgentSurfaceState,
    host.transitionVoiceSession, host.speakAgentReply, host.markVoiceTrace, host.consumeQueuedVoiceInput,
    host.clearVoiceAutoSendTimer, host.scheduleVoiceAutoSend, host.resetCurrentVoiceTurnDraft,
    bubble.classList.remove, bubble.remove
  ];
  return { host, response, bubble, start, emit: (text: string) => onText(text), uiSpies };
}

beforeEach(() => {
  notices.length = 0;
  vi.stubGlobal("window", { setTimeout, clearTimeout, requestAnimationFrame: vi.fn() });
});

it("uses the single adjacent bound schedule plan for a text confirmation without another model round", async () => {
  const h = fixture(); h.host.agentMode = "text"; h.host.pendingAgentActions = [];
  const action: AgentActionSuggestion = { id: "fictional-confirm-plan", type: "tool_batch", title: "确认4项调整", description: "虚构安排", content: "虚构安排预览", date: "",
    toolBatch: [{ name: "update_tasks", arguments: { updates: Array.from({ length: 4 }, (_, i) =>
      ({ taskIdOrTitle: `fictional-${i}`, startTime: "15:00", endTime: "15:30", expectedRevision: recordRevision({ i }) })) } }] };
  h.host.acceptAgentSuggestion = vi.fn(async target => {
    expect(target).toBe(action); h.host.pendingAgentActions = [];
    h.host.agentMessages.push({ role: "assistant", content: "实际保存4项" });
  });
  const first = h.start("text"); h.response.resolve({ reply: "完整计划已准备", actions: [action] }); await first;
  h.host.agentInput = "确定"; await h.start("text");
  expect(h.host.acceptAgentSuggestion).toHaveBeenCalledOnce();
  expect(h.host.controller.submitAgentMessageStream).toHaveBeenCalledOnce();
  expect(h.host.agentInput).toBe("");
  expect(h.host.agentMessages.at(-2)).toMatchObject({ role: "user", content: "确定" });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("restores a failed text request to the composer without automatically resending it",async()=>{
 const {host,response,start}=fixture();host.agentMode="text";const original=host.agentInput;
 const pending=start("text");response.reject(new Error("AI 暂时未能连接"));await pending;
 expect(host.agentInput).toBe(original);expect(host.agentReply).toContain("原话已放回输入框");
 expect(host.controller.submitAgentMessageStream).toHaveBeenCalledOnce();expect(host.agentBusy).toBe(false);
});
it("keeps a newer draft rather than replacing it with a failed request",async()=>{
 const {host,response,start}=fixture();host.agentMode="text";const pending=start("text");
 host.agentInput="纯虚构新写的下一条";response.reject(new Error("AI 暂时未能连接"));await pending;
 expect(host.agentInput).toBe("纯虚构新写的下一条");expect(host.agentReply).not.toContain("原话已放回输入框");
});
it("does not restore failed speech into the live listener and trigger an automatic resend",async()=>{
 const {host,response,start}=fixture();const pending=start("voice");response.reject(new Error("AI 暂时未能连接"));await pending;
 expect(host.agentInput).toBe("");expect(host.controller.submitAgentMessageStream).toHaveBeenCalledOnce();
 expect(host.scheduleVoiceAutoSend).not.toHaveBeenCalled();
});

describe.each<Route>(["text", "voice"])("message list %s lifecycle", route => {
  it("binds only the producer's final full pair, retaining current continuity and rejecting later memory changes", async () => {
    const { host, response, start, emit } = fixture();
    const store = { app: { vault: {} }, settings: structuredClone(DEFAULT_SETTINGS) } as unknown as StoreHost;
    const candidate = createPersonalMemory({ kind: "core_profile", content: "合成学习偏好", sourceRefs: [{ sourceId: "synthetic", path: "synthetic.md", capturedAt: new Date().toISOString() }] });
    const records = reviewPersonalMemoryRecord([candidate], candidate.id, { decision: "confirm" });
    const task = start(route); emit("合成半段回复");
    expect(projectPersonalMemoryHistory(host.agentMessages, store, records)).toEqual([]);
    const final = attestAgentHistoryResponse({ reply: "合成完整当前回复", actions: [] }, store, personalMemoryContextRevision(records), memorySourcePolicy(store), "请帮我整理今天");
    response.resolve(final); await task;
    expect(projectPersonalMemoryHistory(host.agentMessages, store, records)).toEqual([{ role: "user", content: "请帮我整理今天" }, { role: "assistant", content: final.reply }]);
    const visible = JSON.stringify(host.agentMessages), forgotten = reviewPersonalMemoryRecord(records, candidate.id, { decision: "forget" });
    expect(projectPersonalMemoryHistory(host.agentMessages, store, forgotten)).toEqual([]);
    expect(JSON.stringify(host.agentMessages)).toBe(visible);
  });
  it("keeps current streaming and appends new confirmation cards without losing existing ones", async () => {
    const { host, response, bubble, start, emit } = fixture();
    const original = host.pendingAgentActions[0];
    const task = start(route);
    emit("正在梳理");
    expect(bubble.textContent).toBe("正在梳理");
    response.resolve({ reply: "已整理，可以确认下一步。", actions: [card("new-card")] });
    await task;
    expect(host.agentMessages.at(-1).content).toBe("已整理，可以确认下一步。");
    expect(host.pendingAgentActions.map((item: AgentActionSuggestion) => item.id)).toEqual(["old-card", "new-card"]);
    expect(host.pendingAgentActions[0]).toBe(original);
    expect(host.speakAgentReply).toHaveBeenCalledWith("已整理，可以确认下一步。");
    expect(host.agentBusy).toBe(false);
  });

  it("keeps pending cards when an ordinary reply contains no new actions", async () => {
    const { host, response, start } = fixture();
    const original = host.pendingAgentActions[0];
    const task = start(route);
    response.resolve({ reply: "我们继续聊。", actions: [] });
    await task;
    expect(host.pendingAgentActions).toEqual([original]);
  });

  it("keeps the first displayed content for a duplicate ID, while still accepting distinct cards", async () => {
    const { host, response, start } = fixture();
    const original = host.pendingAgentActions[0];
    const task = start(route);
    response.resolve({ reply: "有几个建议。", actions: [
      { ...original }, card("old-card", "同编号但换成了另一任务"), card("new-card"), card("new-card", "再次替换")
    ] });
    await task;
    expect(host.pendingAgentActions).toEqual([original, card("new-card")]);
    expect(host.pendingAgentActions[0]).toBe(original);
    expect(notices).toEqual([PENDING_ACTION_CONFLICT_NOTICE]);
  });

  it.each(["close", "new-chat"])("suppresses late stream and success after %s but finishes request auditing", async reason => {
    const { host, response, bubble, start, emit, uiSpies } = fixture();
    const task = start(route);
    if (reason === "close") host.viewClosed = true;
    else host.agentTextRequestGeneration += 1;
    host.agentMessages = [{ role: "assistant", content: "新页面自己的消息" }];
    host.agentReply = "新页面状态";
    host.voiceSession.inputQueue = [{ text: "待接续的声音" }];
    const pending = host.pendingAgentActions;
    const savedBubble = bubble.textContent;
    uiSpies.forEach(spy => spy.mockClear());
    emit("已经过期的片段");
    response.resolve({ reply: "已经过期的答案", actions: [card("late-card")] });
    await task;
    expect(host.agentMessages).toEqual([{ role: "assistant", content: "新页面自己的消息" }]);
    expect(host.agentReply).toBe("新页面状态");
    expect(host.pendingAgentActions).toBe(pending);
    expect(bubble.textContent).toBe(savedBubble);
    uiSpies.forEach(spy => expect(spy).not.toHaveBeenCalled());
    expect(notices).toEqual([]);
    expect(host.controller.submitAgentMessageStream).toHaveBeenCalledOnce();
    expect(host.appendAgentQualityLog).toHaveBeenCalledOnce();
  });

  it.each(["close", "new-chat"])("suppresses late failure after %s without a stale popup or voice restart", async reason => {
    const { host, response, start, uiSpies } = fixture();
    const task = start(route);
    if (reason === "close") host.viewClosed = true;
    else host.agentTextRequestGeneration += 1;
    host.agentReply = "当前页面保留的状态";
    host.currentVoiceMessageText.mockReturnValue("不要在关闭后再次提交");
    const messages = host.agentMessages;
    uiSpies.forEach(spy => spy.mockClear());
    response.reject(new Error("旧请求的错误"));
    await task;
    expect(host.agentReply).toBe("当前页面保留的状态");
    expect(host.agentMessages).toBe(messages);
    expect(notices).toEqual([]);
    uiSpies.forEach(spy => expect(spy).not.toHaveBeenCalled());
    expect(host.appendAgentQualityLog).toHaveBeenCalledWith(route, 0, "AGENT_MESSAGE_FAILED", "旧请求的错误");
  });

  it("continues the same conversation when switching an ordinary page without changing generation", async () => {
    const { host, response, start, emit } = fixture();
    const task = start(route);
    host.mode = "calendar";
    host.activePrimaryPage = "affairs";
    emit("切页期间仍在生成");
    response.resolve({ reply: "切回来能看到这一条。", actions: [card("next")] });
    await task;
    expect(host.agentMessages.at(-1).content).toBe("切回来能看到这一条。");
    expect(host.pendingAgentActions.map((item: AgentActionSuggestion) => item.id)).toEqual(["old-card", "next"]);
  });

  it("checks closure again after the asynchronous audit before refreshing or consuming queued input", async () => {
    const { host, response, start, uiSpies } = fixture();
    const audit = deferred<void>();
    const auditStarted = deferred<void>();
    host.appendAgentQualityLog.mockImplementation(() => { auditStarted.resolve(); return audit.promise; });
    const task = start(route);
    response.resolve({ reply: "回复已经完成", actions: [] });
    await auditStarted.promise;
    host.viewClosed = true;
    host.voiceSession.inputQueue = [{ text: "关闭后不能接的下一句" }];
    uiSpies.forEach(spy => spy.mockClear());
    audit.resolve();
    await task;
    uiSpies.forEach(spy => expect(spy).not.toHaveBeenCalled());
  });

  it("shows a current request error and preserves earlier confirmation cards", async () => {
    const { host, response, start } = fixture();
    const pending = host.pendingAgentActions;
    const task = start(route);
    response.reject(new Error("模型暂时不可用"));
    await task;
    expect(host.agentMessages.at(-1).content).toBe("模型暂时不可用");
    expect(host.pendingAgentActions).toBe(pending);
    expect(notices).toEqual(["模型暂时不可用"]);
    expect(host.agentBusy).toBe(false);
  });
});

describe("message list lifecycle boundary cases", () => {
  it("accepts an older host with no lifecycle fields as generation zero", async () => {
    const { host, response, start } = fixture();
    delete host.agentTextRequestGeneration;
    delete host.viewClosed;
    const task = start("text");
    response.resolve({ reply: "正常兼容", actions: [] });
    await task;
    expect(host.agentReply).toBe("正常兼容");
  });

  it("does not submit or touch the surface when the view is already closed", async () => {
    const { host, start, uiSpies } = fixture();
    host.viewClosed = true;
    await start("text");
    await start("voice");
    expect(host.controller.submitAgentMessageStream).not.toHaveBeenCalled();
    uiSpies.forEach(spy => expect(spy).not.toHaveBeenCalled());
  });

  it("does not start a voice request after closure during the pending-action preflight", async () => {
    const { host, uiSpies } = fixture();
    const preflight = deferred<boolean>();
    host.agentVoiceSendInFlight = false;
    host.currentVoiceMessageText.mockReturnValue("请继续");
    host.tryAcceptPendingActionFromVoice.mockImplementation(() => preflight.promise);
    const task = host.sendAgentMessage("voice");
    host.viewClosed = true;
    uiSpies.forEach(spy => spy.mockClear());
    preflight.resolve(false);
    await task;
    expect(host.controller.submitAgentMessageStream).not.toHaveBeenCalled();
    uiSpies.forEach(spy => expect(spy).not.toHaveBeenCalled());
  });

  it("does not start a voice request if voice standby stops during the pending-action preflight", async () => {
    const { host } = fixture();
    const preflight = deferred<boolean>();
    host.agentVoiceSendInFlight = false;
    host.currentVoiceMessageText.mockReturnValue("请继续");
    host.tryAcceptPendingActionFromVoice.mockImplementation(() => preflight.promise);
    const task = host.sendAgentMessage("voice");
    host.agentVoicePipelineGeneration += 1;
    host.agentMode = "text";
    host.agentVoiceConversation = false;
    preflight.resolve(false);
    await task;
    expect(host.controller.submitAgentMessageStream).not.toHaveBeenCalled();
    expect(host.agentVoiceSendInFlight).toBe(false);
    expect(host.transitionVoiceSession).not.toHaveBeenCalled();
    expect(host.scheduleVoiceAutoSend).not.toHaveBeenCalled();
  });

  it("does not supersede a newer text submission when an older voice preflight finishes", async () => {
    const { host, response, start, uiSpies } = fixture();
    const preflight = deferred<boolean>();
    host.agentVoiceSendInFlight = false;
    host.currentVoiceMessageText.mockReturnValue("请继续");
    host.tryAcceptPendingActionFromVoice.mockImplementation(() => preflight.promise);
    const oldTask = host.sendAgentMessage("voice");
    const newTask = start("text");
    uiSpies.forEach(spy => spy.mockClear());
    preflight.resolve(false);
    await oldTask;
    expect(host.controller.submitAgentMessageStream).toHaveBeenCalledOnce();
    expect(host.agentBusy).toBe(true);
    uiSpies.forEach(spy => expect(spy).not.toHaveBeenCalled());
    response.resolve({ reply: "新的文字请求完成", actions: [] });
    await newTask;
    expect(host.agentReply).toBe("新的文字请求完成");
    expect(host.agentVoiceSendInFlight).toBe(false);
  });

  it("suppresses an interrupted voice reply while preserving existing unhandled cards", async () => {
    const { host, response, start, emit, bubble } = fixture();
    const original = host.pendingAgentActions[0];
    const task = start("voice");
    host.agentVoicePipelineGeneration += 1;
    emit("过时的语音回复片段");
    response.resolve({ reply: "过时的语音回复", actions: [card("late-card")] });
    await task;
    expect(host.pendingAgentActions).toEqual([original]);
    expect(host.speakAgentReply).not.toHaveBeenCalled();
    expect(bubble.remove).toHaveBeenCalledOnce();
    expect(host.agentReply).toBe("我先接你刚才补的那句。");
  });

  it("does not resume listening or submit queued input after voice standby is stopped", async () => {
    const { host, response, start } = fixture();
    const task = start("voice");
    host.agentVoicePipelineGeneration += 1;
    host.agentVoiceConversation = false;
    host.agentMode = "text";
    host.agentReply = "语音已停止。";
    host.voiceSession.inputQueue = [{ text: "停止前留下的队列" }];
    host.currentVoiceMessageText.mockReturnValue("停止后保留的文字草稿");
    response.resolve({ reply: "已经过期的语音回复", actions: [card("late-card")] });
    await task;
    expect(host.agentReply).toBe("语音已停止。");
    expect(host.transitionVoiceSession).not.toHaveBeenCalled();
    expect(host.consumeQueuedVoiceInput).not.toHaveBeenCalled();
    expect(host.scheduleVoiceAutoSend).not.toHaveBeenCalled();
    expect(host.resetCurrentVoiceTurnDraft).not.toHaveBeenCalled();
  });

  it.each<Route>(["text", "voice"])("a replaced %s request cannot change a newer voice request", async oldRoute => {
    const { host, response, start, uiSpies } = fixture();
    const oldTask = start(oldRoute);
    const newerResponse = deferred<AgentResponse>();
    host.controller.submitAgentMessageStream.mockImplementation(() => newerResponse.promise);
    host.agentBusy = false;
    host.agentVoicePipelineGeneration += 1;
    const newTask = start("voice");
    const newerMessages = host.agentMessages;
    const newerReply = host.agentReply;
    host.agentInput = "新请求期间用户正在补充的文字";
    uiSpies.forEach(spy => spy.mockClear());
    response.resolve({ reply: "旧请求晚到的结果", actions: [card("late-card")] });
    await oldTask;
    expect(host.agentMessages).toBe(newerMessages);
    expect(host.agentReply).toBe(newerReply);
    expect(host.agentInput).toBe("新请求期间用户正在补充的文字");
    expect(host.agentBusy).toBe(true);
    uiSpies.forEach(spy => expect(spy).not.toHaveBeenCalled());
    newerResponse.resolve({ reply: "新请求正常完成", actions: [card("current-card")] });
    await newTask;
    expect(host.agentMessages.at(-1).content).toBe("新请求正常完成");
    expect(host.pendingAgentActions.map((item: AgentActionSuggestion) => item.id)).toEqual(["old-card", "current-card"]);
  });

  it("an old voice audit finishing cannot reset a new request's busy state, queue or draft", async () => {
    const { host, response, start, uiSpies } = fixture();
    const audit = deferred<void>();
    const auditStarted = deferred<void>();
    host.appendAgentQualityLog.mockImplementationOnce(() => { auditStarted.resolve(); return audit.promise; });
    const oldTask = start("voice");
    response.resolve({ reply: "上一句已完成", actions: [] });
    await auditStarted.promise;
    const newerResponse = deferred<AgentResponse>();
    host.controller.submitAgentMessageStream.mockImplementation(() => newerResponse.promise);
    host.agentVoicePipelineGeneration += 1;
    host.agentVoiceSendInFlight = true;
    const newTask = start("voice");
    host.agentInput = "第二句尚未发送的补充";
    host.voiceSession.inputQueue = [{ text: "下一句" }];
    uiSpies.forEach(spy => spy.mockClear());
    audit.resolve();
    await oldTask;
    expect(host.agentBusy).toBe(true);
    expect(host.agentVoiceSendInFlight).toBe(true);
    expect(host.agentInput).toBe("第二句尚未发送的补充");
    uiSpies.forEach(spy => expect(spy).not.toHaveBeenCalled());
    host.voiceSession.inputQueue = [];
    newerResponse.resolve({ reply: "第二句正常完成", actions: [] });
    await newTask;
    expect(host.agentBusy).toBe(false);
  });

  it.each(["close", "new-chat"])("does not run delayed transcript scrolling after %s", reason => {
    const callbacks: Array<() => void> = [];
    vi.stubGlobal("window", { requestAnimationFrame: (fn: () => void) => callbacks.push(fn), setTimeout: (fn: () => void) => callbacks.push(fn) });
    class Panel {}
    applyMessageListPanel(Panel);
    const transcript = { scrollTop: 0, scrollHeight: 100 };
    const host: any = Object.assign(new Panel(), { agentTranscriptEl: transcript, viewClosed: false, agentTextRequestGeneration: 0 });
    host.scrollAgentTranscriptToBottom();
    expect(transcript.scrollTop).toBe(100);
    transcript.scrollTop = 20;
    if (reason === "close") host.viewClosed = true;
    else host.agentTextRequestGeneration += 1;
    callbacks.forEach(callback => callback());
    expect(transcript.scrollTop).toBe(20);
  });
});

describe("pending confirmation card merging", () => {
  it("deduplicates equivalent content regardless of object property order", () => {
    const original = { ...card("one"), expectedTargetRevisions: { left: "r1", right: "r2" } };
    const reordered = {
      expectedTargetRevisions: { right: "r2", left: "r1" },
      date: original.date, content: original.content, description: original.description,
      type: original.type, title: original.title, id: original.id, memoryId: undefined
    };
    expect(mergePendingAgentActions([original], [reordered])).toEqual({ actions: [original], conflictingIds: [] });
  });

  it("does not silently change target IDs or expected data revisions behind an existing card", () => {
    const original = { ...card("one"), taskIds: ["task-a"], expectedTargetRevisions: { "task-a": "r1" } };
    const changedRevision = { ...original, expectedTargetRevisions: { "task-a": "r2" } };
    const changedTarget = { ...original, taskIds: ["task-b"] };
    const result = mergePendingAgentActions([original], [changedRevision, changedTarget]);
    expect(result).toEqual({ actions: [original], conflictingIds: ["one"] });
    expect(result.actions[0]).toBe(original);
  });

  it("does not mutate either input list or replace an existing card object", () => {
    const prior = Object.freeze(card("one"));
    const next = Object.freeze(card("two"));
    const existing = [prior];
    const incoming = [next];
    Object.freeze(existing);
    Object.freeze(incoming);
    const result = mergePendingAgentActions(existing, incoming);
    expect(result.actions).toEqual([prior, next]);
    expect(result.actions).not.toBe(existing);
    expect(existing).toEqual([prior]);
    expect(incoming).toEqual([next]);
  });
});

function timeoutClock() {
  vi.useFakeTimers();
  vi.stubGlobal("window", { setTimeout, clearTimeout, requestAnimationFrame: vi.fn() });
}

describe.each<Route>(["text", "voice"])("message list %s deadline cancellation", route => {
  it.each(["deadline", "user-cancel"])("retains the %s cause through the actual Provider request", async cause => {
    timeoutClock();
    const { host, response, start } = fixture();
    const runs: ProviderRunResult[] = [];
    const execute = vi.fn(async () => ({ ...await response.promise, reportedModel: "synthetic-late-model" }));
    host.controller.submitAgentMessageStream.mockImplementation((_message: string, _history: unknown, _update: unknown, options: any) =>
      runProviderRequest({ provider: "synthetic", model: "synthetic-model" }, [
        { provider: "synthetic", model: "synthetic-model", transport: "fetch", execute }
      ], { signal: options.signal, timeoutMs: 45_000, onProviderRun: run => runs.push(run) }));
    const pending = host.pendingAgentActions;
    const task = start(route);
    expect(execute).toHaveBeenCalledOnce();
    if (cause === "deadline") await vi.advanceTimersByTimeAsync(30_000);
    else cancelMessageListRequest(host);
    await task;
    expect(runs).toEqual([expect.objectContaining({
      status: cause === "deadline" ? "failed" : "cancelled", fallbackUsed: false,
      attempts: [expect.objectContaining({ errorCode: cause === "deadline" ? "timeout" : "cancelled" })]
    })]);
    expect(host.pendingAgentActions).toBe(pending);
    const terminal = structuredClone(runs);
    response.resolve({ reply: "合成迟到回复", actions: [card("late-deadline-card")] });
    await vi.advanceTimersByTimeAsync(45_000);
    expect(runs).toEqual(terminal);
    expect(execute).toHaveBeenCalledOnce();
    expect(host.pendingAgentActions).toBe(pending);
    expect(host.agentMessages.at(-1)?.content).not.toBe("合成迟到回复");
  });

  it("keeps the30-second boundary and cancels the owned underlying request", async () => {
    timeoutClock();
    const { host, start } = fixture();
    const pending = host.pendingAgentActions;
    const task = start(route);
    const signal = host.controller.submitAgentMessageStream.mock.calls[0][3]?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(signal.aborted).toBe(false);
    expect(host.agentBusy).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    await task;
    expect(signal.aborted).toBe(true);
    expect(signal.reason.message).toContain("请求超时");
    expect(host.agentReply).toContain("请求超时");
    expect(host.agentBusy).toBe(false);
    expect(host.pendingAgentActions).toBe(pending);
    expect(host.appendAgentQualityLog).toHaveBeenCalledOnce();
  });

  it("does not cancel a complete response before the deadline", async () => {
    timeoutClock();
    const { host, response, start } = fixture();
    const task = start(route);
    const signal = host.controller.submitAgentMessageStream.mock.calls[0][3]?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    await vi.advanceTimersByTimeAsync(29_999);
    response.resolve({ reply: "合成已完成的整段回复", actions: [card("on-time")] });
    await task;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(signal.aborted).toBe(false);
    expect(host.agentMessages.at(-1).content).toBe("合成已完成的整段回复");
    expect(host.pendingAgentActions.map((x: AgentActionSuggestion) => x.id)).toEqual(["old-card", "on-time"]);
  });

  it("ignores late text, speech and confirmation cards after timeout", async () => {
    timeoutClock();
    const { host, response, start, emit } = fixture();
    const task = start(route);
    await vi.advanceTimersByTimeAsync(30_000);
    await task;
    const final = host.agentMessages.slice(), cards = host.pendingAgentActions;
    host.speakAgentReply.mockClear();
    emit("合成迟到片段");
    response.resolve({ reply: "合成迟到完整回复", actions: [card("late")] });
    await Promise.resolve();
    await Promise.resolve();
    expect(host.agentMessages).toEqual(final);
    expect(host.pendingAgentActions).toBe(cards);
    expect(host.speakAgentReply).not.toHaveBeenCalled();
  });

  it("passes cancellation to the non-streaming controller too", async () => {
    timeoutClock();
    const { host, response, start } = fixture();
    delete host.controller.submitAgentMessageStream;
    host.controller.submitAgentMessage = vi.fn(() => response.promise);
    const task = start(route);
    const signal = host.controller.submitAgentMessage.mock.calls[0][2]?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    await vi.advanceTimersByTimeAsync(30_000);
    await task;
    expect(signal.aborted).toBe(true);
  });

  it("an older audit cannot cancel or repaint the newer request", async () => {
    timeoutClock();
    const { host, start } = fixture();
    const audit = deferred<void>(), newer = deferred<AgentResponse>();
    host.appendAgentQualityLog.mockImplementationOnce(() => audit.promise);
    const olderTask = start(route);
    const olderSignal = host.controller.submitAgentMessageStream.mock.calls[0][3]?.signal;
    expect(olderSignal).toBeInstanceOf(AbortSignal);
    await vi.advanceTimersByTimeAsync(30_000);
    host.controller.submitAgentMessageStream.mockImplementationOnce(() => newer.promise);
    host.agentInput = "合成下一条";
    const newerTask = start(route);
    const newerSignal = host.controller.submitAgentMessageStream.mock.calls[1][3]?.signal;
    expect(newerSignal).toBeInstanceOf(AbortSignal);
    audit.resolve();
    await olderTask;
    expect(olderSignal.aborted).toBe(true);
    expect(newerSignal.aborted).toBe(false);
    expect(host.agentBusy).toBe(true);
    newer.resolve({ reply: "合成新的完整回复", actions: [card("new-owned")] });
    await newerTask;
    expect(host.agentMessages.at(-1).content).toBe("合成新的完整回复");
    expect(host.pendingAgentActions.map((x: AgentActionSuggestion) => x.id)).toEqual(["old-card", "new-owned"]);
  });

  it("cancels the same owner on view invalidation and preserves the new surface", async () => {
    timeoutClock();
    const { host, response, start, emit } = fixture();
    const task = start(route);
    const signal = host.controller.submitAgentMessageStream.mock.calls[0][3]?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    host.viewClosed = true;
    cancelMessageListRequest(host);
    expect(signal.aborted).toBe(true);
    host.agentMessages = [{ role: "assistant", content: "合成新页面" }];
    emit("合成旧页片段");
    response.resolve({ reply: "合成旧页回复", actions: [card("old-page")] });
    await task;
    expect(host.agentMessages).toEqual([{ role: "assistant", content: "合成新页面" }]);
    expect(host.pendingAgentActions.map((x: AgentActionSuggestion) => x.id)).toEqual(["old-card"]);
  });
});
