import type { JournalPlanChoice, TodayCardData } from "../features/today/model";

export function renderTodayCard(
  host: HTMLElement, data: TodayCardData, onAddPlan: (plan: JournalPlanChoice) => Promise<void>, onReviewIdeas?: () => void,
  onCorrectYesterday?: (taskId: string) => Promise<void>
): void {
  const document = host.ownerDocument;
  const wasOpen = host.querySelector<HTMLDetailsElement>(".lh-today-state")?.open ?? false;
  host.replaceChildren();
  function add<K extends keyof HTMLElementTagNameMap>(parent: HTMLElement, tag: K, cls: string, text?: string) {
    const node = document.createElement(tag);
    node.className = cls;
    if (text !== undefined) node.textContent = text;
    parent.append(node);
    return node;
  }
  const card = add(host, "section", "lh-today-card");
  card.setAttribute("aria-label", "今日卡片");
  add(card, "h2", "", "今日管家");
  const state = add(card, "details", "lh-today-state");
  state.open = wasOpen;
  add(state, "summary", "", data.status.map(item => `${item.label} ${item.value}`).join(" · "));
  const quotes = data.status.filter(item => item.quote);
  if (quotes.length === 0) add(state, "p", "lh-caption", "暂无对应的日记原话。");
  for (const item of quotes) add(state, "p", "lh-caption", `${item.label}「${item.quote}」`);

  if (data.health?.sleepHours !== undefined || data.health?.steps !== undefined) {
    const health = [];
    if (data.health.sleepHours !== undefined) health.push(`昨晚睡眠 ${data.health.sleepHours} 小时`);
    if (data.health.steps !== undefined) health.push(`今日 ${data.health.steps.toLocaleString("zh-CN")} 步`);
    add(card, "p", "lh-caption", health.join(" · "));
  }

  const taskStatus = add(card, "p", data.capacity.overloaded ? "lh-today-overload" : "",
    `今日任务 ${data.completed} / ${data.total} 已完成`);
  if (data.capacity.overloaded && data.capacity.typicalCount !== null) {
    const { plannedCount, typicalCount } = data.capacity;
    add(taskStatus, "span", "", ` · 负荷偏高，待做 ${plannedCount} 项（含逾期），平时约完成 ${Math.round(typicalCount)} 项`);
  }
  if (data.compensationSummary) add(card, "p", "lh-today-overload", "补偿" + data.compensationSummary);

  const grid = add(card, "div", "lh-today-grid");
  const priorities = add(grid, "section", "");
  add(priorities, "h3", "", "现在先做");
  if (!data.priorities.length) add(priorities, "p", "lh-caption", "当前没有到期任务。");
  else {
    const list = add(priorities, "ol", "");
    for (const task of data.priorities) {
      const item = add(list, "li", "", task.title);
      for (const reason of task.reasons) add(item, "span", "lh-today-reason", reason);
    }
  }

  const habits = add(grid, "section", "");
  add(habits, "h3", "", "习惯进度");
  if (!data.habits.length) add(habits, "p", "lh-caption", "还没有习惯。");
  for (const habit of data.habits) {
    add(habits, "p", "", habit.unavailable ? `${habit.title} · 交易记录暂不可用` : `${habit.title} · ${habit.period} ${habit.done}/${habit.target} ${habit.unit}`);
  }
  for (const penalty of data.penalties) {
    add(habits, "p", "lh-today-overload", [penalty.title, penalty.due, penalty.dueDate && `${penalty.dueDate} 到期`].filter(Boolean).join(" · "));
    if (penalty.daysLate && penalty.due) add(habits, "p", "lh-caption", `这项已经拖了 ${penalty.daysLate} 天，今天把它安排上。`);
    if (penalty.evidence) add(habits, "p", "lh-caption", penalty.evidence);
    if (penalty.canCorrectYesterday && onCorrectYesterday) {
      const button = add(habits, "button", "lh-button", "昨晚其实做了");
      button.type = "button";
      button.setAttribute("aria-label", "昨晚其实做了 · " + penalty.title);
      const message = add(habits, "p", "lh-today-plan-message");
      message.setAttribute("role", "status");
      button.onclick = async () => {
        if (button.disabled || !button.isConnected) return;
        button.disabled = true;
        message.textContent = "";
        try {
          await onCorrectYesterday(penalty.id);
        } catch (error) {
          message.textContent = error instanceof Error ? error.message : "暂时无法补记，请重试。";
        } finally {
          button.disabled = false;
        }
      };
    }
  }

  const plans = add(card, "section", "lh-today-plans");
  add(plans, "h3", "", "日记里提到的计划");
  if (!data.plans.length) add(plans, "p", "lh-caption", "今天还没有提取到计划。");
  for (const { plan, added } of data.plans) {
    const row = add(plans, "div", "lh-today-plan");
    add(row, "span", "", `${plan.title} · ${plan.date || "未定日期"}`);
    const button = add(row, "button", "lh-button", added ? "已添加" : "加到任务");
    button.type = "button"; button.disabled = added;
    button.setAttribute("aria-label", `${added ? "已添加" : "加到任务"} ${plan.title}`);
    const message = add(row, "p", "lh-today-plan-message");
    message.setAttribute("role", "status");
    button.onclick = async () => {
      if (!button.isConnected || button.disabled) return;
      button.disabled = true;
      message.textContent = "";
      try {
        await onAddPlan(plan);
        button.textContent = "已添加";
        button.setAttribute("aria-label", `已添加 ${plan.title}`);
      } catch (error) {
        message.textContent = error instanceof Error ? error.message : "暂时无法添加，请重试。";
        button.disabled = false;
      }
    };
  }
  if (onReviewIdeas && data.ideaCandidateCount) {
    const review = add(card, "button", "lh-button", "新发现 " + data.ideaCandidateCount + " 个想法");
    review.type = "button";
    review.onclick = onReviewIdeas;
  }
  if (data.quizDueCount !== undefined) add(card, "p", "lh-caption", "今天有 " + data.quizDueCount + " 张复习卡到期。");
}
