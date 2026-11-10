import { newLocalOperationId, recordRevision } from "../../operationIdentity";
import { isVaultPathExcluded } from "../../privacy";
import type { LifeOpsToolDefinition, ToolExecutionResult } from "../../toolRegistry";
import type { AgentActionSuggestion } from "../../types";
import { chatTradePatch, TRADE_FIELDS, tradeLabel, tradeReceiptText } from "./inputs";
import type { Trade } from "./types";

function tradeResult(trades: Trade[], verb: "已记" | "已改"): ToolExecutionResult {
  const tradeEdits = trades.map(trade => ({ id: trade.id, label: tradeLabel(trade), summary: tradeReceiptText(trade, verb) }));
  return { success: true, actions: [], tradeEdits,
    output: tradeEdits.map(trade => `${trade.summary} · 编号 ${trade.id}`).join("\n") };
}

const failed = (output: string): ToolExecutionResult => ({ success: false, output, actions: [] });

export const TRADE_RECORD_TOOLS: LifeOpsToolDefinition[] = [
  {
    name: "inspect_trade_review", safety: "safe",
    description: "读取本期交易统计和规则依据。只问纪律、违规或改进建议时设 focus=rules。建议引用具体交易、模型规则和下一次检查步骤。仅回答。",
    parameters: { type: "object", additionalProperties: false, properties: {
      period: { type: "string", enum: ["day", "week", "month"] },
      focus: { type: "string", enum: ["rules"], description: "只问纪律或改进时，仅读取已核对的偏离与规则。" }
    }, required: ["period"] },
    async execute(args, context) {
      const { collectTradeReview, TRADE_REVIEW_PERIODS, tradeReviewPromptData } = await import("./reviewData");
      const period = TRADE_REVIEW_PERIODS.find(value => value === args.period);
      if (!period) return failed("请选择今天、本周或本月。");
      const focus = args.focus === "rules" ? "rules" : undefined;
      return { success: true, output: tradeReviewPromptData(await collectTradeReview(context.store, period), focus), actions: [] };
    }
  },
  {
    name: "record_trade", safety: "direct-write",
    description: "用户要求记交易时直接调用本工具。品种、市场、方向明确且最多三笔就保存。未知字段省略，盈亏由程序算。指定模型时查规则并引用原话。",
    parameters: { type: "object", additionalProperties: false, properties: {
      text: { type: "string", description: "可选，用户原话。" },
      trades: { type: "array", items: { type: "object", additionalProperties: false, properties: {
        ...TRADE_FIELDS, ruleChecks: { type: "array", items: { type: "object", additionalProperties: false,
          properties: { id: { type: "string" }, status: { type: "string", enum: ["pass", "violation"] }, quote: { type: "string" } },
          required: ["id", "status", "quote"] } }
      },
        required: ["market", "symbol", "direction"] } }
    } },
    async execute(args, context, request) {
      if (!Array.isArray(args.trades) || !args.trades.length) return failed("请先把明确的交易整理到 trades，未保存。");
      if (args.trades.length > 3 && !request.confirmedByUser) return failed("超过三笔交易需要先确认，未保存。");
      const { recordTradeDrafts } = await import("./persistence");
      const { assessChatTrade } = await import("./tradeRuleCheck");
      const drafts = await Promise.all(args.trades.map(value => assessChatTrade(context.store, value, request.userMessage)));
      return tradeResult(await recordTradeDrafts(context.store, drafts), "已记");
    }
  },
  {
    name: "update_trade", safety: "direct-write",
    description: "修改已有交易。使用回执中或用户给出的准确编号。只传要改的字段，盈亏从明确数据计算。",
    parameters: { type: "object", additionalProperties: false, required: ["id", "patch"], properties: {
      id: { type: "string" }, patch: { type: "object", additionalProperties: false, properties: TRADE_FIELDS }
    } },
    async execute(args, context) {
      const { tradeDatabasePath, updateTrade } = await import("./persistence");
      if (isVaultPathExcluded(tradeDatabasePath(context.store.settings.folders), context.store.settings.privacy?.excludedVaultPrefixes)) {
        return failed("交易目录已排除模型读取，请在本地查看或修改。");
      }
      if (typeof args.id !== "string" || !args.id.trim()) return failed("请给出这笔交易的准确编号。");
      return tradeResult([await updateTrade(context.store, args.id, chatTradePatch(args.patch))], "已改");
    }
  },
  {
    name: "delete_trade", safety: "ui-confirm",
    description: "为删除一笔交易准备确认卡，必须使用准确的交易编号。",
    parameters: { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string" } } },
    async execute() { return failed("请在确认卡上确认删除交易。"); },
    async prepareConfirmation(args, context) {
      const { readTradeDatabase, tradeDatabasePath } = await import("./persistence");
      if (isVaultPathExcluded(tradeDatabasePath(context.store.settings.folders), context.store.settings.privacy?.excludedVaultPrefixes)) {
        return failed("交易目录已排除模型读取，无法生成删除确认卡。");
      }
      const trade = (await readTradeDatabase(context.store)).trades.find(item => item.id === args.id);
      if (!trade) return failed("没找到这笔交易，请核对编号。");
      const action: AgentActionSuggestion = {
        id: newLocalOperationId("delete-trade"), type: "delete_trade", title: "删除交易", description: "确认后删除这笔交易，可撤销。",
        content: tradeLabel(trade), date: trade.openedAt.slice(0, 10), tradeId: trade.id,
        expectedTargetRevisions: { [trade.id]: recordRevision(trade) }
      };
      return { success: true, output: `请确认是否删除 ${action.content}。`, actions: [action] };
    }
  }
];
