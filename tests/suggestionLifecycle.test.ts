import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentActionSuggestion } from "../src/types";
import { createVoiceSession } from "../src/voiceSession";

const notices = vi.hoisted(() => [] as string[]);
vi.mock("obsidian", () => ({
  Notice: class { constructor(message: string) { notices.push(message); } },
  ItemView: class {}, WorkspaceLeaf: class {}, setIcon: vi.fn()
}));
const { applyComposerPanel } = await import("../src/panel/composer");
const { applyMessageListPanel } = await import("../src/panel/messageList");
const { applySuggestionsPanel } = await import("../src/panel/suggestions");

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function card(id: string, title = id): AgentActionSuggestion {
  return { id, title, type: "create_task", description: "待用户确认", content: title, date: "2026-09-13" };
}

function fixture() {
  const execution = deferred<void>();
  class Panel {}
  applyComposerPanel(Panel);
  applyMessageListPanel(Panel);
  applySuggestionsPanel(Panel);
  const original = card("original", "原确认卡");
  const other = card("other", "其它未处理卡");
  const bubble = { textContent: "", classList: { remove: vi.fn() }, remove: vi.fn() };
  const host: any = Object.assign(new Panel(), {
    viewClosed: false, agentTextRequestGeneration: 0,
    agentBusy: false, agentBusySince: 0, agentVoiceSendInFlight: false,
    agentMode: "voice", agentVoiceConversation: true,
    agentReply: "之前的回复", agentInput: "请整理今天", agentMessages: [],
    agentCameraPersonaHint: "", agentVoiceTrace: {}, agentVoicePipelineGeneration: 0,
    agentVoiceQueuedAfterBusy: false, voiceSession: createVoiceSession(),
    pendingAgentActions: [original, other], proactiveCandidates: [], agentSuggestionsEl: null,
    controller: {
      executeAgentAction: vi.fn(() => execution.promise),
      appendAgentActionReceipt: vi.fn(async () => true),
      appendQualityLog: vi.fn(async () => {}),
      settings: { realtimeVoice: { speakReplies: true } },
      submitAgentMessageStream: vi.fn(async () => ({ reply: "模型正常回复", actions: [] }))
    },
    recoverTimedOutAgentBusy: vi.fn(),
    refreshAgentSurfaceState: vi.fn(), refreshAgentSuggestions: vi.fn(), refreshStewardStatus: vi.fn(),
    setAgentInput: vi.fn((text: string) => { host.agentInput = text; }),
    rememberSentVoiceTurn: vi.fn(), clearVoiceTurnBufferAfterSend: vi.fn(),
    currentVoiceMessageText: vi.fn(() => "确认"), prepareVoiceMessageForSend: vi.fn((text: string) => text),
    appendAgentMessage: vi.fn((message: { role: string }) => message.role === "assistant" ? bubble : null),
    setAgentMessageBubbleContent: vi.fn(), scrollAgentTranscriptToBottom: vi.fn(),
    transitionVoiceSession: vi.fn(), speakAgentReply: vi.fn(), appendAgentQualityLog: vi.fn(async () => {}),
    markVoiceTrace: vi.fn(), consumeQueuedVoiceInput: vi.fn(async () => false),
    clearVoiceAutoSendTimer: vi.fn(), scheduleVoiceAutoSend: vi.fn(), resetCurrentVoiceTurnDraft: vi.fn()
  });
  const busy = vi.spyOn(host, "setAgentBusy");
  const uiSpies = [busy, host.refreshAgentSurfaceState, host.refreshAgentSuggestions,
    host.refreshStewardStatus, host.setAgentInput, host.rememberSentVoiceTurn, host.clearVoiceTurnBufferAfterSend,
    host.appendAgentMessage, host.setAgentMessageBubbleContent, host.scrollAgentTranscriptToBottom,
    host.transitionVoiceSession, host.speakAgentReply, host.consumeQueuedVoiceInput,
    host.clearVoiceAutoSendTimer, host.scheduleVoiceAutoSend, host.resetCurrentVoiceTurnDraft];
  return { host, original, other, execution, uiSpies };
}

function renderedCard(host: any, action: AgentActionSuggestion) {
  const fields: Record<string, any[]> = {};
  const callbacks: Record<string, () => void> = {};
  const element = (): any => ({
    createDiv: () => element(), createSpan: () => element(),
    createEl: (tag: string) => {
      const child = element();
      (fields[tag] ??= []).push(child);
      return child;
    },
    setAttr: vi.fn()
  });
  host.iconButton = vi.fn((_container: unknown, _icon: string, label: string, action: () => void) => { callbacks[label] = action; });
  host.renderAgentSuggestionCard(element(), action);
  return { fields, callbacks };
}

