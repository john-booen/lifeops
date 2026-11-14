import { setIcon } from "obsidian";
import { taskScheduleLabel } from "../taskSchedule";
import type { DashboardStats, HabitDashboardItem, LifeOpsTask, TaskDashboardData } from "../types";
import type { LocalRecordKind } from "../localRecordNotes";

export type StewardPage = "today" | "chat" | "affairs" | "records" | "about";

export interface StewardShellOptions {
  page: StewardPage;
  onNavigate(page: StewardPage): void;
  onPending(): void;
  onOperations(): void;
  onSettings(): void;
  pendingCount: number;
}

export interface StewardShell {
  element: HTMLElement;
  header: HTMLElement;
  utilityHost: HTMLElement;
  main: HTMLElement;
  conversationHost: HTMLElement;
  navButtons: HTMLButtonElement[];
  setPage(page: StewardPage): void;
  setAssistantName(name: string): void;
  updatePendingCount(count: number): void;
}

const pages: ReadonlyArray<{ page: StewardPage; label: string; icon: string }> = [
  { page: "today", label: "今天", icon: "sun" },
  { page: "chat", label: "对话", icon: "messages-square" },
  { page: "affairs", label: "事务", icon: "layout-grid" },
  { page: "records", label: "记录库", icon: "library" },
  { page: "about", label: "关于我", icon: "user-round" }
];

/** Build once per view. Navigation never reparents the live conversation or media DOM. */
export function renderStewardShell(container: HTMLElement, options: StewardShellOptions): StewardShell {
  const element = append(container, "div", "lifeops-steward is-neural-shell");
  const sidebar = append(element, "aside", "lifeops-steward-sidebar");
  const brand = append(sidebar, "div", "lifeops-steward-brand");
  icon(brand, "sparkles", "lifeops-steward-brand-mark");
  const brandCopy = append(brand, "div", "lifeops-steward-brand-copy");
  const brandName = append(brandCopy, "div", "lifeops-steward-brand-name", "管家");
  append(brandCopy, "span", "lifeops-steward-brand-caption", "LifeOps");

  const nav = append(sidebar, "nav", "lifeops-steward-nav");
  nav.setAttribute("aria-label", "管家主导航");
  const navButtons = pages.map(({ page, label, icon: iconName }) => {
    const item = button(nav, label, () => options.onNavigate(page), "lifeops-steward-nav-button", iconName);
    item.dataset.page = page;
    return item;
  });

  const header = append(sidebar, "div", "lifeops-steward-header");
  const pageLabel = append(header, "div", "lifeops-steward-page-label");
  const utilities = append(header, "div", "lifeops-steward-utilities");
  const pending = button(utilities, "待确认", options.onPending, "lifeops-steward-utility-button", "inbox");
  const pendingLabel = pending.querySelector<HTMLElement>(".lifeops-steward-button-label")!;
  button(utilities, "最近操作", options.onOperations, "lifeops-steward-utility-button", "history");
  button(utilities, "设置", options.onSettings, "lifeops-steward-utility-button", "settings");

  const content = append(element, "div", "lifeops-steward-content");
  const utilityHost = append(content, "div", "lifeops-steward-utility-host");
  const main = append(content, "div", "lifeops-steward-main lifeops-app");
  main.setAttribute("role", "region");
  const conversationHost = append(content, "div", "lifeops-steward-conversation");
  conversationHost.setAttribute("role", "region");
  conversationHost.setAttribute("aria-label", "管家对话");

  const setPage = (page: StewardPage): void => {
    element.dataset.page = page;
    const label = pages.find((item) => item.page === page)!.label;
    pageLabel.textContent = label;
    main.setAttribute("aria-label", label);
    main.hidden = page === "chat";
    conversationHost.hidden = page !== "chat";
    for (const item of navButtons) {
      if (item.dataset.page === page) item.setAttribute("aria-current", "page");
      else item.removeAttribute("aria-current");
    }
  };

  const updatePendingCount = (count: number): void => {
    const safeCount = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
    pendingLabel.textContent = safeCount > 0 ? `待确认 · ${safeCount}` : "待确认";
    pending.setAttribute("aria-label", safeCount > 0 ? `待确认，${safeCount} 项操作` : "待确认，暂无待确认操作");
    pending.classList.toggle("has-pending", safeCount > 0);
  };

  setPage(options.page);
  updatePendingCount(options.pendingCount);
  return { element, header, utilityHost, main, conversationHost, navButtons, setPage, updatePendingCount, setAssistantName: name => { brandName.textContent = name; } };
}

