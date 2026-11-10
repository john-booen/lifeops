import { describe, expect, it } from "vitest";
import { hasUnsafeTradingSuggestion, sanitizeUnsafeTradingReply } from "../src/tradingSafety";

describe("tradingSafety", () => {
  it("does not block safe descriptions about missing trading records", () => {
    const reply = "当前上下文里没有看到2026-06-11的交易记录。建议先整理复盘或做交易计划检查。";

    expect(hasUnsafeTradingSuggestion(reply)).toBe(false);
    expect(sanitizeUnsafeTradingReply(reply)).toBe(reply);
  });

  it("does not block explicit guardrails", () => {
    const reply = "Cici 不会建议你直接下单，也不会把实盘交易当作今天最重要行动。";

    expect(hasUnsafeTradingSuggestion(reply)).toBe(false);
  });

  it("does not block trading record suggestions", () => {
    const reply = "今天最重要的一件事：做一笔交易记录，把今天做的交易或模拟盘写下来。";

    expect(hasUnsafeTradingSuggestion(reply)).toBe(false);
  });

  it("blocks suggestions that push the user into live trading actions", () => {
    const reply = "今天接下来最重要的一件事是开始实盘交易，可以先开一单。";

    expect(hasUnsafeTradingSuggestion(reply)).toBe(true);
    expect(sanitizeUnsafeTradingReply(reply)).toContain("实盘交易倾向");
  });

  it("blocks live trading language inside the most-important-action frame", () => {
    const reply = "今天最重要的一件事：你从2月就说要上实盘，今天该把这件事推进了。";

    expect(hasUnsafeTradingSuggestion(reply)).toBe(true);
  });

  it("allows safe review of why live trading was not started", () => {
    const reply = "今天最重要的一件事：复盘为什么一直没上实盘，只做交易计划检查和风险确认。";

    expect(hasUnsafeTradingSuggestion(reply)).toBe(false);
  });

  it("does not block descriptive context about missing live trading records", () => {
    const reply = "当前缺口：实盘记录缺失，上下文多次提到“始终没上实盘”是核心问题。建议补一条今日交易记录。";

    expect(hasUnsafeTradingSuggestion(reply)).toBe(false);
  });
});
