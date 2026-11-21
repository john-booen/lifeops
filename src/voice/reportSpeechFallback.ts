import { hasGroundedSpeechNumbers } from "./summaryNumbers";

const quantity = /(?:\d+(?:[.,]\d+)?|[零〇一二两三四五六七八九十百千万亿]+)\s*(?:[%％]|项|笔|美元|人民币|元|天|小时|分钟|步|公里|篇)/u;
const fact = /完成|计划|记录|净盈亏|净收益|收益率|回撤|睡眠|步数|学习|归档|命中|未提及|未找到|未读齐|覆盖/u;
const instruction = /建议|下一步|请|应该|应当|需要|必须|预计|目标|如果|假设|假如|指令|忽略|删除|下单|买入|卖出|不要|不得|不许|务必|立刻|马上|体罚|疼痛/u;

/** A failed paraphrase must not erase available facts. Keep whole prose
 * statements: never join table cells or detach numbers from their scope. */
export function reportSpeechFallback(detail: string, conclusion?: string): string | undefined {
  const facts: string[] = [];
  let fence = "", length = 0;
  for (const line of detail.split("\n")) {
    const delimiter = /^\s*(`{3,}|~{3,})/u.exec(line)?.[1];
    if (delimiter) {
      if (!fence) fence = delimiter;
      else if (delimiter[0] === fence[0] && delimiter.length >= fence.length) fence = "";
      continue;
    }
    if (fence || /^(?:\s{4}|\t)|^\s*(?:[#>|]|\d+[.)、])/u.test(line)) continue;
    for (const part of line.split(/[。！？!?；;]/u)) {
      const value = part.trim().replace(/^[-*+]\s+/u, "").replace(/\*\*|__/gu, "").replace(/\s+/gu, " ");
      const statement = value + "。";
      if (!quantity.test(value) || !fact.test(value) || instruction.test(value)
        || /[\[\]`|“”「」『』]|https?:/u.test(value) || value.length > 90
        || facts.includes(statement) || length + statement.length > 155) continue;
      facts.push(statement); length += statement.length;
      if (facts.length === 3) break;
    }
    if (facts.length === 3) break;
  }
  if (facts.length < 2) return;
  const body = facts.join("");
  const suffix = conclusion && hasGroundedSpeechNumbers("", conclusion) && body.length + conclusion.length <= 180
    ? conclusion : "完整报告还有其他细节。";
  const speech = body + suffix;
  return hasGroundedSpeechNumbers(detail, speech) ? speech : undefined;
}