class DockElement {
  children: DockElement[] = [];
  parent: DockElement | null = null;
  attributes: Record<string, string> = {};
  dataset: Record<string, string> = {};
  classes = new Set<string>();
  style: Record<string, string> = {};
  hidden = false;
  disabled = false;
  value = "";
  readOnly = false;
  onclick?: () => void;
  oninput?: () => void;
  text = "";
  constructor(readonly document: any, readonly root = false) {}
  get ownerDocument() { return this.document; }
  get isConnected(): boolean { return this.root || Boolean(this.parent?.isConnected); }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(""); }
  createEl(_tag: string, options: any = {}, initialize?: (element: any) => void): DockElement {
    const child = new DockElement(this.document);
    child.parent = this;
    child.text = options.text ?? "";
    for (const cls of (options.cls ?? "").split(" ").filter(Boolean)) child.classes.add(cls);
    for (const [key, value] of Object.entries(options.attr ?? {})) child.setAttribute(key, String(value));
    this.children.push(child);
    initialize?.(child);
    return child;
  }
  createDiv(options: any = {}) { return this.createEl("div", options); }
  createSpan(options: any = {}) { return this.createEl("span", options); }
  setAttribute(key: string, value: string) {
    this.attributes[key] = value;
    if (key === "data-suggestion-kind") this.dataset.suggestionKind = value;
  }
  setAttr(key: string, value: string) { this.setAttribute(key, value); }
  toggleClass(cls: string, enabled: boolean) { if (enabled) this.classes.add(cls); else this.classes.delete(cls); }
  empty() { for (const child of this.children) child.parent = null; this.children = []; }
  contains(element: DockElement | null): boolean { return element === this || this.children.some(child => child.contains(element)); }
  findAll(predicate: (element: DockElement) => boolean): DockElement[] {
    return [...(predicate(this) ? [this] : []), ...this.children.flatMap(child => child.findAll(predicate))];
  }
  querySelector(_selector: string) {
    return this.findAll(element => Boolean(element.dataset.suggestionKind) && element.attributes["aria-expanded"] === "true")[0] ?? null;
  }
  addEventListener() {}
  focus() { this.document.activeElement = this; }
  click() { if (!this.disabled) this.onclick?.(); }
}

function liveDock(host: any) {
  const document = { activeElement: null };
  const panel = new DockElement(document, true);
  const refresh = Object.getPrototypeOf(host).refreshAgentSuggestions;
  host.refreshAgentSuggestions.mockImplementation(() => refresh.call(host));
  host.renderAgentSuggestions(panel);
  const chip = () => panel.findAll(element => element.dataset.suggestionKind === "actions")[0];
  const count = () => chip().findAll(element => element.classes.has("lifeops-agent-suggestion-count"))[0].textContent;
  const cards = () => panel.findAll(element => element.classes.has("lifeops-agent-suggestion-card"));
  return { panel, chip, count, cards };
}

beforeEach(() => {
  notices.length = 0;
  vi.stubGlobal("window", { setTimeout, clearTimeout, requestAnimationFrame: vi.fn() });
});

