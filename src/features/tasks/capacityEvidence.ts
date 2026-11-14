const capacityPhrases = /超载|超负荷|超出|排(?:得)?(?:太|有点)?[多满]|忙不过来|做不完/u;

/** Retain the measured workload judgment and comparison when the reply omits them. */
export function planCapacityEvidence(output: string, answer: string, question = ""): string | undefined {
  const mentionsCapacity = capacityPhrases.test(answer);
  if (!mentionsCapacity && !capacityPhrases.test(question)) return;
  let result: { today?: { scheduled?: number }; capacity?: { overloaded?: boolean; typicalCount?: number }; scope?: string };
  try { result = JSON.parse(output); } catch { return; }
  const scheduled = result?.today?.scheduled, typical = result?.capacity?.typicalCount;
  if (result?.capacity?.overloaded !== true || typeof scheduled !== "number" || !Number.isSafeInteger(scheduled) || scheduled < 0
    || typeof typical !== "number" || !Number.isFinite(typical) || typical < 0) return;
  const counts = new Set([...answer.matchAll(/(?<![\d.])(\d+(?:\.\d+)?)\s*(?:项|个|件)/gu)].map(match => Number(match[1])));
  const scope = result.scope ? "（仅含可读记录）" : "";
  const verdict = mentionsCapacity ? "" : `按记录，今天的待办已超载${scope}。`;
  if (counts.has(scheduled) && counts.has(typical)) return verdict || undefined;
  const comparison = `今天原排 ${scheduled} 项，常态完成 ${typical} 项${scope}。`;
  return verdict ? verdict + comparison : "核对到的工作量：" + comparison;
}
