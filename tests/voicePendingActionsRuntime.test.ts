import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { VoiceSessionController } from "../src/voice/voiceRuntime";
import { createVoiceSession } from "../src/voiceSession";
import type { AgentActionSuggestion, AgentResponse } from "../src/types";
import { PENDING_ACTION_CONFLICT_NOTICE } from "../src/pendingAgentActions";

const notices = vi.hoisted(() => [] as string[]);
vi.mock("obsidian", () => ({ Notice: class { constructor(message: string) { notices.push(message); } } }));
vi.mock("ws", () => ({ default: class { constructor() { throw new Error("No network in voice presentation tests"); } } }));
const { executeOmniE2eToolCall, fallbackOmniResponseToBrain } = await import("../src/voice/voiceRealtime");

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function action(id: string, content = id): AgentActionSuggestion {
  return { id, type: "create_task", title: content, content, description: "示例确认卡", date: "2026-09-13" };
}
function activeRuntime() {
  const runtime = new VoiceSessionController({ provider: "test-offline" });
  runtime.connect(); runtime.connected();
  runtime.beginTurn({ route: "e2e", transcript: "请帮我查看今天的任务" });
  runtime.transitionTurn("routing", "test-routing");
  runtime.transitionTurn("generating", "test-model");
  return runtime;
}
function fixture() {
  const response = deferred<AgentResponse>();
  let stream: ((text: string) => void) | undefined;
  const runtime = activeRuntime();
  const view: any = {
    viewClosed: false, agentTextRequestGeneration: 1, agentVoicePipelineGeneration: 1,
    agentVoiceRuntime: runtime, pendingAgentActions: [action("old", "用户尚未处理的原卡")],
    controller: {
      settings: { realtimeVoice: { ...DEFAULT_SETTINGS.realtimeVoice, provider: "qwen-omni-realtime", mode: "omni-e2e", speakReplies: false } },
      executeAgentToolCall: vi.fn(() => response.promise),
      submitAgentMessageStream: vi.fn((_message: string, _history: unknown[], onText: (text: string) => void) => { stream = onText; return response.promise; }),
      appendQualityLog: vi.fn(async () => {}), appendAgentConversation: vi.fn(async () => {})
    },
    agentOmniE2eReply: "", agentReply: "", agentOmniE2eAssistantIndex: 0, agentOmniE2eStreamMessageEl: {},
    agentMessages: [{ role: "assistant", content: "" }], agentVoiceTrace: {}, agentRecording: true,
    agentMode: "voice", agentVoiceConversation: true, agentSpeaking: false, agentBusy: true,
    voiceSession: createVoiceSession(), agentRealtimeClient: { appendAssistantMessage: vi.fn(), cancelResponse: vi.fn() },
    refreshAgentSuggestions: vi.fn(), refreshAgentSurfaceState: vi.fn(), setAgentMessageBubbleContent: vi.fn(),
    markVoiceTrace: vi.fn(), scrollAgentTranscriptToBottom: vi.fn(), setAgentBusy: vi.fn(),
    appendAgentQualityLog: vi.fn(async () => {}), currentVoiceMessageText: () => "", resetCurrentVoiceTurnDraft: vi.fn(),
    consumeQueuedVoiceInput: vi.fn(async () => {}), transitionVoiceSession: vi.fn()
  };
  return { view, runtime, response, stream: (text: string) => stream?.(text) };
}
const tool = { id: "tool-call", name: "create_task", arguments: { title: "示例新任务" } };

