const unsafeTradingActionPattern = /(上实盘|实盘交易|真实交易|开一单|做一笔交易(?!记录)|下单|买入|卖出)/;
const unsafeTradingPushPattern = /(建议|可以|需要|应该|马上|现在|今天|今日|接下来|最重要|优先|去|开始|尝试|执行|行动|做|开)/;
const unsafeImportantTradingPattern = /(今天|今日|接下来|最重要|优先).{0,80}(上实盘|实盘交易|真实交易|开一单|做一笔交易(?!记录)|下单|买入|卖出)/;
const tradingSafetyGuardrailPattern = /(不能|不要|不可|不会|不建议|别|避免|禁止|没有看到|没看到|未看到|缺少|只做|只建议|只能建议|风险确认|交易计划检查|模拟盘|复盘|记录交易纪律|交易记录|实盘记录缺失|原始记录|上下文.*提到|资料.*提到)/;

export function hasUnsafeTradingSuggestion(reply: string): boolean {
  return splitReplyIntoSafetyClauses(reply).some((clause) => {
    if (unsafeImportantTradingPattern.test(clause) && !tradingSafetyGuardrailPattern.test(clause)) return true;
    if (!unsafeTradingActionPattern.test(clause)) return false;
    if (!unsafeTradingPushPattern.test(clause)) return false;
    return !tradingSafetyGuardrailPattern.test(clause);
  });
}

export function sanitizeUnsafeTradingReply(reply: string): string {
  if (!hasUnsafeTradingSuggestion(reply)) return reply;
  return [
    "这条回复里出现了不合适的实盘交易倾向，我先把它拦下来。",
    "",
    "更安全的下一步是：只做交易计划检查、模拟盘验证、风险确认，或者把最近的交易纪律问题整理成复盘。助手不会建议你直接下单，也不会把实盘交易当作今天最重要行动。"
  ].join("\n");
}

function splitReplyIntoSafetyClauses(reply: string): string[] {
  return reply
    .split(/[。！？!?；;\n]+/)
    .map((clause) => clause.trim())
    .filter(Boolean);
}
