import { afterEach, describe, expect, it, vi } from "vitest";
import { renderTodayCard } from "../src/panel/todayCard";
import type { TodayCardData } from "../src/features/today/model";

const notices = vi.hoisted(() => [] as string[]);
vi.mock("obsidian", () => ({
  Notice: class { constructor(message: string) { notices.push(message); } }, ItemView: class {}, WorkspaceLeaf: class {}, Modal: class {},
  setIcon: vi.fn()
}));
const { LifeOpsView } = await import("../src/lifeOpsView");

class EventSurface {
  innerHeight = 800;
  listeners: Record<string, Array<(event: any) => void>> = {};
  addEventListener(type: string, handler: (event: any) => void) { (this.listeners[type] ??= []).push(handler); }
  removeEventListener(type: string, handler: (event: any) => void) {
    this.listeners[type] = (this.listeners[type] ?? []).filter(listener => listener !== handler);
  }
  emit(type: string, event: any = {}) { this.listeners[type]?.slice().forEach(handler => handler(event)); }
}
afterEach(() => { notices.length = 0; vi.unstubAllGlobals(); });

// Exercise production renderers and their handlers, replacing only the host DOM.
// Native details/keyboard defaults and physical layout are covered by browser QA.
class Element extends EventSurface {
  children: Element[] = [];
  attributes: Record<string, string> = {};
  dataset: Record<string, string> = {};
  classes = new Set<string>();
  hidden = false;
  disabled = false;
  open = false;
  value = "";
  textContent = "";
  parent: Element | null = null;
  onclick?: () => unknown;
  style: Record<string, string> = {};
  clientTop = 0;
  clientHeight = 700;
  scrollTop = 0;
  rect = { top: 400, bottom: 440, width: 400, height: 40 };
  scrollIntoView = vi.fn();
  constructor(public tag = "div", public ownerDocument: {
    activeElement: Element | null; defaultView: EventSurface; documentElement: { clientHeight: number }
  } = { activeElement: null, defaultView: new EventSurface(), documentElement: { clientHeight: 800 } }) { super(); }
  createEl(tag: string, options: any = {}, callback?: (element: any) => void): any {
    const child = new Element(tag, this.ownerDocument);
    child.parent = this;
    child.textContent = options.text ?? "";
    child.classes = new Set((options.cls ?? "").split(" ").filter(Boolean));
    for (const [name, value] of Object.entries(options.attr ?? {})) child.setAttribute(name, value as string);
    this.children.push(child);
    callback?.(child);
    return child;
  }
  createDiv(options?: any) { return this.createEl("div", options); }
  createSpan(options?: any) { return this.createEl("span", options); }
  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
    if (name.startsWith("data-")) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
  }
  setAttr(name: string, value: string) { this.setAttribute(name, value); }
  getAttribute(name: string) { return this.attributes[name] ?? null; }
  toggleClass(name: string, on: boolean) { if (on) this.classes.add(name); else this.classes.delete(name); }
  empty() { this.children.forEach(child => child.parent = null); this.children = []; }
  all(): Element[] { return [this, ...this.children.flatMap(child => child.all())]; }
  contains(element: Element | null) { return !!element && this.all().includes(element); }
  text(): string { return this.textContent + this.children.map(child => child.text()).join(""); }
  querySelector(selector: string): any { return this.querySelectorAll(selector)[0] ?? null; }
  closest(selector: string): Element | null {
    for (let current: Element | null = this; current; current = current.parent) {
      if (selector.startsWith(".") && current.classes.has(selector.slice(1))) return current;
    }
    return null;
  }
  getBoundingClientRect() { return this.rect; }
  querySelectorAll(selector: string): Element[] {
    return this.all().slice(1).filter(element => {
      const tag = selector.match(/^[a-z]+/)?.[0];
      if (tag && element.tag !== tag) return false;
      for (const match of selector.matchAll(/\.([\w-]+)/g)) if (!element.classes.has(match[1])) return false;
      for (const match of selector.matchAll(/\[([^=\]]+)(?:="([^"]*)")?\]/g)) {
        if (!(match[1] in element.attributes)) return false;
        if (match[2] !== undefined && element.attributes[match[1]] !== match[2]) return false;
      }
      return true;
    });
  }
  focus() { this.ownerDocument.activeElement = this; }
  click() { if (!this.disabled) return this.onclick?.(); }
}

