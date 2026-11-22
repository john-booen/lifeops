export interface JudgeEvidenceEntry {
  phase: "fixture" | "prelude" | "current_turn";
  name: string;
  output: string;
}

/** Keep the judged turn complete before fitting earlier setup evidence. */
export function serializeJudgeEvidence(entries: readonly JudgeEvidenceEntry[], softChars = 16_000, hardChars = 64_000): string {
  if (!Number.isSafeInteger(softChars) || !Number.isSafeInteger(hardChars) || softChars < 1 || hardChars < softChars) throw Error("Invalid evidence budget");
  const current = entries.filter(row => row.phase === "current_turn"), earlier = entries.filter(row => row.phase !== "current_turn");
  const render = (rows: JudgeEvidenceEntry[]) => JSON.stringify({ evidence: rows,
    omittedEarlierEntries: entries.length - rows.length, currentTurnComplete: true });
  const selected = [...current], minimum = render(selected);
  if (minimum.length > hardChars) throw Error("本轮工具依据超过裁判完整读取上限；未发送残缺材料。");
  const budget = Math.max(softChars, minimum.length);
  for (const row of earlier) if (render([...selected, row]).length <= budget) selected.push(row);
  return render(selected);
}
