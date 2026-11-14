import { formatDate, normalizeJournalDate } from "../../date";
import { supportsTradeClock, tradeClockEvidence } from "./clockEvidence";
import { tradeNumber } from "./pnl";
import { isTradeTimestamp, type Trade, type TradeDraft, type TradePatch } from "./types";

export const TRADE_FIELDS = {
  openedAt: { type: "string", description: "只有日期时填写 YYYY-MM-DD。用户说了时刻才填时间。未提供可省略。" },
  closedAt: { type: "string", description: "仅用户明确给出平仓时刻时填写。只有日期或出场价时省略。" },
  market: { type: "string", enum: ["A股", "美股", "期货", "外汇", "加密"] },
  symbol: { type: "string" }, direction: { type: "string", enum: ["long", "short"] },
  qty: { type: "number" }, qtyUnit: { type: "string" }, entry: { type: "number" }, exit: { type: "number" },
  stop: { type: "number" }, target: { type: "number" }, fees: { type: "number" },
  pnl: { type: "number", description: "只填用户明确给出的盈亏，可为负或零。" },
  currency: { type: "string", enum: ["CNY", "USD"], description: "期货按交易所确定；不清楚时向用户核对。" },
  riskAmount: { type: "number" }, modelId: { type: "string" }, modelVersionId: { type: "string" },
  planned: { type: ["boolean", "null"], description: "只有用户明确说计划内外时才填写，未知省略。" }, emotion: { type: "string" }, notes: { type: "string" },
  attachments: { type: "array", items: { type: "string" } }
};

export function tradeTime(value: unknown, now = new Date()): Pick<TradeDraft, "openedAt" | "openedAtPrecision"> {
  if (isTradeTimestamp(value)) return { openedAt: value, openedAtPrecision: undefined };
  const localTime = typeof value === "string" ? /^(\d{4}-\d{2}-\d{2})[ T]((?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?)$/.exec(value) : null;
  const date = value === undefined || value === "" ? formatDate(now)
    : typeof value === "string" ? normalizeJournalDate(localTime?.[1] ?? value, formatDate(now)) : "";
  if (!date) throw new Error("交易时间请填日期、当地时间或带时区的 ISO 时间。");
  const clock = localTime?.[2]?.padEnd(8, ":00") ?? "00:00:00";
  const local = new Date(`${date}T${clock}`);
  if (localTime && [local.getHours(), local.getMinutes(), local.getSeconds()].map(value => String(value).padStart(2, "0")).join(":") !== clock) {
    throw new Error("该当地时间不存在，请核对时区和时刻。");
  }
  const offset = -local.getTimezoneOffset();
  const hh = String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0"), mm = String(Math.abs(offset) % 60).padStart(2, "0");
  return { openedAt: `${date}T${clock}${offset < 0 ? "-" : "+"}${hh}:${mm}`, openedAtPrecision: localTime ? undefined : "date" };
}

function tradeInput(value: unknown, allowRepeatedOpeningDate = false): Record<string, unknown> {
  const invalid = () => new Error("交易字段不正确，请核对品种、方向和数据。");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const input = value as Record<string, unknown>;
  const { date, ...withoutDate } = input;
  // A model can repeat an already supplied calendar date in an extra field.
  const repeated = allowRepeatedOpeningDate && typeof date === "string" && date.length > 0
    && date === input.openedAt && normalizeJournalDate(date) === date;
  const fields = repeated ? withoutDate : input;
  if (Object.keys(fields).some(key => !Object.hasOwn(TRADE_FIELDS, key))) throw invalid();
  return fields;
}

export function chatTradeDraft(value: unknown, now = new Date(), userMessage = ""): TradeDraft {
  const input = tradeInput(value, true);
  if (typeof input.symbol !== "string" || !input.symbol.trim() || (input.direction !== "long" && input.direction !== "short")) {
    throw new Error("请先问清每笔交易的品种和做多或做空方向，未保存。");
  }
  let opened = tradeTime(input.openedAt, now);
  const closed = input.closedAt === undefined ? undefined : tradeTime(input.closedAt, now);
  let closedAt = closed?.openedAtPrecision ? undefined : closed?.openedAt;
  if (userMessage.trim() && (!opened.openedAtPrecision || closedAt)) {
    const evidence = tradeClockEvidence(userMessage);
    if (closedAt && !supportsTradeClock(evidence, "closedAt", closedAt, opened.openedAtPrecision ? undefined : opened.openedAt)) closedAt = undefined;
    if (!opened.openedAtPrecision && !supportsTradeClock(evidence, "openedAt", opened.openedAt)) {
      opened = tradeTime(opened.openedAt.slice(0, 10), now);
    }
  }
  if (opened.openedAtPrecision === "date" && closedAt) {
    // The opening date has no clock or offset. Anchor its stored midnight
    // to the known close's zone so a change of computer zone can't reverse them.
    const date = opened.openedAt.slice(0, 10);
    opened.openedAt = closedAt.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?/u, `${date}T00:00:00`);
  }
  return { ...input, ...opened, closedAt, source: { kind: "chat" } } as TradeDraft;
}