describe("today card interaction", () => {
  it("renders the warning and source quote and starts only one add while a click is saving", async () => {
    class CardElement extends Element {
      set className(value: string) { this.classes = new Set(value.split(" ").filter(Boolean)); }
      get isConnected() { return this.tag === "main" || this.parent?.contains(this) === true; }
      append(node: Element) { node.parent = this; this.children.push(node); }
      replaceChildren() { this.empty(); }
    }
    const host = new CardElement("main");
    Object.assign(host.ownerDocument, { createElement: (tag: string) => new CardElement(tag, host.ownerDocument) });
    const plan = { title: "跑5公里", text: "跑5公里", when: "明天", date: "2026-11-13", journalDate: "2026-11-12",
      source: { path: "虚构日记.md", sha256: "a".repeat(64) } };
    const data: TodayCardData = {
      date: plan.journalDate, status: [{ label: "精力", value: "2/5", quote: "今天精力 2 分" }],
      completed: 3, total: 12, capacity: { overloaded: true, plannedCount: 9, typicalCount: 6, plannedMin: 270,
        typicalMin: 180, suggestDefer: [] },
      priorities: [{ id: "one", title: "见客户", reasons: ["今天到期"] }],
      habits: [], penalties: [], compensationSummary: "", plans: [{ plan, added: false }]
    };
    let finish!: () => void;
    const add = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    renderTodayCard(host as unknown as HTMLElement, data, add);
    expect(host.querySelector(".lh-today-overload").text()).toContain("3 / 12");
    expect(host.querySelector(".lh-today-overload").text()).toContain("待做 9 项（含逾期），平时约完成 6 项");
    const state = host.querySelector("details");
    expect(state.open).toBe(false);
    expect(state.text()).toContain("今天精力 2 分");
    const button = host.querySelector("button");
    expect(add).not.toHaveBeenCalled();
    const pending = button.click();
    button.click();
    expect(add).toHaveBeenCalledExactlyOnceWith(plan);
    finish();
    await pending;
    expect(button.textContent).toBe("已添加");
    expect(button.disabled).toBe(true);
    state.open = true;
    renderTodayCard(host as unknown as HTMLElement, { ...data, plans: [{ plan, added: true }] }, add);
    expect(host.querySelector("details").open).toBe(true);
  });
});