describe("completed action receipt history", () => {
  it.each(["note_understanding", "weekly_review", "task_plan", "project_change", "trading_change", "create_task"] as const)("persists the actual %s receipt once and keeps it in the transcript", async type => {
    const { host, original } = fixture(); original.type = type;
    const receipt = "已保存1项；其余已取消，任务仍待办。";
    host.controller.executeAgentAction.mockResolvedValue(receipt);
    await host.acceptAgentSuggestion(original);
    expect(host.controller.appendAgentActionReceipt).toHaveBeenCalledExactlyOnceWith(original.title, receipt);
    expect(host.agentMessages.at(-1)).toEqual({ role: "assistant", content: receipt });
    expect(host.pendingAgentActions).not.toContain(original);
    await host.acceptAgentSuggestion(original);
    expect(host.controller.executeAgentAction).toHaveBeenCalledOnce();
    expect(host.controller.appendAgentActionReceipt).toHaveBeenCalledOnce();
  });

  it.each(["throw", "false"])("keeps an already completed action completed when history returns %s", async outcome => {
    const { host, original } = fixture(); original.type = "weekly_review";
    host.controller.executeAgentAction.mockResolvedValue("草稿已核验保存，假设待核对。");
    if (outcome === "throw") host.controller.appendAgentActionReceipt.mockRejectedValue(new Error("readback unavailable"));
    else host.controller.appendAgentActionReceipt.mockResolvedValue(false);
    await host.acceptAgentSuggestion(original);
    expect(host.agentReply).toBe("草稿已核验保存，假设待核对。");
    expect(host.pendingAgentActions).not.toContain(original);
    expect(host.controller.appendQualityLog).toHaveBeenCalledWith(expect.objectContaining({ userAcceptedActions: 1, errorCode: "AGENT_ACTION_HISTORY_FAILED" }));
    expect(host.controller.appendQualityLog.mock.calls.some(([entry]: any[]) => entry.errorCode === "AGENT_ACTION_FAILED")).toBe(false);
    expect(notices).toEqual(["操作已完成；历史记录未能核验保存，请在最近操作核对。"]);
    await host.acceptAgentSuggestion(original);
    expect(host.controller.executeAgentAction).toHaveBeenCalledOnce();
    expect(host.controller.appendAgentActionReceipt).toHaveBeenCalledOnce();
  });

  it.each(["close", "new-chat", "new-activity"])("records a genuine late completion after %s without changing the current UI", async reason => {
    const { host, original, execution, uiSpies } = fixture();
    const task = host.acceptAgentSuggestion(original);
    if (reason === "close") host.viewClosed = true;
    else if (reason === "new-chat") host.agentTextRequestGeneration++;
    else host.setAgentBusy(true);
    host.agentReply = "新页面状态";
    uiSpies.forEach(spy => spy.mockClear());
    (execution.resolve as (value: unknown) => void)("实际保存回执");
    await task;
    expect(host.controller.appendAgentActionReceipt).toHaveBeenCalledExactlyOnceWith(original.title, "实际保存回执");
    expect(host.agentReply).toBe("新页面状态");
    uiSpies.forEach(spy => {
      if (spy === host.refreshAgentSuggestions && reason !== "close") expect(spy).toHaveBeenCalledOnce();
      else expect(spy).not.toHaveBeenCalled();
    });
    expect(notices).toEqual([]);
  });

  it("does not turn an execution failure into a completed history event", async () => {
    const { host, original, execution } = fixture();
    const task = host.acceptAgentSuggestion(original); execution.reject(new Error("来源变化，未保存")); await task;
    expect(host.controller.appendAgentActionReceipt).not.toHaveBeenCalled();
    expect(host.pendingAgentActions).toContain(original);
    expect(host.controller.appendQualityLog).toHaveBeenCalledWith(expect.objectContaining({ errorCode: "AGENT_ACTION_FAILED" }));
  });

  it("does not persist a legacy void result by fabricating a receipt from its title", async () => {
    const { host, original, execution } = fixture();
    const task = host.acceptAgentSuggestion(original); execution.resolve(); await task;
    expect(host.agentReply).toBe("已执行：原确认卡");
    expect(host.controller.appendAgentActionReceipt).not.toHaveBeenCalled();
  });

  it.each(["throw", "true"])("does not overwrite a newer activity during awaited history %s", async outcome => {
    const { host, original, uiSpies } = fixture(); original.type = "weekly_review";
    const history = deferred<boolean>(), entered = deferred<void>();
    host.controller.executeAgentAction.mockResolvedValue("原操作真实回执");
    host.controller.appendAgentActionReceipt.mockImplementation(() => { entered.resolve(); return history.promise; });
    const task = host.acceptAgentSuggestion(original); await entered.promise;
    expect(host.pendingAgentActions).not.toContain(original);
    host.agentTextRequestGeneration++; host.setAgentBusy(true); host.agentReply = "新活动中";
    const replacement = card(original.id, "新活动卡"); host.pendingAgentActions = [replacement];
    uiSpies.forEach(spy => spy.mockClear());
    if (outcome === "throw") history.reject(new Error("history unknown")); else history.resolve(true);
    await task;
    expect(host.agentReply).toBe("新活动中"); expect(host.agentBusy).toBe(true); expect(host.pendingAgentActions).toEqual([replacement]);
    uiSpies.forEach(spy => expect(spy).not.toHaveBeenCalled()); expect(notices).toEqual([]);
    expect(host.controller.executeAgentAction).toHaveBeenCalledOnce();
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("completion dock retirement", () => {
  it.each(["none", "other", "same-id"])("retires the actual rendered card while history is still pending, preserving %s cards", async remaining => {
    const { host, original, other } = fixture();
    const survivor = remaining === "same-id" ? card(original.id, "同编号的另一张卡") : other;
    host.pendingAgentActions = remaining === "none" ? [original] : [original, survivor];
    const dock = liveDock(host), oldCard = dock.cards()[0];
    const oldButton = oldCard.findAll(element => element.classes.has("lifeops-agent-action-primary"))[0];
    const history = deferred<boolean>(), entered = deferred<void>();
    host.controller.executeAgentAction.mockResolvedValue("真实保存回执");
    host.controller.appendAgentActionReceipt.mockImplementation(() => { entered.resolve(); return history.promise; });
    const task = host.acceptAgentSuggestion(original);
    await entered.promise;
    expect(host.agentBusy).toBe(true);
    expect(oldCard.isConnected).toBe(false);
    expect(dock.count()).toBe(remaining === "none" ? "0" : "1");
    expect(dock.chip().disabled).toBe(remaining === "none");
    expect(dock.cards()).toHaveLength(remaining === "none" ? 0 : 1);
    expect(host.pendingAgentActions).toEqual(remaining === "none" ? [] : [survivor]);
    oldButton.click();
    expect(host.controller.executeAgentAction).toHaveBeenCalledOnce();
    expect(host.controller.appendAgentActionReceipt).toHaveBeenCalledOnce();
    history.resolve(true);
    await task;
    expect(host.controller.appendQualityLog).toHaveBeenCalledWith(expect.objectContaining({ userAcceptedActions: 1 }));
  });

  it("updates the current dock after a late fact commit without replacing a newer conversation", async () => {
    const { host, original, other, execution } = fixture();
    const dock = liveDock(host), oldCard = dock.cards()[0];
    const task = host.acceptAgentSuggestion(original);
    host.agentTextRequestGeneration++;
    host.agentReply = "新聊天自己的回复";
    host.agentMessages = [{ role: "assistant", content: host.agentReply }];
    (execution.resolve as (value: unknown) => void)("原操作已真实保存");
    await task;
    expect(oldCard.isConnected).toBe(false);
    expect(dock.count()).toBe("1");
    expect(host.pendingAgentActions).toEqual([other]);
    expect(host.agentReply).toBe("新聊天自己的回复");
    expect(host.agentMessages).toEqual([{ role: "assistant", content: "新聊天自己的回复" }]);
  });

  it("does not render a closed dock when the actual fact finishes", async () => {
    const { host, original, execution } = fixture();
    const dock = liveDock(host), oldCard = dock.cards()[0];
    const task = host.acceptAgentSuggestion(original);
    host.viewClosed = true;
    host.refreshAgentSuggestions.mockClear();
    execution.resolve();
    await task;
    expect(host.refreshAgentSuggestions).not.toHaveBeenCalled();
    expect(oldCard.isConnected).toBe(true);
    expect(dock.count()).toBe("2");
    expect(host.pendingAgentActions).not.toContain(original);
  });

  it("keeps the rendered card and count when execution did not commit", async () => {
    const { host, original, execution } = fixture();
    host.pendingAgentActions = [original];
    const dock = liveDock(host), oldCard = dock.cards()[0];
    const task = host.acceptAgentSuggestion(original);
    execution.reject(new Error("原资料改变，未执行"));
    await task;
    expect(oldCard.isConnected).toBe(true);
    expect(dock.count()).toBe("1");
    expect(host.pendingAgentActions).toEqual([original]);
    expect(host.controller.appendAgentActionReceipt).not.toHaveBeenCalled();
  });

  it("keeps the actual receipt and accepted audit when suggestion rendering keeps failing", async () => {
    const { host, original } = fixture();
    const diagnostic = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      host.refreshAgentSuggestions.mockImplementation(() => { throw new Error("display unavailable"); });
      host.controller.executeAgentAction.mockResolvedValue("实际保存成功");
      await host.acceptAgentSuggestion(original);
      expect(host.pendingAgentActions).not.toContain(original);
      expect(host.agentReply).toBe("实际保存成功");
      expect(host.agentBusy).toBe(false);
      expect(host.controller.appendAgentActionReceipt).toHaveBeenCalledExactlyOnceWith(original.title, "实际保存成功");
      expect(host.controller.appendQualityLog).toHaveBeenCalledExactlyOnceWith({ inputSource: "text", userAcceptedActions: 1, actionSuggestions: 1 });
      expect(notices).toEqual([]);
      expect(diagnostic).toHaveBeenCalledTimes(2);
    } finally { diagnostic.mockRestore(); }
  });

  it("allows a later real dock refresh to retry after a partial render failed", async () => {
    const { host, original } = fixture();
    host.pendingAgentActions = [original];
    const dock = liveDock(host), section = host.agentSuggestionsEl;
    const createDiv = section.createDiv.bind(section);
    section.createDiv = vi.fn().mockImplementationOnce(() => { throw new Error("temporary display failure"); }).mockImplementation(createDiv);
    const diagnostic = vi.spyOn(console, "warn").mockImplementation(() => {});
    const history = deferred<boolean>(), entered = deferred<void>();
    try {
      host.controller.executeAgentAction.mockResolvedValue("实际保存成功");
      host.controller.appendAgentActionReceipt.mockImplementation(() => { entered.resolve(); return history.promise; });
      const task = host.acceptAgentSuggestion(original);
      await entered.promise;
      expect(diagnostic).toHaveBeenCalledOnce();
      expect(host.pendingAgentActions).toEqual([]);
      host.refreshAgentSuggestions();
      expect(dock.count()).toBe("0");
      expect(dock.chip().disabled).toBe(true);
      expect(dock.cards()).toEqual([]);
      history.resolve(true);
      await task;
      expect(host.controller.appendQualityLog).toHaveBeenCalledWith(expect.objectContaining({ userAcceptedActions: 1 }));
    } finally { history.resolve(true); diagnostic.mockRestore(); }
  });
});

describe("confirmation and rejection lifecycle", () => {
  it.each(["note_understanding", "trading_change", "weekly_review", "idea_advance"] as const)("keeps a fixed %s payload read-only and requires its visible button", async type => {
    const { host, original } = fixture(); Object.assign(original, { type, content: "完整原文和固定版本载荷" });
    const { fields } = renderedCard(host, original); expect(fields.textarea[0].readOnly).toBe(true);
    fields.textarea[0].value = "误改"; fields.textarea[0].oninput(); expect(original.content).toBe("完整原文和固定版本载荷");
    host.pendingAgentActions = [original]; expect(await host.tryAcceptPendingActionFromVoice("确认")).toBe(false);
    host.controller.executeAgentAction.mockResolvedValue("已核验保存，原文未修改。"); await host.acceptAgentSuggestion(original);
    expect(host.agentMessages.at(-1)).toEqual({ role: "assistant", content: "已核验保存，原文未修改。" });
  });
  it("keeps a task plan read-only, blocks spoken acceptance, and reports its actual partial receipt", async () => {
    const { host, original } = fixture(); Object.assign(original, { type: "task_plan", taskPlanToken: "fictional-token", content: "两项完整安排" });
    const { fields } = renderedCard(host, original); expect(fields.textarea[0].readOnly).toBe(true);
    fields.textarea[0].value = "误改"; fields.textarea[0].oninput(); expect(original.content).toBe("两项完整安排");
    host.pendingAgentActions = [original]; expect(await host.tryAcceptPendingActionFromVoice("确认")).toBe(false);
    host.controller.executeAgentAction.mockResolvedValue("剩余安排已取消。已保存1项，任务仍为待办。");
    await host.acceptAgentSuggestion(original); expect(host.agentReply).toBe("剩余安排已取消。已保存1项，任务仍为待办。"); expect(host.pendingAgentActions).toHaveLength(0);
    expect(host.appendAgentMessage).toHaveBeenCalledWith({ role: "assistant", content: host.agentReply });
    expect(host.agentMessages.at(-1)).toEqual({ role: "assistant", content: host.agentReply });
    expect(host.scrollAgentTranscriptToBottom).toHaveBeenCalled();
  });
  it("releases the private review when a plan is explicitly rejected", async () => {
    const { host, original } = fixture(); original.type = "task_plan"; host.controller.dismissAgentAction = vi.fn();
    await host.dismissAgentSuggestion(original.id); expect(host.controller.dismissAgentAction).toHaveBeenCalledExactlyOnceWith(original);
  });
  it("does not select another task plan by a colliding ID", async () => {
    const { host, original, other } = fixture(); Object.assign(original, { type: "task_plan", taskPlanToken: "a" }); Object.assign(other, { id: original.id, type: "task_plan", taskPlanToken: "b" });
    host.controller.executeAgentAction.mockResolvedValue("第二张计划已处理"); await host.acceptAgentSuggestion(other);
    expect(host.controller.executeAgentAction).toHaveBeenCalledExactlyOnceWith(other); expect(host.pendingAgentActions).toEqual([original]);
    await host.acceptAgentSuggestion({ ...original }); expect(host.controller.executeAgentAction).toHaveBeenCalledOnce();
  });
  it("rejects synchronously before auditing, so a detached old confirm button cannot execute it", async () => {
    const { host, original, other } = fixture();
    const audit = deferred<void>();
    host.controller.appendQualityLog.mockImplementation(() => audit.promise);
    const rejection = host.dismissAgentSuggestion(original.id);
    expect(host.pendingAgentActions).toEqual([other]);
    expect(host.refreshAgentSuggestions).toHaveBeenCalledOnce();
    await host.acceptAgentSuggestion(original);
    expect(host.controller.executeAgentAction).not.toHaveBeenCalled();
    host.viewClosed = true;
    host.refreshAgentSuggestions.mockClear();
    audit.resolve();
    await rejection;
    expect(host.refreshAgentSuggestions).not.toHaveBeenCalled();
    expect(host.controller.appendQualityLog).toHaveBeenCalledWith({ inputSource: "text", rejectedActions: 1, actionSuggestions: 1 });
  });

  it("does not execute or audit an already absent card", async () => {
    const { host } = fixture();
    await host.acceptAgentSuggestion(card("gone"));
    await host.dismissAgentSuggestion("gone");
    expect(host.controller.executeAgentAction).not.toHaveBeenCalled();
    expect(host.controller.appendQualityLog).not.toHaveBeenCalled();
  });

  it("executes the current edited preview and keeps unrelated cards", async () => {
    const { host, original, other, execution } = fixture();
    host.updatePendingAgentAction(original.id, { content: "编辑后的内容" });
    const edited = host.pendingAgentActions[0];
    const task = host.acceptAgentSuggestion(original);
    expect(host.controller.executeAgentAction).toHaveBeenCalledWith(edited);
    expect(edited.content).toBe("编辑后的内容");
    execution.resolve();
    await task;
    expect(host.pendingAgentActions).toEqual([other]);
    expect(host.agentReply).toBe("已执行：原确认卡");
    expect(host.agentBusy).toBe(false);
  });

  it("keeps the rendered card's identity current after a normal preview edit", async () => {
    const { host, original, execution } = fixture();
    const { fields, callbacks } = renderedCard(host, original);
    fields.textarea[0].value = "在卡片预览里改好的内容";
    fields.textarea[0].oninput();
    const edited = host.pendingAgentActions[0];
    callbacks["确认"]();
    expect(host.controller.executeAgentAction).toHaveBeenCalledWith(edited);
    expect(edited.content).toBe("在卡片预览里改好的内容");
    execution.resolve();
    await vi.waitFor(() => expect(host.agentBusy).toBe(false));
  });

  it("detached old-card buttons and editors cannot operate on a replacement with the same ID", () => {
    const { host, original } = fixture();
    const { fields, callbacks } = renderedCard(host, original);
    const replacement = card(original.id, "另一个对象的新卡");
    host.pendingAgentActions = [replacement];
    fields.textarea[0].value = "来自旧卡的输入";
    fields.textarea[0].oninput();
    callbacks["确认"]();
    callbacks["拒绝"]();
    expect(host.pendingAgentActions).toEqual([replacement]);
    expect(replacement.content).toBe("另一个对象的新卡");
    expect(host.controller.executeAgentAction).not.toHaveBeenCalled();
    expect(host.controller.appendQualityLog).not.toHaveBeenCalled();
  });

  it("keeps visible editor and memory-file values equal to the approved data when edits are blocked by another busy activity", async () => {
    const { host, original, execution } = fixture();
    original.memoryFile = "个人画像.md";
    const { fields, callbacks } = renderedCard(host, original);
    host.setAgentBusy(true);
    fields.textarea[0].value = "忙碌期间未接受的新内容";
    fields.textarea[0].oninput();
    fields.select[0].value = "交易纪律.md";
    fields.select[0].onchange();
    expect(fields.textarea[0].value).toBe(original.content);
    expect(fields.select[0].value).toBe(original.memoryFile);
    host.setAgentBusy(false);
    callbacks["确认"]();
    expect(host.controller.executeAgentAction).toHaveBeenCalledWith(expect.objectContaining({
      content: fields.textarea[0].value, memoryFile: fields.select[0].value
    }));
    execution.resolve();
    await vi.waitFor(() => expect(host.agentBusy).toBe(false));
  });

  it("restores edits attempted during execution so retry after a failure still matches the visible preview", async () => {
    const { host, original, execution } = fixture();
    const { fields, callbacks } = renderedCard(host, original);
    const task = host.acceptAgentSuggestion(original);
    fields.textarea[0].value = "执行途中未获接受的内容";
    fields.textarea[0].oninput();
    expect(fields.textarea[0].value).toBe(original.content);
    execution.reject(new Error("临时失败"));
    await task;
    host.controller.executeAgentAction.mockResolvedValue(undefined);
    callbacks["确认"]();
    expect(host.controller.executeAgentAction).toHaveBeenLastCalledWith(expect.objectContaining({ content: fields.textarea[0].value }));
    await vi.waitFor(() => expect(host.agentBusy).toBe(false));
  });

  it.each(["closed", "busy"])("does not accept, reject, edit or consume a spoken confirmation while %s", async state => {
    const { host, original, uiSpies } = fixture();
    host.pendingAgentActions = [original];
    if (state === "closed") host.viewClosed = true;
    else host.setAgentBusy(true);
    uiSpies.forEach(spy => spy.mockClear());
    await host.acceptAgentSuggestion(original);
    await host.dismissAgentSuggestion(original.id);
    host.updatePendingAgentAction(original.id, { content: "不应改动" });
    expect(await host.tryAcceptPendingActionFromVoice("确认")).toBe(false);
    expect(host.pendingAgentActions).toEqual([original]);
    expect(host.controller.executeAgentAction).not.toHaveBeenCalled();
    expect(host.controller.appendQualityLog).not.toHaveBeenCalled();
    uiSpies.forEach(spy => expect(spy).not.toHaveBeenCalled());
  });

  it("cannot repeat, reject or edit an executing card even if another path clears the busy flag", async () => {
    const { host, original, execution } = fixture();
    const task = host.acceptAgentSuggestion(original);
    host.setAgentBusy(false);
    await host.acceptAgentSuggestion(original);
    await host.dismissAgentSuggestion(original.id);
    host.updatePendingAgentAction(original.id, { content: "执行途中改内容" });
    expect(host.controller.executeAgentAction).toHaveBeenCalledOnce();
    expect(host.pendingAgentActions[0]).toBe(original);
    expect(original.content).toBe("原确认卡");
    execution.resolve();
    await task;
  });

  it.each(["close", "new-chat", "new-activity"])("finishes the actual successful operation after %s without stale UI or deleting a same-ID new card", async reason => {
    const { host, original, other, execution, uiSpies } = fixture();
    const task = host.acceptAgentSuggestion(original);
    if (reason === "close") host.viewClosed = true;
    else if (reason === "new-chat") host.agentTextRequestGeneration += 1;
    else host.setAgentBusy(true);
    const newer = card(original.id, "同编号的新卡不能被旧完成回调删掉");
    host.pendingAgentActions = [original, other, newer];
    host.agentReply = "新页面自己的状态";
    uiSpies.forEach(spy => spy.mockClear());
    execution.resolve();
    await task;
    expect(host.pendingAgentActions).toEqual([other, newer]);
    expect(host.agentReply).toBe("新页面自己的状态");
    expect(host.controller.appendQualityLog).toHaveBeenCalledWith({ inputSource: "text", userAcceptedActions: 1, actionSuggestions: 1 });
    uiSpies.forEach(spy => {
      if (spy === host.refreshAgentSuggestions && reason !== "close") expect(spy).toHaveBeenCalledOnce();
      else expect(spy).not.toHaveBeenCalled();
    });
    expect(notices).toEqual([]);
  });

  it.each(["close", "new-chat", "new-activity"])("audits a real failure after %s without changing the current cards, reply or busy state", async reason => {
    const { host, original, execution, uiSpies } = fixture();
    const task = host.acceptAgentSuggestion(original);
    if (reason === "close") host.viewClosed = true;
    else if (reason === "new-chat") host.agentTextRequestGeneration += 1;
    else host.setAgentBusy(true);
    const pending = host.pendingAgentActions;
    host.agentReply = "目前状态";
    uiSpies.forEach(spy => spy.mockClear());
    execution.reject(new Error("资料已有后续修改"));
    await task;
    expect(host.pendingAgentActions).toBe(pending);
    expect(host.agentReply).toBe("目前状态");
    expect(host.controller.appendQualityLog).toHaveBeenCalledWith({ inputSource: "text", actionSuggestions: 1, errorCode: "AGENT_ACTION_FAILED", errorMessage: "资料已有后续修改" });
    uiSpies.forEach(spy => expect(spy).not.toHaveBeenCalled());
    expect(notices).toEqual([]);
  });

  it.each(["success", "failure"])("does not finish old %s UI after a new request starts during its audit", async outcome => {
    const { host, original, execution, uiSpies } = fixture();
    const audit = deferred<void>();
    const auditStarted = deferred<void>();
    host.controller.appendQualityLog.mockImplementation(() => { auditStarted.resolve(); return audit.promise; });
    const task = host.acceptAgentSuggestion(original);
    if (outcome === "success") execution.resolve();
    else execution.reject(new Error("当前操作未完成"));
    await auditStarted.promise;
    host.setAgentBusy(true);
    const newer = card(original.id, "审计期间新生成的卡");
    host.pendingAgentActions = [newer];
    host.agentReply = "新的活动处理中";
    uiSpies.forEach(spy => spy.mockClear());
    audit.resolve();
    await task;
    expect(host.agentBusy).toBe(true);
    expect(host.agentReply).toBe("新的活动处理中");
    expect(host.pendingAgentActions).toEqual([newer]);
    uiSpies.forEach(spy => expect(spy).not.toHaveBeenCalled());
    expect(notices).toEqual([]);
  });

  it("completes normally across ordinary page changes in the same conversation", async () => {
    const { host, original, other, execution } = fixture();
    const task = host.acceptAgentSuggestion(original);
    host.activePrimaryPage = "affairs";
    host.mode = "calendar";
    execution.resolve();
    await task;
    expect(host.pendingAgentActions).toEqual([other]);
    expect(host.agentReply).toBe("已执行：原确认卡");
    expect(host.agentBusy).toBe(false);
    expect(host.refreshAgentSuggestions).toHaveBeenCalledTimes(2);
  });

  it("shows a current failure once and permits a deliberate retry", async () => {
    const { host, original, execution } = fixture();
    const task = host.acceptAgentSuggestion(original);
    execution.reject(new Error("请重新生成确认卡"));
    await task;
    expect(notices).toEqual(["执行失败：请重新生成确认卡"]);
    expect(host.pendingAgentActions).toContain(original);
    expect(host.agentBusy).toBe(false);
    host.controller.executeAgentAction.mockResolvedValue(undefined);
    await host.acceptAgentSuggestion(original);
    expect(host.controller.executeAgentAction).toHaveBeenCalledTimes(2);
    expect(host.pendingAgentActions).not.toContain(original);
  });

  it("the actual voice confirmation handler does not refill UI after closing during execution", async () => {
    const { host, original, execution, uiSpies } = fixture();
    host.pendingAgentActions = [original];
    const task = host.sendAgentMessage("voice");
    expect(host.controller.executeAgentAction).toHaveBeenCalledOnce();
    host.viewClosed = true;
    host.agentTextRequestGeneration += 1;
    host.setAgentBusy(false);
    host.agentReply = "关闭时的状态";
    uiSpies.forEach(spy => spy.mockClear());
    execution.resolve();
    await task;
    expect(host.pendingAgentActions).toEqual([]);
    expect(host.agentReply).toBe("关闭时的状态");
    expect(host.controller.submitAgentMessageStream).not.toHaveBeenCalled();
    uiSpies.forEach(spy => expect(spy).not.toHaveBeenCalled());
  });

  it("an old model audit cannot resume voice or reset busy after a confirmation action takes ownership", async () => {
    const { host, original, execution, uiSpies } = fixture();
    const modelAudit = deferred<void>();
    const modelAuditStarted = deferred<void>();
    host.appendAgentQualityLog.mockImplementation(() => { modelAuditStarted.resolve(); return modelAudit.promise; });
    const modelTask = host.sendAgentMessage("text");
    await modelAuditStarted.promise;
    expect(host.agentBusy).toBe(false);
    const actionTask = host.acceptAgentSuggestion(original);
    expect(host.agentBusy).toBe(true);
    host.agentInput = "确认执行期间的草稿";
    const executingReply = host.agentReply;
    uiSpies.forEach(spy => spy.mockClear());
    modelAudit.resolve();
    await modelTask;
    expect(host.agentBusy).toBe(true);
    expect(host.agentInput).toBe("确认执行期间的草稿");
    expect(host.agentReply).toBe(executingReply);
    uiSpies.forEach(spy => expect(spy).not.toHaveBeenCalled());
    execution.resolve();
    await actionTask;
    expect(host.agentBusy).toBe(false);
  });

  it("advances the shared activity generation on every busy start, including takeover of an already busy activity", () => {
    const { host } = fixture();
    expect(host.agentActivityGeneration).toBeUndefined();
    host.setAgentBusy(true);
    expect(host.agentActivityGeneration).toBe(1);
    host.setAgentBusy(false);
    expect(host.agentActivityGeneration).toBe(1);
    host.setAgentBusy(true);
    host.setAgentBusy(true);
    expect(host.agentActivityGeneration).toBe(3);
  });
});