const pnlAmount = /(?:盈亏|损益|盈利|获利|收益|利润|赚|亏损|亏|赔|pnl|p&l|profit|loss)(?:\s|为|是|了|约|:|=)*([+\-负−]?\s*(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)(?![\d.%])/gi;
const signedCurrency = /([+\-负−]\s*(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)\s*(?:人民币|美元|元|CNY|USDT|USD|U\b)/gi;

export function discardUnstatedTradePnl(value: unknown, message: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value) || !message.trim()) return value;
  const { pnl, ...fields } = value as Record<string, unknown>;
  if (typeof pnl !== "number") return value;
  const source = message.normalize("NFKC");
  const amounts = [...source.matchAll(pnlAmount), ...source.matchAll(signedCurrency)];
  const stated = amounts.some(([phrase, amount]) => {
    const number = Number(amount.replace(/[,\s]/g, "").replace(/[负−]/g, "-"));
    const loss = !phrase.includes("盈亏") && /亏|赔|loss/i.test(phrase);
    return pnl === (loss ? -Math.abs(number) : number);
  });
  const spokenAmount = /(?:盈亏|损益|盈利|赚|亏损|亏|赔)(?:了|为|是|\s)*[负正]?[零〇一二两三四五六七八九十百千万亿]+(?:点[零〇一二两三四五六七八九]+)?(?:元|美元|人民币|块|刀|U\b)/i.test(source);
  return stated || !amounts.length && spokenAmount || pnl === 0 && /(?:盈亏为零|打平|持平)/.test(source) ? value : fields;
}

export function chatTradePatch(value: unknown): TradePatch {
  const input = tradeInput(value);
  if (!Object.keys(input).length) throw new Error("请提供需要修改的交易字段。");
  return { ...input, ...(Object.hasOwn(input, "openedAt") ? tradeTime(input.openedAt) : {}) } as TradePatch;
}

export function tradeLabel(trade: Trade): string { return `${trade.symbol} ${trade.direction === "long" ? "多单" : "空单"}`; }

export function tradeReceiptText(trade: Trade, verb: "已记" | "已改"): string {
  const items = [`${verb} ${tradeLabel(trade)}`];
  if (trade.entry !== undefined || trade.exit !== undefined) items.push(`${trade.entry ?? "?"}→${trade.exit ?? "?"}`);
  if (trade.qty !== undefined) items.push(`${trade.qty}${trade.qtyUnit ? ` ${trade.qtyUnit}` : ""}`);
  if (trade.pnl !== undefined) items.push(`${trade.pnl > 0 ? "+" : ""}${tradeNumber(trade.pnl)} ${trade.currency}${trade.pnlSource === "stated" ? "（你说的）" : "（计算）"}`);
  else items.push("盈亏未知");
  if (trade.modelId) items.push(trade.modelId);
  if (trade.ruleViolations.length) items.push(`已核对违规 ${trade.ruleViolations.length} 条`);
  if (trade.ruleCheckStatus === "insufficient") items.push("规则核对还缺依据，请补充执行细节");
  if (trade.pnlMismatch) items.push("与按价格计算的盈亏相差超过 5%，请核对");
  return items.join(" · ");
}