function view() {
  const cleanups: Array<() => void> = [];
  return Object.assign(Object.create(LifeOpsView.prototype), {
    componentCleanups: cleanups, register: vi.fn((cleanup: () => void) => cleanups.push(cleanup)),
    viewClosed: false, pendingAgentActions: [], proactiveCandidates: [], taskFilter: "today", taskSearch: "", mode: "tasks",
    render: vi.fn(async () => {}), renderAgentSuggestionCard: vi.fn((parent: Element) => parent.createDiv({ text: "确认卡" })),
    renderTodayTaskGroups: vi.fn(), renderTaskList: vi.fn(), renderGroupedTaskView: vi.fn(),
    controller: {
      openTaskModal: vi.fn(), openTaskModalWithDefaults: vi.fn(), openHabitModal: vi.fn(), openLocalRecordNote: vi.fn(),
      openLocalRecordPicker: vi.fn(), openQuickCapture: vi.fn(), openHealthEntryModal: vi.fn(), openTradeEntryModal: vi.fn(),
      respondToProactiveCandidate: vi.fn(async () => {}), generateDailyReview: vi.fn(), generateTradingReview: vi.fn()
    }
  }) as any;
}
const board = { date: "2026-09-23", today: [], overdue: [], tomorrow: [], nextSevenDays: [], noDate: [], completedToday: [], allActive: [], tasks: [], habits: [] };
const stats = { morningNoteExists: false, eveningNoteExists: false, recentThinkingNotes: [], recentTradingReviews: [], recentOutputs: [] };
const action = { id: "one", title: "写入任务", type: "create_task", content: "确认前不写入" };
const candidate = { id: "candidate", title: "明日安排", reason: "请确认", priority: "normal" };
function suggestions(host = view()) {
  const root = new Element();
  root.classes.add("lifeops-steward-conversation");
  root.rect = { top: 100, bottom: 800, width: 400, height: 700 };
  host.renderAgentSuggestions(root);
  return { host, root, section: host.agentSuggestionsEl as Element };
}
function chip(root: Element, kind = "actions") { return root.querySelector(`[data-suggestion-kind="${kind}"]`) as Element; }
function detail(root: Element, kind = "actions") { return chip(root, kind).parent!.querySelector(".lifeops-agent-suggestion-popover") as Element; }

const proactiveChoices = [["接受", "accepted"], ["稍后", "snoozed"], ["忽略", "dismissed"], ["不再提醒", "never"]] as const;
function proactiveButtons(root: Element) { return root.querySelectorAll(".lifeops-agent-proactive-action"); }
function proactivePress(button: Element) { return button.listeners.click[0]({}); }
async function settleFeedback() { await new Promise(resolve => setTimeout(resolve, 0)); }

describe("proactive feedback button outcomes", () => {
  it.each(proactiveChoices)("reports %s failure and retains a working retry", async (label, decision) => {
    const host = view(); host.proactiveCandidates = [candidate];
    host.controller.respondToProactiveCandidate.mockRejectedValueOnce(new Error("synthetic private failure"));
    const { root } = suggestions(host), buttons = proactiveButtons(root);
    const button = buttons.find(item => item.textContent === label)!;
    await proactivePress(button); await settleFeedback();
    expect(host.controller.respondToProactiveCandidate).toHaveBeenCalledExactlyOnceWith(candidate.id, decision);
    expect(notices).toEqual([expect.stringContaining("提醒处理未完成")]);
    expect(notices.join()).not.toContain("synthetic private failure");
    expect(host.proactiveCandidates).toEqual([candidate]);
    expect(host.render).not.toHaveBeenCalled();
    expect(buttons.every(item => !item.disabled)).toBe(true);
    await proactivePress(button); await settleFeedback();
    expect(host.controller.respondToProactiveCandidate).toHaveBeenCalledTimes(2);
    expect(host.render).toHaveBeenCalledOnce();
  });

  it.each(proactiveChoices)("refreshes %s after a successful response", async (label, decision) => {
    const host = view(); host.proactiveCandidates = [candidate];
    const { root } = suggestions(host), button = proactiveButtons(root).find(item => item.textContent === label)!;
    await proactivePress(button); await settleFeedback();
    expect(host.controller.respondToProactiveCandidate).toHaveBeenCalledExactlyOnceWith(candidate.id, decision);
    expect(host.render).toHaveBeenCalledOnce(); expect(notices).toEqual([]);
  });

  it("handles a synchronous controller failure without leaving disabled controls", async () => {
    const host = view(); host.proactiveCandidates = [candidate];
    host.controller.respondToProactiveCandidate.mockImplementationOnce(() => { throw new Error("synthetic synchronous failure"); });
    const { root } = suggestions(host), buttons = proactiveButtons(root);
    await proactivePress(buttons[0]);
    expect(notices).toEqual([expect.stringContaining("提醒处理未完成")]);
    expect(buttons.every(button => !button.disabled)).toBe(true); expect(host.render).not.toHaveBeenCalled();
  });

  it("blocks duplicate and competing choices while a response is pending", async () => {
    const host = view(); host.proactiveCandidates = [candidate];
    let finish!: () => void;
    host.controller.respondToProactiveCandidate.mockReturnValueOnce(new Promise<void>(resolve => { finish = resolve; }));
    const { root } = suggestions(host), buttons = proactiveButtons(root), first = proactivePress(buttons[0]);
    const disabledWhilePending = buttons.every(button => button.disabled);
    proactivePress(buttons[0]); proactivePress(buttons[1]);
    const callsWhilePending = host.controller.respondToProactiveCandidate.mock.calls.length;
    finish(); await first; await settleFeedback();
    expect(disabledWhilePending).toBe(true); expect(callsWhilePending).toBe(1);
    expect(host.render).toHaveBeenCalledOnce(); expect(buttons.every(button => !button.disabled)).toBe(true);
  });

  it.each(["sync", "async"])("keeps an operation successful when %s rendering fails", async mode => {
    const host = view(); host.proactiveCandidates = [candidate];
    host.render.mockImplementationOnce(() => { if (mode === "sync") throw new Error("synthetic render failure"); return Promise.reject(new Error("synthetic render failure")); });
    const { root } = suggestions(host), buttons = proactiveButtons(root);
    await proactivePress(buttons[0]); await settleFeedback();
    expect(host.controller.respondToProactiveCandidate).toHaveBeenCalledOnce(); expect(host.render).toHaveBeenCalledOnce();
    expect(notices).toEqual([expect.stringContaining("提醒已经处理，但页面更新失败")]);
    expect(notices.join()).not.toContain("提醒处理未完成"); expect(notices.join()).not.toContain("synthetic render failure");
    expect(buttons.every(button => !button.disabled)).toBe(true);
  });
});

