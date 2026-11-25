const capacityPhrases = /超载|超负荷|超出|排(?:得)?(?:太|有点)?[多满]|忙不过来|做不完/u;

export function asksForTodayCapacity(message: string): boolean {
  const question = message.trim().replace(/^请问[，, ]*/u, "").replace(/[。！？!?]+$/u, "");
  return /^(?:我)?(?:今天|今日)(?:的)?(?:任务|待办|安排)?(?:是不是|有没有|会不会|是否)?(?:排(?:得)?(?:有点|太)?[多满]了?|(?:太多|超载|超负荷)(?:了)?)(?:吗)?$/u.test(question)
    || /^(?:我)?(?:今天|今日)(?:的)?(?:任务|待办|安排)(?:还)?(?:(?:能(?:不能|否)?|来得及)(?:都|全部)?(?:做完|完成)|做得完)(?:吗)?$/u.test(question);
}

interface WorkloadPlan {
  today?: { scheduled: number };
  capacity?: { overloaded: boolean; typicalCount: number | null; suggestDefer?: string[] };
  tasks?: { id: string; title: string }[];
  scope?: string;
}

export function formatTodayCapacity(output: string): string | undefined {
  let plan: WorkloadPlan;
  try { plan = JSON.parse(output); } catch { return; }
  const scheduled = plan?.today?.scheduled, capacity = plan?.capacity, typical = capacity?.typicalCount;
  if (typeof scheduled !== "number" || !Number.isSafeInteger(scheduled) || scheduled < 0
    || typeof capacity?.overloaded !== "boolean") return;
  const lines = [];
  if (typical === null) {
    lines.push(`今天原排 ${scheduled} 项。近期缺少常态完成记录，暂时无法判断是否超载。`);
  } else if (typeof typical === "number" && Number.isFinite(typical) && typical >= 0) {
    const verdict = capacity.overloaded ? "按近期记录，今天的待办已超载。" : "按近期记录，今天的待办仍在常态负荷内。";
    lines.push(`${verdict}今天原排 ${scheduled} 项，常态每天完成约 ${typical} 项。`);
    if (capacity.overloaded && Array.isArray(plan.tasks) && Array.isArray(capacity.suggestDefer)) {
      const candidates = capacity.suggestDefer.slice(0, 2).map(id => plan.tasks?.find(task => task.id === id)?.title)
        .filter((title): title is string => typeof title === "string" && title.length > 0);
      if (candidates.length) lines.push(`可以考虑延后${candidates.map(title => `「${title}」`).join("、")}。`);
    }
  } else return;
  if (plan.scope) lines.push("只统计允许读取的记录。");
  return lines.join("");
}

/** Retain the measured workload judgment and comparison when the reply omits them. */
export function planCapacityEvidence(output: string, answer: string, question = ""): string | undefined {
  const mentionsCapacity = capacityPhrases.test(answer);
  if (!mentionsCapacity && !capacityPhrases.test(question)) return;
  let result: WorkloadPlan;
  try { result = JSON.parse(output); } catch { return; }
  const scheduled = result?.today?.scheduled, typical = result?.capacity?.typicalCount;
  if (result?.capacity?.overloaded !== true || typeof scheduled !== "number" || !Number.isSafeInteger(scheduled) || scheduled < 0
    || typeof typical !== "number" || !Number.isFinite(typical) || typical < 0) return;
  const counts = new Set([...answer.matchAll(/(?<![\d.])(\d+(?:\.\d+)?)\s*(?:项|个|件)/gu)].map(match => Number(match[1])));
  const scope = result.scope ? "（仅含可读记录）" : "";
  const verdict = answer.includes('已超载')||answer.includes('已经超载') ? "" : `按记录，今天的待办已超载${scope}。`;
  if (counts.has(scheduled) && counts.has(typical)) return verdict || undefined;
  const comparison = `今天原排 ${scheduled} 项，常态完成 ${typical} 项${scope}。`;
  return verdict ? verdict + comparison : "核对到的工作量：" + comparison;
}
