/** Native home adapted from the approved neural dashboard preview (MIT).
 * Decorative assets are local; all content/actions come from the host controller.
 */
import type { StewardTodayOptions } from "./stewardShell";
import type { NeuralDomain } from "./neuralRecordsModel";
import { HOME_MODULES, homeBranches, type HomeBranch } from "./neuralHomeModel";
import { createHomeMotion } from "./neuralHomeMotion";
import { HOME_MEDIA } from "./neuralHomeMedia";
import { renderTodayCard } from "./todayCard";
import type { JournalPlanChoice, TodayCardData } from "../features/today/model";

export interface NeuralHomeOptions extends StewardTodayOptions {
  onOpenLibrary(domain: NeuralDomain): void;
  todayCard?: TodayCardData;
  onAddJournalPlan?(plan: JournalPlanChoice): Promise<void>;
  onReviewIdeas?(): void;
  onCorrectYesterdayHabit?(taskId: string): Promise<void>;
}

export function mountNeuralHomeView(container: HTMLElement, initial: NeuralHomeOptions) {
  const document = container.ownerDocument, win = document.defaultView!;
  let options = initial, disposed = false, domain: NeuralDomain | null = null;
  let selected: string | null = null, signature = "", detailSignature = "", lastPaint = -Infinity;
  let todaySignature = "";
  const element = document.createElement("section");
  element.className = "lifeops-neural-home"; element.setAttribute("aria-label", "LifeOps 网络空间");
  container.append(element);
  function el<K extends keyof HTMLElementTagNameMap>(parent: HTMLElement, tag: K, cls: string, text?: string) {
    const node = document.createElement(tag); node.className = cls;
    if (text !== undefined) node.textContent = text;
    parent.append(node); return node;
  }
  function button(parent: HTMLElement, cls: string, text: string, action: () => void) {
    const node = el(parent, "button", cls, text); node.type = "button";
    node.onclick = () => { if (!disposed && node.isConnected && element.contains(node)) action(); }; return node;
  }
  const today = el(element, "div", "lh-today-card-host");
  const header = el(element, "header", "lh-heading");
  const intro = el(header, "div", "");
  const date = el(intro, "p", "lh-eyebrow");
  const actions = el(header, "div", "lh-actions");
  button(actions, "lh-button lh-primary", "记下一件事", () => options.onQuickCapture());
  button(actions, "lh-button", "与管家对话", () => options.onChat());

  const stage = el(element, "div", "lh-stage"); stage.dataset.expanded = "false"; stage.dataset.motion = "stopped";
  const dust = el(stage, "canvas", "lh-dust"); dust.setAttribute("aria-hidden", "true");
  function picture(parent: HTMLElement, cls: string, poster: string) {
    const box = el(parent, "span", cls); box.setAttribute("aria-hidden", "true");
    const img = el(box, "img", "lh-poster"); img.src = poster; img.alt = ""; img.draggable = false;
    return box;
  }
  const orb = button(stage, "lh-orb", "", () => selectDomain(null));
  orb.setAttribute("aria-label", "收起领域，返回网络空间");
  picture(orb, "lh-orb-picture", HOME_MEDIA.orbPoster);
  el(orb, "span", "lh-orb-label", "LIFEOPS");
  const modules = el(stage, "nav", "lh-modules"); modules.setAttribute("aria-label", "生活领域");
  const moduleButtons = new Map<NeuralDomain, HTMLButtonElement>();
  HOME_MODULES.forEach((item, index) => {
    const node = button(modules, "lh-module", "", () => selectDomain(item.id));
    node.dataset.domain = item.id; node.style.setProperty("--lh-color", item.color);
    node.style.setProperty("--lh-index", String(index));
    picture(node, "lh-jelly-picture", HOME_MEDIA.jellyPoster).style.filter = item.filter;
    el(node, "span", "lh-module-label", item.label); node.setAttribute("aria-pressed", "false");
    moduleButtons.set(item.id, node);
  });
  const branches = el(stage, "section", "lh-glass lh-branches"); branches.hidden = true;
  const branchHead = el(branches, "header", "lh-panel-head");
  const branchTitle = el(branchHead, "h2", "");
  button(branchHead, "lh-close", "收起", () => selectDomain(null));
  const branchHint = el(branches, "p", "lh-caption");
  const list = el(branches, "div", "lh-branch-list"); list.setAttribute("aria-label", "领域分支");
  const detail = el(stage, "section", "lh-glass lh-detail"); detail.hidden = true;
  detail.setAttribute("aria-label", "分支详情");
  const summary = el(element, "div", "lh-summary"); summary.setAttribute("aria-label", "当前安排");
  const metricButtons = [
    { label: "今天安排", filter: "today", count: () => options.board.today.length },
    { label: "需要重看", filter: "overdue", count: () => options.board.overdue.length },
    { label: "未定日期", filter: "no-date", count: () => options.board.noDate.length },
    { label: "今日完成", filter: "completed", count: () => options.board.completedToday.length }
  ].map(item => {
    const node = button(summary, "lh-metric", "", () => options.onOpenTasks(item.filter));
    const value = el(node, "strong", ""), label = el(node, "span", "", item.label);
    return { ...item, node, value, label };
  });
  const footer = el(element, "footer", "lh-footer");
  const footerActions = el(footer, "div", "lh-actions");
  if (options.onNewTask) button(footerActions, "lh-text-button", "新建任务", () => options.onNewTask?.());
  if (options.onRecordPicker) button(footerActions, "lh-text-button", "手写与其他记录", () => options.onRecordPicker?.());
  const motionToggle = button(footerActions, "lh-text-button", "暂停动效", () => {
    const paused = !motion.snapshot().paused; motion.setGate({ paused });
    motionToggle.textContent = paused ? "开启动效" : "暂停动效";
    motionToggle.setAttribute("aria-pressed", String(paused));
  });
  motionToggle.setAttribute("aria-pressed", "false");

  function selectDomain(next: NeuralDomain | null) {
    if (disposed) return;
    // Move focus before hiding the panel that currently owns it.
    if (!next && domain && (branches.contains(document.activeElement) || detail.contains(document.activeElement))) {
      moduleButtons.get(domain)?.focus({ preventScroll: true });
    }
    domain = next; selected = null; signature = ""; detailSignature = "";
    renderContent();
  }
  function focusModule() {
    (domain ? moduleButtons.get(domain) : orb)?.focus({ preventScroll: true });
  }
  function closeDetail() {
    const trigger = Array.from(list.querySelectorAll<HTMLButtonElement>("button[data-branch]"))
      .find(node => node.dataset.branch === selected);
    if (trigger) trigger.focus({ preventScroll: true });
    else focusModule();
    selected = null; renderContent();
  }
  function renderDetail(items: HomeBranch[]) {
    const item = items.find(x => x.id === selected);
    const next = JSON.stringify(item ?? null);
    if (next === detailSignature) return;
    const hadFocus = detail.contains(document.activeElement);
    const focusedControl = hadFocus ? (document.activeElement as HTMLElement | null)?.dataset.homeControl : undefined;
    detailSignature = next; detail.replaceChildren(); detail.hidden = !item;
    if (!item) { if (hadFocus) focusModule(); return; }
    const head = el(detail, "header", "lh-panel-head");
    el(head, "span", "lh-eyebrow", item.action.kind === "record" || item.action.kind === "library" ? "记录入口" : "已保存的安排");
    const close = button(head, "lh-close", "关闭详情", closeDetail);
    close.dataset.homeControl = "close";
    el(detail, "h2", "lh-detail-title", item.title);
    el(detail, "p", "lh-detail-meta", item.meta);
    el(detail, "div", "lh-detail-body", item.body);
    const action = item.action;
    const open = button(detail, "lh-button", action.label, () => {
      if (disposed || detailSignature !== next || selected !== item.id || !domain
        || !homeBranches(domain, options.stats, options.board).some(current => current.id === item.id)) return;
      if (action.kind === "tasks") options.onOpenTasks(action.filter);
      else if (action.kind === "habits") options.onOpenHabits?.();
      else if (action.kind === "record") options.onOpenRecord?.(action.record);
      else options.onOpenLibrary(action.domain);
    });
    open.dataset.homeControl = "open";
    if (focusedControl === "close") close.focus({ preventScroll: true });
    else if (focusedControl === "open") open.focus({ preventScroll: true });
  }
  function renderContent() {
    if (disposed) return;
    today.hidden = !options.todayCard;
    const nextToday = options.todayCard ? JSON.stringify(options.todayCard) : "";
    if (nextToday !== todaySignature) {
      todaySignature = nextToday;
      if (options.todayCard) renderTodayCard(today, options.todayCard, plan =>
        options.onAddJournalPlan?.(plan) ?? Promise.reject(Error("暂时无法添加日记计划。")), options.onReviewIdeas, options.onCorrectYesterdayHabit);
      else today.replaceChildren();
    }
    date.textContent = options.board.date;
    for (const metric of metricButtons) metric.value.textContent = String(metric.count());
    stage.dataset.expanded = String(!!domain);
    branches.hidden = !domain;
    for (const [id, node] of moduleButtons) node.setAttribute("aria-pressed", String(id === domain));
    const items = domain ? homeBranches(domain, options.stats, options.board) : [];
    if (!items.some(item => item.id === selected)) selected = null;
    const next = JSON.stringify({ domain, items });
    if (next !== signature) {
      signature = next;
      const focusedId = (document.activeElement as HTMLElement | null)?.dataset.branch;
      const oldScroll = list.scrollTop;
      list.replaceChildren();
      branchTitle.textContent = HOME_MODULES.find(item => item.id === domain)?.label ?? "";
      branchHint.textContent = domain === "tasks" ? "今日、过期、未定日期任务与现有习惯。" : "选择分支，再打开原有记录入口。";
      if (!items.length && domain) el(list, "p", "lh-caption", "这里暂时没有这些安排，可在事务查看全部任务。");
      for (const item of items) {
        const node = button(list, "lh-branch", "", () => { selected = item.id; renderContent(); });
        node.dataset.branch = item.id;
        el(node, "span", "lh-branch-dot"); el(node, "strong", "", item.title);
        el(node, "small", "", item.meta);
        if (item.id === focusedId) node.focus({ preventScroll: true });
      }
      list.scrollTop = oldScroll;
      if (focusedId && !items.some(item => item.id === focusedId)) focusModule();
    }
    for (const node of Array.from(list.querySelectorAll<HTMLButtonElement>("button[data-branch]"))) {
      node.setAttribute("aria-pressed", String(node.dataset.branch === selected));
    }
    renderDetail(items);
  }

  function startMotion() {
    stage.dataset.motion = "running";
  }
  function stopMotion() {
    stage.dataset.motion = "stopped";
    dust.width = 0; dust.height = 0;
  }
  function paint(time: number) {
    if (time - lastPaint < 1000 / 30) return;
    lastPaint = time;
    const box = stage.getBoundingClientRect(); if (!box.width || !box.height) return;
    const dpr = Math.min(win.devicePixelRatio || 1, 1.5);
    const w = Math.round(box.width * dpr), h = Math.round(box.height * dpr);
    if (dust.width !== w || dust.height !== h) { dust.width = w; dust.height = h; }
    const ctx = dust.getContext("2d");
    if (ctx) {
      ctx.clearRect(0, 0, w, h);
      for (let i = 0; i < 100; i++) {
        const x = ((i * .618034 + time * .000004 * (i % 2 ? 1 : -1)) % 1 + 1) % 1 * w;
        const y = ((i * .381966 + Math.sin(time * .0002 + i) * .018) % 1 + 1) % 1 * h;
        ctx.fillStyle = i % 3 ? "rgba(224,228,232,.38)" : "rgba(236,207,152,.52)";
        ctx.beginPath(); ctx.arc(x, y, (.6 + i % 3 * .4) * dpr, 0, Math.PI * 2); ctx.fill();
      }
      if (domain && box.width > 760) {
        const from = moduleButtons.get(domain)!.getBoundingClientRect();
        for (const node of Array.from(list.querySelectorAll<HTMLElement>(".lh-branch"))) {
          const to = node.getBoundingClientRect();
          if (to.top < list.getBoundingClientRect().top || to.bottom > list.getBoundingClientRect().bottom) continue;
          const x = (from.right - box.left - 14) * dpr, y = (from.top + from.height / 2 - box.top) * dpr;
          const tx = (to.left - box.left + 14) * dpr, ty = (to.top + to.height / 2 - box.top) * dpr;
          ctx.strokeStyle = "rgba(236,217,166,.23)"; ctx.lineWidth = dpr * .8;
          ctx.beginPath(); ctx.moveTo(x, y); ctx.bezierCurveTo(x + 60 * dpr, y, tx - 60 * dpr, ty, tx, ty); ctx.stroke();
        }
      }
    }
  }
  const reduced = win.matchMedia?.("(prefers-reduced-motion: reduce)");
  const motion = createHomeMotion({ request: callback => win.requestAnimationFrame(callback),
    cancel: id => win.cancelAnimationFrame(id), start: startMotion, stop: stopMotion, paint },
  { active: false, visible: !document.hidden, focused: document.hasFocus(), intersecting: false,
    reduced: reduced?.matches ?? false, paused: false });
  const onVisibility = () => motion.setGate({ visible: !document.hidden });
  const onFocus = () => motion.setGate({ focused: true });
  const onBlur = () => motion.setGate({ focused: false });
  const onReduced = () => motion.setGate({ reduced: reduced?.matches ?? false });
  document.addEventListener("visibilitychange", onVisibility);
  win.addEventListener("focus", onFocus); win.addEventListener("blur", onBlur);
  reduced?.addEventListener("change", onReduced);
  const observer = typeof win.IntersectionObserver === "function" ? new win.IntersectionObserver(entries => {
    motion.setGate({ intersecting: entries.some(entry => entry.target === stage && entry.isIntersecting) });
  }) : null;
  observer?.observe(stage);
  renderContent();
  return {
    element,
    update(next: NeuralHomeOptions) { if (disposed) return; options = next; renderContent(); },
    setActive(active: boolean) {
      motion.setGate({ active, visible: !document.hidden, focused: document.hasFocus(),
        ...(!observer ? { intersecting: active && element.isConnected && element.getClientRects().length > 0 } : {}) });
    },
    snapshot() { return { ...motion.snapshot(), domain, selected }; },
    destroy() {
      if (disposed) return; disposed = true;
      observer?.disconnect(); document.removeEventListener("visibilitychange", onVisibility);
      win.removeEventListener("focus", onFocus); win.removeEventListener("blur", onBlur);
      reduced?.removeEventListener("change", onReduced);
      motion.dispose(); element.remove();
    }
  };
}