describe("daily suggestion controls", () => {
  it("disables zero counts and creates no empty popup", () => {
    const { root } = suggestions();
    expect(chip(root).disabled).toBe(true);
    expect(chip(root, "proactive").disabled).toBe(true);
    expect(root.querySelectorAll(".lifeops-agent-suggestion-popover")).toHaveLength(0);
  });

  it("opens only on explicit click, closes with its button and restores focus", () => {
    const host = view(); host.pendingAgentActions = [action];
    const { root } = suggestions(host);
    const button = chip(root), popup = detail(root);
    expect(popup.hidden).toBe(true);
    button.parent!.emit("mouseenter", {});
    button.focus();
    expect(popup.hidden).toBe(true);
    button.click();
    expect(popup.hidden).toBe(false);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(button.getAttribute("aria-controls")).toBe(popup.getAttribute("id"));
    popup.querySelector(".lifeops-agent-suggestion-close").click();
    expect(popup.hidden).toBe(true);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(root.ownerDocument.activeElement).toBe(button);
  });

  it("supports Escape and leaving with the keyboard, with only one popup open", () => {
    const host = view(); host.pendingAgentActions = [action]; host.proactiveCandidates = [candidate];
    const { root } = suggestions(host);
    chip(root).click();
    chip(root, "proactive").click();
    expect(detail(root).hidden).toBe(true);
    const event = { key: "Escape", preventDefault: vi.fn(), stopPropagation: vi.fn() };
    chip(root, "proactive").parent!.emit("keydown", event);
    expect(detail(root, "proactive").hidden).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(root.ownerDocument.activeElement).toBe(chip(root, "proactive"));
    chip(root).click();
    chip(root).parent!.emit("focusout", { relatedTarget: new Element() });
    expect(detail(root).hidden).toBe(true);
  });

  it("keeps an explicitly opened list during a refresh and removes it after the last action", () => {
    const host = view(); host.pendingAgentActions = [action];
    const { root } = suggestions(host);
    host.agentInputEl = new Element("textarea", root.ownerDocument);
    chip(root).click();
    host.pendingAgentActions = [action, { ...action, id: "two" }];
    host.refreshAgentSuggestions();
    expect(detail(root).hidden).toBe(false);
    host.pendingAgentActions = [];
    host.refreshAgentSuggestions();
    expect(chip(root).disabled).toBe(true);
    expect(root.querySelector(".lifeops-agent-suggestion-popover")).toBeNull();
    expect(root.ownerDocument.activeElement).toBe(host.agentInputEl);
  });

  it("connects the top pending entry to the same popup without toggling it closed", async () => {
    const host = view(); host.pendingAgentActions = [action];
    const { root } = suggestions(host);
    host.navigateSteward = vi.fn(async () => {});
    await host.openStewardPending();
    await host.openStewardPending();
    expect(host.navigateSteward).toHaveBeenCalledWith("chat");
    expect(detail(root).hidden).toBe(false);
    host.pendingAgentActions = [];
    host.refreshAgentSuggestions();
    await host.openStewardPending();
    expect(root.querySelector(".lifeops-agent-suggestion-popover")).toBeNull();
  });

  it("fits above or below the trigger within the visible chat area", () => {
    const host = view(); host.pendingAgentActions = [action];
    const { root } = suggestions(host);
    root.rect = { top: 240, bottom: 740, width: 400, height: 500 };
    root.clientHeight = 500;
    const button = chip(root), popup = detail(root), trigger = button.parent!;
    trigger.rect = { top: 500, bottom: 536, width: 400, height: 36 };
    button.click();
    expect(popup.style).toMatchObject({ top: "auto", bottom: "calc(100% + 8px)", maxHeight: "244px" });
    const popupTop = trigger.rect.top - 8 - Number.parseInt(popup.style.maxHeight);
    expect(popupTop).toBeGreaterThanOrEqual(root.rect.top + 8);
    button.click();
    trigger.rect = { top: 260, bottom: 296, width: 400, height: 36 };
    button.click();
    expect(popup.style).toMatchObject({ top: "calc(100% + 8px)", bottom: "auto", maxHeight: "360px" });
    expect(trigger.rect.bottom + 8 + Number.parseInt(popup.style.maxHeight)).toBeLessThanOrEqual(root.rect.bottom - 8);
    expect(trigger.rect.height).toBe(36);
  });

  it("respects viewport clipping and refuses an inaccessible short popup", () => {
    const host = view(); host.pendingAgentActions = [action];
    const { root } = suggestions(host);
    root.ownerDocument.defaultView.innerHeight = 380;
    root.rect = { top: 240, bottom: 740, width: 400, height: 500 };
    root.clientHeight = 500;
    const button = chip(root), popup = detail(root);
    button.parent!.rect = { top: 260, bottom: 296, width: 400, height: 36 };
    button.click();
    expect(popup.style.maxHeight).toBe("68px");
    button.click();
    root.ownerDocument.defaultView.innerHeight = 340;
    button.click();
    expect(popup.hidden).toBe(true);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(root.listeners.scroll).toHaveLength(0);
    button.parent!.rect = { top: 600, bottom: 636, width: 400, height: 36 };
    button.click();
    expect(popup.hidden).toBe(true);
  });

  it("cleans scroll and resize listeners on close, refresh and view unload", () => {
    const host = view(); host.pendingAgentActions = [action];
    const { root } = suggestions(host);
    chip(root).click();
    expect(root.listeners.scroll).toHaveLength(1);
    detail(root).emit("scroll");
    expect(detail(root).hidden).toBe(false);
    root.emit("scroll");
    expect(detail(root).hidden).toBe(true);
    expect(root.listeners.scroll).toHaveLength(0);
    expect(root.ownerDocument.defaultView.listeners.resize).toHaveLength(0);
    chip(root).click();
    root.ownerDocument.defaultView.emit("resize");
    expect(detail(root).hidden).toBe(true);
    chip(root).click();
    host.pendingAgentActions = [action, { ...action, id: "two" }];
    host.refreshAgentSuggestions();
    expect(detail(root).hidden).toBe(false);
    expect(root.listeners.scroll).toHaveLength(1);
    expect(root.ownerDocument.defaultView.listeners.resize).toHaveLength(1);
    expect(host.componentCleanups).toHaveLength(1);
    host.componentCleanups[0]();
    expect(detail(root).hidden).toBe(true);
    expect(root.listeners.scroll).toHaveLength(0);
    expect(root.ownerDocument.defaultView.listeners.resize).toHaveLength(0);
  });

  it("ignores the initial size observation and closes when the pane is resized", () => {
    let notify!: () => void;
    const disconnect = vi.fn();
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { notify = callback; }
      observe = vi.fn(); disconnect = disconnect;
    });
    const host = view(); host.pendingAgentActions = [action];
    const { root } = suggestions(host);
    chip(root).click();
    notify();
    expect(detail(root).hidden).toBe(false);
    root.rect = { ...root.rect, width: 300 };
    notify();
    expect(detail(root).hidden).toBe(true);
    expect(disconnect).toHaveBeenCalledOnce();
    chip(root).click();
    expect(detail(root).hidden).toBe(false);
  });
});