beforeEach(() => {
  notices.length = 0;
  vi.useFakeTimers();
  vi.stubGlobal("window", { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("voice responses preserve pending cards and presentation ownership", () => {
  it.each(["tool", "routed"] as const)("%s responses append new cards and retain original content on ID collision", async kind => {
    const { view, response } = fixture();
    const original = view.pendingAgentActions[0];
    const pending = kind === "tool" ? executeOmniE2eToolCall(view, tool) : fallbackOmniResponseToBrain(view, "test fallback");
    await Promise.resolve(); await Promise.resolve();
    response.resolve({ reply: "新建议请确认", actions: [action("old", "错误替换原卡"), action("new"), action("new")] });
    await pending;
    expect(view.pendingAgentActions).toEqual([original, action("new")]);
    expect(view.pendingAgentActions[0]).toBe(original);
    expect(notices).toEqual([PENDING_ACTION_CONFLICT_NOTICE]);
    expect(view.refreshAgentSuggestions).toHaveBeenCalled();
  });

  it.each(["tool", "routed"] as const)("%s response with no suggestions keeps the pending card", async kind => {
    const { view, response } = fixture();
    const original = [...view.pendingAgentActions];
    const pending = kind === "tool" ? executeOmniE2eToolCall(view, tool) : fallbackOmniResponseToBrain(view, "test fallback");
    await Promise.resolve(); await Promise.resolve();
    response.resolve({ reply: "普通回复", actions: [] });
    await pending;
    expect(view.pendingAgentActions).toEqual(original);
    expect(notices).toEqual([]);
  });

  it.each(["tool", "routed"] as const)("%s late result cannot add cards after closing and reopening the view", async kind => {
    const { view, response, stream } = fixture();
    const pending = kind === "tool" ? executeOmniE2eToolCall(view, tool) : fallbackOmniResponseToBrain(view, "test fallback");
    await Promise.resolve(); await Promise.resolve();
    view.viewClosed = true;
    view.agentTextRequestGeneration += 1;
    view.viewClosed = false;
    view.agentReply = "新打开的对话";
    view.refreshAgentSuggestions.mockClear(); view.refreshAgentSurfaceState.mockClear();
    stream("迟到的旧流内容");
    response.resolve({ reply: "迟到旧回复", actions: [action("late")] });
    await pending;
    expect(view.pendingAgentActions.map((item: AgentActionSuggestion) => item.id)).toEqual(["old"]);
    expect(view.agentReply).toBe("新打开的对话");
    expect(view.refreshAgentSuggestions).not.toHaveBeenCalled();
    expect(view.refreshAgentSurfaceState).not.toHaveBeenCalled();
    expect(view.agentRealtimeClient.appendAssistantMessage).not.toHaveBeenCalled();
  });

  it.each(["tool", "routed"] as const)("%s late failure cannot fail a replacement runtime turn", async kind => {
    const { view, response, stream } = fixture();
    const pending = kind === "tool" ? executeOmniE2eToolCall(view, tool) : fallbackOmniResponseToBrain(view, "test fallback");
    await Promise.resolve(); await Promise.resolve();
    const replacement = activeRuntime();
    view.agentVoiceRuntime = replacement;
    view.agentReply = "新一轮正在处理";
    view.refreshAgentSurfaceState.mockClear();
    stream("旧一轮流输出");
    response.reject(new Error("旧服务失败"));
    await pending;
    expect(replacement.snapshot().currentTurn?.phase).toBe("generating");
    expect(view.agentReply).toBe("新一轮正在处理");
    expect(view.refreshAgentSurfaceState).not.toHaveBeenCalled();
    expect(notices).toEqual([]);
  });

  it.each(["tool", "routed"] as const)("%s late success cannot add cards to the next turn of the same runtime", async kind => {
    const { view, runtime, response } = fixture();
    const pending = kind === "tool" ? executeOmniE2eToolCall(view, tool) : fallbackOmniResponseToBrain(view, "test fallback");
    await Promise.resolve(); await Promise.resolve();
    runtime.interrupt("user changed topic");
    const next = runtime.beginTurn({ route: "brain", transcript: "新的问题" });
    runtime.transitionTurn("routing", "new-route");
    runtime.transitionTurn("generating", "new-model");
    view.agentReply = "新的回合";
    view.pendingAgentActions.push(action("another-current-card"));
    response.resolve({ reply: "上轮迟到回复", actions: [action("stale-card")] });
    await pending;
    expect(runtime.snapshot().currentTurn).toMatchObject({ turnId: next.turnId, phase: "generating", assistantText: "" });
    expect(view.pendingAgentActions.map((item: AgentActionSuggestion) => item.id)).toEqual(["old", "another-current-card"]);
    expect(view.agentReply).toBe("新的回合");
  });

  it("does not start a routed provider request if the view closes during fallback audit", async () => {
    const { view } = fixture();
    const audit = deferred<void>();
    view.controller.appendQualityLog = vi.fn(() => audit.promise);
    const pending = fallbackOmniResponseToBrain(view, "test fallback");
    view.viewClosed = true;
    audit.resolve();
    await pending;
    expect(view.controller.submitAgentMessageStream).not.toHaveBeenCalled();
  });

  it("does not invoke a tool from an already closed view", async () => {
    const { view } = fixture();
    view.viewClosed = true;
    expect(await executeOmniE2eToolCall(view, tool)).toBe("");
    expect(view.controller.executeAgentToolCall).not.toHaveBeenCalled();
  });
});
