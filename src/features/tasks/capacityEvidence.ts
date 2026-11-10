/** If the answer discusses overload, retain the numbers the planning tool measured. */
export function planCapacityEvidence(output: string, answer: string): string | undefined {
  if (!["超载", "超出", "排得太多", "排多", "超负荷"].some(word => answer.includes(word))) return;
  let result: { today?: { scheduled?: number }; capacity?: { overloaded?: boolean; typicalCount?: number }; scope?: string };
  try { result = JSON.parse(output); } catch { return; }
  const scheduled = result?.today?.scheduled, typical = result?.capacity?.typicalCount;
  if (result?.capacity?.overloaded !== true || typeof scheduled !== "number" || !Number.isSafeInteger(scheduled) || scheduled < 0
    || typeof typical !== "number" || !Number.isFinite(typical) || typical < 0) return;
  const counts = new Set([...answer.matchAll(/(?<![\d.])(\d+(?:\.\d+)?)\s*(?:项|个|件)/gu)].map(match => Number(match[1])));
  if (counts.has(scheduled) && counts.has(typical)) return;
  return `核对到的工作量：今天原排 ${scheduled} 项，常态完成 ${typical} 项${result.scope ? "（仅含可读记录）" : ""}。`;
}