export interface StewardTodayOptions {
  stats: DashboardStats;
  board: TaskDashboardData;
  onOpenTasks(filter: string): void;
  onQuickCapture(): void;
  onChat(): void;
  onOpenHabits?(): void;
  onOpenRecord?(kind: LocalRecordKind): void;
  onRecordPicker?(): void;
  onNewTask?(): void;
}

/** This overview is a view of saved facts, not an inferred personal briefing. */
export function renderStewardToday(main: HTMLElement, options: StewardTodayOptions): void {
  const { board, stats } = options;
  const today = append(main, "section", "lifeops-steward-today");
  const intro = append(today, "div", "lifeops-steward-intro");
  append(intro, "div", "lifeops-steward-eyebrow", board.date);
  append(intro, "h1", "lifeops-steward-heading", "今天，先从这里开始");
  append(intro, "p", "lifeops-steward-muted", "看看已记录的安排，也可以随时记下一件事，或继续对话。");

  const actions = append(intro, "div", "lifeops-steward-actions");
  button(actions, "记下一件事", options.onQuickCapture, "lifeops-steward-primary", "square-pen");
  button(actions, "与管家对话", options.onChat, "lifeops-steward-secondary", "messages-square");

  if (options.onOpenRecord) {
    const records = append(today, "section", "lifeops-steward-card lifeops-steward-local-records");
    append(records, "h2", "lifeops-steward-card-title", "先把今天记下来");
    append(records, "p", "lifeops-steward-muted", "日记和复盘直接打开笔记书写，Obsidian 自动保存。文字记录不需要开启 AI。");
    const entries = append(records, "div", "lifeops-steward-actions");
    button(entries, "晨间日记", () => options.onOpenRecord!("morning"), "lifeops-steward-primary", "sunrise");
    button(entries, "晚间日记", () => options.onOpenRecord!("evening"), "lifeops-steward-secondary", "moon");
    button(entries, "写交易复盘", () => options.onOpenRecord!("trading-review"), "lifeops-steward-secondary", "notebook-pen");
    if (options.onNewTask) button(entries, "新建待办", options.onNewTask, "lifeops-steward-secondary", "plus");
    if (options.onOpenHabits) button(entries, "习惯打卡", options.onOpenHabits, "lifeops-steward-secondary", "check-check");
    if (options.onRecordPicker) button(entries, "按日期打开记录", options.onRecordPicker, "lifeops-steward-text-button", "calendar-days");
  }

  const metrics = append(today, "div", "lifeops-steward-metrics");
  metric(metrics, "今日待办", board.today.length, "查看今天的安排", () => options.onOpenTasks("today"));
  metric(metrics, "过期任务", board.overdue.length, board.overdue.length ? "看看哪些需要重新安排" : "目前没有过期任务", () => options.onOpenTasks("overdue"), board.overdue.length > 0);
  metric(metrics, "还没定日期", board.noDate.length, "查看无日期任务", () => options.onOpenTasks("no-date"));

  const grid = append(today, "div", "lifeops-steward-today-grid");
  taskOverview(grid, "今日安排", board.today, "今天还没有安排任务。", "查看今日任务", () => options.onOpenTasks("today"));
  const habits = append(grid, "section", "lifeops-steward-card");
  const habitHead = append(habits, "div", "lifeops-steward-card-head");
  append(habitHead, "h2", "lifeops-steward-card-title", "习惯概览");
  if (options.onOpenHabits) button(habitHead, "查看习惯", options.onOpenHabits, "lifeops-steward-text-button");
  if (board.habits.length === 0) {
    append(habits, "p", "lifeops-steward-empty", "还没有添加习惯。可以到事务里建立自己的习惯。");
  } else {
    append(habits, "p", "lifeops-steward-muted", `今日打卡 ${stats.habitDone} / ${stats.habitTotal}`);
    const required = board.habits.filter((item) => item.requiredToday);
    if (required.length === 0) {
      append(habits, "p", "lifeops-steward-empty", "今天没有需要打卡的习惯。");
    } else {
      const list = append(habits, "ul", "lifeops-steward-list");
      for (const item of required.slice(0, 4)) {
        const row = append(list, "li", "lifeops-steward-list-row");
        append(row, "span", "lifeops-steward-row-title", item.habit.name);
        append(row, "span", "lifeops-steward-row-meta", habitStatus(item));
      }
      if (required.length > 4) append(habits, "p", "lifeops-steward-muted", `另有 ${required.length - 4} 个今日习惯，可到事务查看。`);
    }
  }

  if (board.overdue.length > 0) {
    taskOverview(today, "需要重新看看", board.overdue, "目前没有过期任务。", "查看过期任务", () => options.onOpenTasks("overdue"), true);
  }
  const complete = append(today, "div", "lifeops-steward-completion");
  append(complete, "span", "lifeops-steward-muted", board.completedToday.length > 0 ? `今天已完成 ${board.completedToday.length} 项任务。` : "今天暂时还没有完成记录。");
  button(complete, "查看完成记录", () => options.onOpenTasks("completed"), "lifeops-steward-text-button");
}