describe("daily affairs controls", () => {
  it("preserves every filter while grouping less frequent choices", async () => {
    const host = view(), root = new Element();
    host.renderTasks(root, board);
    const more = root.querySelector(".lifeops-task-filters-more");
    expect(more.open).toBe(false);
    expect(root.querySelector(".lifeops-task-filters-common").querySelectorAll("button")).toHaveLength(5);
    const filters = root.querySelectorAll("[data-lifeops-task-filter]");
    expect(filters).toHaveLength(13);
    const byDate = root.querySelector('[data-lifeops-task-filter="by-date"]');
    expect(more.contains(byDate)).toBe(true);
    await byDate.click();
    expect(host.taskFilter).toBe("by-date");
    expect(host.render).toHaveBeenCalledOnce();
    const refreshed = new Element();
    host.renderTasks(refreshed, board);
    expect(refreshed.querySelector(".lifeops-task-filters-more").open).toBe(true);
    expect(refreshed.querySelector('[data-lifeops-task-filter="by-date"]').getAttribute("aria-pressed")).toBe("true");
  });

  it.each(["tasks", "matrix", "habits", "calendar"])("retains %s navigation and exactly one main creation action", async mode => {
    const host = view(), root = new Element();
    host.mode = mode;
    host.renderTasks = vi.fn(); host.renderMatrix = vi.fn(); host.renderHabits = vi.fn(); host.renderCalendar = vi.fn();
    host.renderStewardAffairs(root, stats, board);
    const primary = root.querySelectorAll(".lifeops-tool-button.is-primary");
    expect(primary).toHaveLength(1);
    primary[0].click();
    if (mode === "habits") expect(host.controller.openHabitModal).toHaveBeenCalledOnce();
    else if (mode === "tasks") expect(host.controller.openTaskModalWithDefaults).toHaveBeenCalledWith({ date: board.date });
    else expect(host.controller.openTaskModal).toHaveBeenCalledOnce();
    const nav = root.querySelector(".lifeops-mode-nav").querySelectorAll("button");
    expect(nav.map((button: Element) => button.text())).toEqual(["任务中心", "四象限", "习惯打卡", "日历"]);
    const records = root.querySelector(".lifeops-affairs-record-menu");
    expect(records.open).toBe(false);
    const morning = records.querySelectorAll("button").find((button: Element) => button.text() === "晨间日记");
    morning.click();
    expect(host.controller.openLocalRecordNote).toHaveBeenCalledWith("morning");
    await nav[3].click();
    expect(host.mode).toBe("calendar");
  });
});
