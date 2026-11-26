/** Decode one equivalent model representation, then keep all existing date,
 * period and source-policy checks. No dates are inferred or widened here. */
export function serializedDateRange(value: unknown): { from: string; to: string } | undefined {
  if (typeof value !== "string" || !value.trim().startsWith("{")) return;
  const invalid = () => Error("统计区间需要只含 from、to 两个日期文字的对象。");
  if (value.length > 256) throw invalid();
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw invalid(); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw invalid();
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "from,to"
    || typeof record.from !== "string" || typeof record.to !== "string") throw invalid();
  return { from: record.from, to: record.to };
}