function taskOverview(parent: HTMLElement, title: string, tasks: LifeOpsTask[], empty: string, actionLabel: string, action: () => void, overdue = false): void {
  const section = append(parent, "section", "lifeops-steward-card");
  const head = append(section, "div", "lifeops-steward-card-head");
  append(head, "h2", "lifeops-steward-card-title", title);
  button(head, actionLabel, action, "lifeops-steward-text-button");
  if (tasks.length === 0) {
    append(section, "p", "lifeops-steward-empty", empty);
    return;
  }
  const list = append(section, "ul", "lifeops-steward-list");
  for (const task of tasks.slice(0, 4)) {
    const item = append(list, "li", "lifeops-steward-list-row");
    append(item, "span", "lifeops-steward-row-title", task.title);
    const meta = overdue
      ? task.dueDate ? `截止 ${task.dueDate}${task.dueTime ? ` ${task.dueTime}` : ""}` : task.date || "未定日期"
      : [taskScheduleLabel(task), task.project || task.category].filter(Boolean).join(" · ") || "未定具体时间";
    append(item, "span", "lifeops-steward-row-meta", meta);
  }
  if (tasks.length > 4) append(section, "p", "lifeops-steward-muted", `另有 ${tasks.length - 4} 项，可在任务列表查看。`);
}

function metric(parent: HTMLElement, label: string, count: number, description: string, action: () => void, needsAttention = false): void {
  const card = button(parent, "", action, `lifeops-steward-metric${needsAttention ? " needs-attention" : ""}`);
  card.setAttribute("aria-label", `${label}，${count} 项。${description}`);
  append(card, "span", "lifeops-steward-metric-label", label);
  append(card, "strong", "lifeops-steward-metric-number", String(count));
  append(card, "span", "lifeops-steward-metric-description", description);
}

function habitStatus(item: HabitDashboardItem): string {
  if (item.periodUnavailable) return "交易记录暂不可用";
  if (item.habit.source === "trades" && item.status !== "leave") return item.status === "done" ? "已达标" : "未达标";
  switch (item.status) {
    case "done": return "已打卡";
    case "leave": return "已请假";
    case "missed": return "未完成";
    default: return "待打卡";
  }
}

function append<K extends keyof HTMLElementTagNameMap>(parent: HTMLElement, tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const element = parent.ownerDocument.createElement(tag);
  element.className = className;
  if (text !== undefined) element.textContent = text;
  parent.appendChild(element);
  return element;
}

function icon(parent: HTMLElement, name: string, className = "lifeops-steward-icon"): void {
  const host = append(parent, "span", className);
  host.setAttribute("aria-hidden", "true");
  setIcon(host, name);
}

function button(parent: HTMLElement, label: string, action: () => void, className: string, iconName?: string): HTMLButtonElement {
  const result = append(parent, "button", className);
  result.type = "button";
  if (iconName) icon(result, iconName);
  if (label) append(result, "span", "lifeops-steward-button-label", label);
  result.addEventListener("click", action);
  return result;
}
