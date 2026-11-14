import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiChatResult, AiToolCall, ChatMessage } from "../src/ai";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { addDays, formatDate, todayString } from "../src/date";
import type { StoreHost } from "../src/store/settingsSlice";
import type { AgentLoopHost, AgentTurnInput } from "../src/agent/AgentLoop";
import type { AgentModelRole } from "../src/agent/models";

vi.mock("obsidian", () => ({
  App: class {}, Plugin: class {}, TFile: class {}, TFolder: class {}, WorkspaceLeaf: class {}, ItemView: class {},
  Modal: class {}, PluginSettingTab: class {}, Setting: class {}, Platform: { isDesktopApp: true }, Notice: class {},
  parseYaml: (yaml: string) => JSON.parse(yaml), stringifyYaml: (fields: unknown) => JSON.stringify(fields),
  normalizePath: (path: string) => path.replace(/\\/g, "/").replace(/\/{2,}/g, "/"), setIcon: vi.fn(), requestUrl: vi.fn()
}));
const { createFsApp } = await import("./helpers/fsApp");
const { LifeOpsStore } = await import("../src/store");
const { LifeOpsAi } = await import("../src/ai");
const { default: Plugin } = await import("../src/main");
const { runAgentTurn } = await import("../src/agent/run");
const { AgentRuntime } = await import("../src/agentRuntime");
const { OperationLedger } = await import("../src/dataFoundation/operationLedger");
const { AgentLoop } = await import("../src/agent/AgentLoop");
const { voiceJobSpeech } = await import("../src/voice/jobs");
const { buildResidentContext, RESIDENT_CONTEXT_BYTE_LIMIT } = await import("../src/agent/context");
const { settingsForAgentModel } = await import("../src/agent/models");
const { executeConfirmedToolBatch } = await import("../src/toolBatch");
const { readTradeDatabase } = await import("../src/features/trading/persistence");
const { runConfirmedToolAction } = await import("../src/toolRegistry");
const now = new Date("2026-11-12T12:00:00+08:00");
let root: string, store: StoreHost, host: AgentLoopHost, runtime: InstanceType<typeof AgentRuntime>;
let responses: Array<AiChatResult | Error>, requests: ChatMessage[][], roles: AgentModelRole[];
let catalogs: string[][], toolChoices: unknown[];

function reply(content: string, toolCalls: AiToolCall[] = []): AiChatResult {
  const usage = { status: "reported", inputTokens: 40, outputTokens: 5, totalTokens: 45 } as const;
  return { content, toolCalls, reportedModel: "synthetic-model", responseUsage: usage,
    providerRun: { requestedProvider: "custom", requestedModel: "synthetic-model", actualModel: "synthetic-model",
      status: "success", fallbackUsed: false, attempts: [], responseUsage: usage } };
}
function input(overrides: Partial<AgentTurnInput> = {}): AgentTurnInput {
  return { message: "请创建任务 纯虚构循环任务。", history: [], source: "text", now, ...overrides };
}
function tool(name: string, args: Record<string, unknown>, id = "synthetic-call"): AiToolCall {
  return { name, arguments: args, id };
}

function voiceUndoApproval(): AiChatResult {
  return reply("", [tool("choose_voice_job_control", { intent: "undo_latest_operation", target: "latest" })]);
}

const tradeExamples = [
  { message: "BTC 多 67000 进 68200 出 0.1 个 按突破模型 赚 120U", rows: [
    { market: "加密", symbol: "BTC", direction: "long", entry: 67000, exit: 68200, qty: 0.1, qtyUnit: "个", modelId: "突破模型", pnl: 120 }
  ], pnl: [120], source: ["stated"], currency: ["USD"] },
  { message: "今天茅台做 T，1680 买 1695 卖 200 股", rows: [
    { market: "A股", symbol: "茅台", direction: "long", entry: 1680, exit: 1695, qty: 200, qtyUnit: "股", openedAt: "2026-11-12" }
  ], pnl: [3000], source: ["computed"], currency: ["CNY"] },
  { message: "欧美空 1.0850 进 1.0820 出 1 手 没按止损", rows: [
    { market: "外汇", symbol: "EUR/USD", direction: "short", entry: 1.085, exit: 1.082, qty: 1, qtyUnit: "手", notes: "没按止损" }
  ], pnl: [300], source: ["computed"], currency: ["USD"] },
  { message: "早上三笔：特斯拉多赚 300，英伟达多亏 120，纳指期货空赚 450", rows: [
    { market: "美股", symbol: "特斯拉", direction: "long", pnl: 300 },
    { market: "美股", symbol: "英伟达", direction: "long", pnl: -120 },
    { market: "期货", symbol: "纳指期货", direction: "short", pnl: 450, currency: "USD" }
  ], pnl: [300, -120, 450], source: ["stated", "stated", "stated"], currency: ["USD", "USD", "USD"] },
  { message: "美股 ZTEST2 做空 5 股，进 100 出 98，手续费 1 美元；加密 ZTEST3 做多 2 个，实际净亏 7 美元。", rows: [
    { market: "美股", symbol: "ZTEST2", direction: "short", qty: 5, entry: 100, exit: 98, fees: 1, pnl: 9 },
    { market: "加密", symbol: "ZTEST3", direction: "long", qty: 2, pnl: -7 }
  ], pnl: [9, -7], source: ["computed", "stated"], currency: ["USD", "USD"] }
];

it.each(tradeExamples)("records the trades selected by the model for $message", async ({ message, rows, pnl, source, currency }) => {
  store.settings.tradingContractMultipliers = { "EUR/USD": 100000 };
  responses.push(reply("", [tool("record_trade", { trades: rows })]), reply("交易已保存。"));
  const result = await new AgentLoop(host).run(input({ message }));
  const trades = (await readTradeDatabase(store)).trades;
  expect(catalogs.some(names => names.includes("record_trade"))).toBe(true);
  expect(result.toolCalls).toContainEqual({ name: "record_trade", ok: true });
  expect(result.receipts).toHaveLength(1);
  expect(result.receipts[0].tradeEdits?.map(edit => edit.id)).toEqual(trades.map(trade => trade.id));
  expect(result.receipts[0].tradeEdits?.every(edit => edit.summary.includes("USD") || edit.summary.includes("CNY"))).toBe(true);
  expect(trades.map(trade => trade.pnlSource)).toEqual(source);
  expect(trades.map(trade => trade.currency)).toEqual(currency);
  for (const [index, value] of pnl.entries()) {
    expect(trades[index].pnl).toBeCloseTo(value);
    expect(trades[index].openedAtPrecision).toBe("date");
    expect(trades[index].source.kind).toBe("chat");
  }
  await runtime.undoOperation(result.receipts[0].operationId);
  expect((await readTradeDatabase(store)).trades).toEqual([]);
});

it("uses the actual model-group net profit for each currency without asking the model to rank", async () => {
  const rows = [
    { market: "A股", modelId: "虚构突破", pnl: 250 },
    { market: "A股", modelId: "虚构回踩", pnl: -70 },
    { market: "美股", modelId: "虚构突破", pnl: 90 },
    { market: "美股", modelId: "虚构回踩", pnl: 120 },
    { market: "美股", pnl: 1000 }
  ].map((row, index) => ({ ...row, symbol: `FICT-${index}`, direction: "long", openedAt: "2026-11-12" }));
  for (const batch of [rows.slice(0, 3), rows.slice(3)]) {
    const saved = await runtime.executeAiToolCall(tool("record_trade", { trades: batch }, `fixture-${batch.length}`), "kimi");
    expect(saved.success).toBe(true);
  }
  const before = (await readTradeDatabase(store)).trades;
  responses.push(reply("", [tool("get_stats", { domain: "trades", groupBy: "model", rankByNetPnl: true,
    range: { from: "2026-11-01", to: "2026-11-12" } })]));
  const result = await new AgentLoop(host).run(input({ message: "这个月哪个交易模型最赚钱？人民币和美元分开。" }));
  expect(result.text).toContain("人民币「虚构突破」排名第一，净盈亏 250 CNY。");
  expect(result.text).toContain("美元「虚构回踩」排名第一，净盈亏 120 USD。");
  expect(result.text).not.toContain("180");
  expect(result.toolCalls).toEqual([{ name: "get_stats", ok: true }]);
  expect(requests).toHaveLength(1);
  expect(result.receipts).toEqual([]);
  expect((await readTradeDatabase(store)).trades).toEqual(before);
});

it("requires missing data or a batch confirmation before recording any rows", async () => {
  const row = tradeExamples[0].rows[0];
  const missing = await runtime.executeAiToolCall(tool("record_trade", { trades: [row, { ...row, direction: undefined }] }), "kimi");
  expect(missing.success).toBe(false);
  expect(missing.output).toContain("请先问清");
  const rows = [row, row, row, row];
  responses.push(reply("", [tool("record_trade", { trades: rows })]), reply("请确认四笔记录。"));
  const result = await new AgentLoop(host).run(input({ message: "请把我刚才列出的四笔虚构交易一起记下来。" }));
  expect(result.confirmations).toHaveLength(1);
  expect(result.confirmations[0]).toMatchObject({ type: "tool_batch", batchWriteCount: 4 });
  expect((await readTradeDatabase(store)).trades).toEqual([]);
  await executeConfirmedToolBatch(result.confirmations[0], runtime, () => undefined);
  expect((await readTradeDatabase(store)).trades).toHaveLength(4);
});

it("updates the exact trade, rejects a stale delete card, and allows confirmed deletion and undo", async () => {
  const saved = await runtime.executeAiToolCall(tool("record_trade", { trades: tradeExamples[0].rows }, "trade-add"), "kimi");
  const id = saved.receipt!.tradeEdits![0].id;
  const first = await runtime.executeAiToolCall(tool("delete_trade", { id }, "delete-first"), "kimi");
  const confirmedContext = { store, refreshViews: async () => undefined };
  expect((await readTradeDatabase(store)).trades).toHaveLength(1);
  const changed = await runtime.executeAiToolCall(tool("update_trade", { id, patch: { pnl: 50, openedAt: "2026-11-13" } }, "trade-edit"), "kimi");
  expect(changed.output).toContain("相差超过 5%");
  expect((await readTradeDatabase(store)).trades[0]).toMatchObject({ id, pnl: 50, pnlSource: "stated", openedAtPrecision: "date" });
  await expect(runConfirmedToolAction(first.actions[0], confirmedContext)).rejects.toThrow("交易已变化");
  const current = await runtime.executeAiToolCall(tool("delete_trade", { id }, "delete-current"), "kimi");
  expect((await readTradeDatabase(store)).trades).toHaveLength(1);
  await runConfirmedToolAction(current.actions[0], confirmedContext);
  expect((await readTradeDatabase(store)).trades).toHaveLength(0);
  await runtime.undoOperation(`confirmed:${current.actions[0].id}`);
  expect((await readTradeDatabase(store)).trades[0]).toMatchObject({ id, pnl: 50 });
});

it("uses the deep role on a configured trading note and saves anchored rules only after confirmation", async () => {
  const path = `${store.settings.folders.tradingModels}/虚构纪律原文.md`;
  const raw = "# 练习模型\n每笔交易入场后必须设置止损。\n";
  await store.writeFile(path, raw);
  const quote = "每笔交易入场后必须设置止损。";
  const draft = { text: "入场后设置止损", kind: "risk", checkable: true, quote };
  host.aiForRole = role => ({ async agentTurnStream(messages) {
    roles.push(role);
    if (role === "deep") {
      expect(messages.at(-1)?.content).toBe(raw);
      return reply(JSON.stringify({ rules: [draft] }));
    }
    const message = messages.at(-1);
    if (message?.role !== "tool") return reply("", [tool("extract_trading_rules", { path }, "extract")]);
    if (message.content.startsWith("{")) {
      const { rules } = JSON.parse(message.content);
      return reply("", [tool("propose_trading_research_change", { command: { kind: "save_model", input: { title: "练习模型", rules } } }, "prepare")]);
    }
    return reply("请核对规则确认卡。");
  } });
  const result = await new AgentLoop(host).run(input({ message: "请从虚构纪律原文提取练习模型的规则，给我一张确认卡。" }));
  expect(roles).toContain("deep");
  expect(result.confirmations).toHaveLength(1);
  expect(result.confirmations[0].content).toContain(quote);
  expect(result.confirmations[0].content).toContain(path);
  expect((await store.getTradingSnapshot()).document.models).toEqual([]);
  await runConfirmedToolAction(result.confirmations[0], { store, refreshViews: async () => undefined });
  const version = (await store.getTradingSnapshot()).document.models[0].versions[0];
  expect(version).toMatchObject({ title: "练习模型", revision: 1, rules: [{ ...draft, sourcePath: path }] });
  expect(version.receipt).toBeUndefined();
  expect(await store.readPath(path)).toBe(raw);

  const id = version.rules![0].id;
  const row = { market: "A股", symbol: "虚构标的", direction: "long", modelId: "练习模型" };
  const userQuote = "入场后没有设止损";
  const correct = await runtime.executeAiToolCall(tool("record_trade", { trades: [{ ...row, ruleChecks: [{ id, status: "violation", quote: userQuote }] }] }, "rule-checked"),
    "kimi", `虚构交易，${userQuote}。`);
  expect(correct.success, correct.output).toBe(true);
  expect(correct.output).toContain("已核对违规 1 条");
  const missing = await runtime.executeAiToolCall(tool("record_trade", { trades: [{ ...row, ruleChecks: [{ id, status: "violation", quote: userQuote }] }] }, "rule-unknown"),
    "kimi", "虚构交易，只知道做多。");
  expect(missing.output).toContain("规则核对还缺依据");
  const rows = (await readTradeDatabase(store)).trades;
  expect(rows).toMatchObject([
    { modelId: version.modelId, modelVersionId: version.id, ruleViolations: [id], ruleCheckStatus: "checked" },
    { modelId: version.modelId, modelVersionId: version.id, ruleViolations: [], ruleCheckStatus: "insufficient" }
  ]);
});

it("never sends an excluded rule note or accepts a fabricated source quote", async () => {
  const path = `${store.settings.folders.tradingModels}/虚构规则备份.md`;
  await store.writeFile(path, "实际原文只说记录风险。\n");
  store.settings.privacy!.excludedVaultPrefixes = [path];
  responses.push(reply("", [tool("extract_trading_rules", { path }, "excluded")]), reply("请重新选择。"));
  const excluded = await new AgentLoop(host).run(input({ message: "请提取这篇虚构规则备份里的完整交易规则。" }));
  expect(excluded.toolCalls).toContainEqual({ name: "extract_trading_rules", ok: false });
  expect(roles).not.toContain("deep");
  store.settings.privacy!.excludedVaultPrefixes = [];
  responses.push(reply("", [tool("extract_trading_rules", { path }, "bad-quote")]),
    reply(JSON.stringify({ rules: [{ text: "设置固定百分比", kind: "risk", checkable: true, quote: "未出现的原话" }] })), reply("规则没有核对通过。"));
  const badQuote = await new AgentLoop(host).run(input({ message: "请从这篇虚构备份提取可以核对的交易规则。" }));
  expect(badQuote.toolCalls).toContainEqual({ name: "extract_trading_rules", ok: false });
  expect(badQuote.confirmations).toEqual([]);
  expect((await store.getTradingSnapshot()).document.models).toEqual([]);
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lifeops-agent-loop-"));
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.ai = { ...settings.ai, provider: "custom", endpoint: "https://fiction.invalid/chat", model: "synthetic-model", dataDisclosureAccepted: true };
  settings.privacy = { excludedVaultPrefixes: [], plaintextCredentialStorageAccepted: true };
  store = new LifeOpsStore(createFsApp(root), settings) as unknown as StoreHost;
  await store.initializeVault();
  runtime = new AgentRuntime({ store, refreshViews: async () => {} });
  responses = []; requests = []; roles = []; catalogs = []; toolChoices = [];
  host = {
    settings, store,
    aiForRole: role => {
      roles.push(role);
      return { agentTurnStream: vi.fn(async (messages, onText, options?: Parameters<InstanceType<typeof LifeOpsAi>["agentTurnStream"]>[2]) => {
        requests.push(structuredClone(messages));
        catalogs.push(options?.tools?.map(tool => tool.name) ?? []);
        toolChoices.push(options?.toolChoice);
        const response = responses.shift();
        if (response instanceof Error) throw response;
        if (!response) throw Error("Missing synthetic response");
        if (response.content) onText(response.content);
        return response;
      }) };
    },
    executeTools: async (calls, message, signal, onResult) => {
      const results = [];
      for (const call of calls) {
        const result = await runtime.executeAiToolCall(call, "kimi", message, { assertCurrent: () => signal?.throwIfAborted() });
        onResult(call, result);
        results.push(result);
      }
      return results;
    },
    offlineFallback: vi.fn(async () => null)
  };
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }); });

it.each(["text", "voice"] as const)("presents quiz questions without a model-written answer example in %s", async source => {
  if (source === "text") responses.push(reply("", [tool("load_more_tools", {}, "expand")]));
  responses.push(
    reply("", [tool("start_quiz", { trackId: "quant", count: 2 }, "quiz")]),
    reply("请按题号作答，例如第一题：不参与。")
  );
  const executeTools = host.executeTools;
  const receipt = { operationId: "fictional-quiz" };
  host.executeTools = (calls, message, signal, onResult) => calls[0]?.name !== "start_quiz"
    ? executeTools(calls, message, signal, onResult)
    : Promise.resolve(calls.map(call => {
      const result = { callId: call.id!, success: true, actions: [], receipt, output: JSON.stringify({ cards: [
        { number: 1, question: "样本外数据是否参与参数选择？" },
        { number: 2, question: "如何从毛收益得到净收益？" }
      ] }) };
      onResult(call, result);
      return result;
    }));
  const onVoiceText = vi.fn();
  const result = await new AgentLoop(host).run(input({ message: "从虚构量化笔记考我两题，先只出题。", source, onVoiceText }));
  expect(result.text).toBe("第 1 题：样本外数据是否参与参数选择？\n\n第 2 题：如何从毛收益得到净收益？\n\n请按题号作答。");
  if (source === "voice") {
    expect(catalogs[0]).toContain("start_quiz");
    expect(result.voiceSpeech).toBe(result.text);
  }
  expect(onVoiceText).not.toHaveBeenCalled();
  expect(result.receipts).toEqual([receipt]);
  expect(requests).toHaveLength(source === "voice" ? 1 : 2);
});

it("asks for an actual day for a vague weekend plan and never saves a guessed date", async () => {
  const loop = new AgentLoop(host);
  const ambiguous = await loop.run(input({ message: "周末我要给虚构盆栽换盆。" }));
  expect(ambiguous.text).toBe("你想安排在周六还是周日？");
  expect(ambiguous.receipts).toEqual([]);
  expect(requests).toEqual([]);
  expect((await store.readTaskDb()).tasks).toEqual([]);
  responses.push(reply("已经安排在周六。", [tool("create_task", { title: "给虚构盆栽换盆", date: "2026-11-14" })]),
    reply("已记下周六给虚构盆栽换盆。"));
  const specified = await loop.run(input({ message: "周末我要在周六给虚构盆栽换盆。" }));
  expect(specified.receipts).toHaveLength(1);
  expect((await store.readTaskDb()).tasks[0].date).toBe("2026-11-14");
});

it("answers a voice correction or short yes with the correct period's task count and no write", async () => {
  for (const [title, day] of [["虚构上月记录", "2026-10-28"], ["虚构上周记录甲", "2026-11-03"], ["虚构上周记录乙", "2026-11-06"]]) {
    const task = await store.createTask({ title, date: day });
    const completedAt = day + "T04:00:00.000Z";
    await store.updateTask(task.id, item => ({
      ...item, status: "completed", completedAt, completionLog: [{ completedAt, note: "" }]
    }));
  }
  const loop = new AgentLoop(host);
  const history = [
    { role: "user", content: "上周完成了多少项任务？" },
    { role: "assistant", content: "你是要查上周的实际完成数吗？" }
  ] as AgentTurnInput["history"];
  const onVoiceText = vi.fn();
  const before = await readFile(join(root, store.taskDbPath()), "utf8");
  const corrected = await loop.run(input({ source: "voice", message: "不对，是上个月。", history, onVoiceText }));
  const accepted = await loop.run(input({ source: "voice", message: "对。", history, onVoiceText }));
  expect(corrected.text).toBe("上个月已完成 1 个任务。");
  expect(accepted.text).toBe("上周已完成 2 个任务。");
  expect(onVoiceText.mock.calls.flat()).toEqual([corrected.text, accepted.text]);
  expect(requests).toEqual([]);
  expect(corrected.toolCalls).toEqual([{ name: "get_stats", ok: true }]);
  expect(accepted.confirmations).toEqual([]);
  expect(await readFile(join(root, store.taskDbPath()), "utf8")).toBe(before);
});

it("reads the completed historical summary when a correction restates the task period", async () => {
  const loop = new AgentLoop(host);
  host.executeTools = async calls => calls.map(call => {
    expect(call.name).toBe("get_summaries");
    const { level, range } = call.arguments;
    expect(level).toBe("week");
    expect(range).toEqual({ from: "2026-11-02", to: "2026-11-08" });
    return { callId: call.id!, success: true, output: JSON.stringify({ summaries: [
      { from: "2026-11-02", through: "2026-11-08", complete: true, metrics: { tasksCompleted: 26 } }
    ] }), actions: [] };
  });
  const result = await loop.run(input({ source: "text", message: "不对，我问的是上周任务完成情况。", history: [
    { role: "user", content: "总结一下最近的任务完成情况。" },
    { role: "assistant", content: "这是今天的虚构待办。" }
  ] }));
  expect(result.text).toBe("上周完成了 26 项任务。");
  expect(result.toolCalls).toEqual([{ name: "get_summaries", ok: true }]);
  expect(requests).toEqual([]);
});

it("does not turn an unrelated confirmation into a task query", async () => {
  responses.push(reply("请说清楚你想确认哪件事。"));
  const result = await new AgentLoop(host).run(input({ source: "voice", message: "对。",
    history: [{ role: "user", content: "上周完成了多少项任务？" },
      { role: "assistant", content: "你确认要删除这条虚构任务吗？" }] }));
  expect(result.toolCalls).toEqual([]);
  expect(result.receipts).toEqual([]);
  expect(requests).toHaveLength(1);
});

it("reports only the selected habit's actual compensation as an existing task", async () => {
  const evening = new Date();
  evening.setHours(21, 0, 0, 0);
  for (const [name, minChars] of [["虚构阅读", 180], ["虚构跑步", 320]] as const) {
    await store.createHabit({ name, frequencyUnit: "day", frequencyInterval: 1, targetCount: 1,
      startDate: formatDate(evening), punishment: { enabled: true, rules: [{ kind: "reflection", minChars }] } });
  }
  await store.checkPunishments(evening);
  const result = await new AgentLoop(host).run(input({ message: "虚构阅读没达标会怎样？" }));
  expect(result.text).toContain("已有 1 项补偿待办");
  expect(result.text).toContain("写反思至少 180 字");
  expect(result.text).not.toContain("320");
  expect(result.toolCalls).toEqual([{ name: "list_tasks", ok: true }]);
  expect(result.receipts).toEqual([]);
  expect(requests).toEqual([]);
});

describe("unified agent loop", () => {
  it("streams text, retains only twelve history entries, and logs actual response counters", async () => {
    responses.push(reply("我可以帮你处理任务。"));
    const chunks: string[] = [];
    const result = await new AgentLoop(host).run(input({ message: "你可以做什么？", onText: delta => chunks.push(delta),
      history: Array.from({ length: 20 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", content: `虚构历史${index}` })) }));
    expect(result.text).toBe("我可以帮你处理任务。");
    expect(chunks.join("")).toBe(result.text);
    expect(requests[0]).toHaveLength(14);
    expect(requests[0][1].content).toBe("虚构历史8");
    expect(result.usage).toMatchObject({ model: "synthetic-model", inputTokens: 40, outputTokens: 5 });
    const logs = (await readFile(join(root, store.qualityLogPath()), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ captureMode: "agent-loop", toolCalls: [], actionSuggestions: 0 });
    expect(logs[0].providerRuns[0]).toMatchObject({ actualModel: "synthetic-model", responseUsage: { inputTokens: 40, outputTokens: 5 } });
  });

  it("executes a real write, returns its receipt, and undoes that exact operation", async () => {
    responses.push(reply("", [tool("create_task", { title: "纯虚构循环任务" })]), reply("已创建纯虚构循环任务。"));
    const receipts = vi.fn();
    const result = await new AgentLoop(host).run(input({ onReceipt: receipts }));
    expect((await store.readTaskDb({ readOnly: true })).tasks.map(task => task.title)).toContain("纯虚构循环任务");
    expect(result.receipts).toHaveLength(1);
    expect(receipts).toHaveBeenCalledWith(result.receipts[0]);
    expect(result.toolCalls).toEqual([{ name: "create_task", ok: true }]);
    expect(requests[1].filter(message => message.role === "tool")).toHaveLength(1);
    expect(result.usage.inputTokens).toBe(80);
    await runtime.undoOperation(result.receipts[0].operationId);
    expect((await store.readTaskDb({ readOnly: true })).tasks).toEqual([]);
  });

  it("renders the requested plain list using one model request and verified read results", async () => {
    const date = formatDate(now);
    await store.createTask({ title: "纯虚构待办", date, startTime: "15:00" });
    responses.push(reply("", [tool("list_tasks", { date, directReply: true })]));
    const chunks: string[] = [];
    const result = await new AgentLoop(host).run(input({ message: "把今天没完成的任务列出来。", onText: delta => chunks.push(delta) }));
    expect(requests).toHaveLength(1);
    expect(roles).toEqual(["fast"]);
    expect(result.toolCalls).toEqual([{ name: "list_tasks", ok: true }]);
    expect(result.text).toContain("今天有 1 个未完成任务");
    expect(result.text).toContain("纯虚构待办（计划 15:00 开始 · 结束未定）");
    expect(chunks.join("")).toBe(result.text);
    expect(result.usage.inputTokens).toBe(40);
  });

  it.each(["我今天还有什么任务没完成？", "今天有哪些未完成的待办？", "今天还剩哪些任务？"])(
    "lists unfinished tasks for an explicit text query without contacting the model (%s)", async message => {
      const date = formatDate(now);
      await store.createTask({ title: "虚构今日待办", date });
      const completed = await store.createTask({ title: "虚构今日已做", date });
      await store.completeTask(completed.id);
      await store.createTask({ title: "虚构明日待办", date: addDays(date, 1) });
      const readDashboard = vi.spyOn(store, "getTaskDashboard");
      const result = await new AgentLoop(host).run(input({ message }));
      expect(result.text).toBe("今天有 1 个未完成任务。\n1. 虚构今日待办");
      expect(result.toolCalls).toEqual([{ name: "list_tasks", ok: true }]);
      expect(result.receipts).toEqual([]);
      expect(requests).toEqual([]);
      expect(readDashboard).not.toHaveBeenCalled();
    });

  it.each(["text", "voice"] as const)("reports overdue and due-today task groups locally (%s)", async source => {
    const date = formatDate(now), yesterday = addDays(date, -1), tomorrow = addDays(date, 1);
    await store.createTask({ title: "虚构昨日到期", date, dueDate: yesterday });
    await store.createTask({ title: "虚构今日到期", date: tomorrow, dueDate: date });
    await store.createTask({ title: "虚构今日计划", date });
    await store.createTask({ title: "虚构明日到期", date, dueDate: tomorrow });
    const finished = await store.createTask({ title: "虚构逾期已完成", date: yesterday, dueDate: yesterday });
    await store.completeTask(finished.id);
    const onVoiceText = vi.fn();
    const result = await new AgentLoop(host).run(input({
      source, onVoiceText,
      message: "我今天还有什么任务没完成？请把已逾期的和今天到期的分开列出来。"
    }));
    expect(result.text.split("\n")).toEqual([
      "已逾期 1 项。", expect.stringContaining("虚构昨日到期"),
      "今天到期 1 项。", expect.stringContaining("虚构今日到期")
    ]);
    expect(result.toolCalls).toEqual([{ name: "list_tasks", ok: true }]);
    expect(result.receipts).toEqual([]);
    expect(requests).toHaveLength(0);
    if (source === "voice") expect(onVoiceText).toHaveBeenCalledExactlyOnceWith(result.text);
    responses.push(reply("虚构综合规划。"));
    expect((await new AgentLoop(host).run(input({ message: "我今天还有什么任务没完成？请把已逾期的和今天到期的分开列出来。再排一下优先级。" }))).text)
      .toBe("虚构综合规划。");
    expect(requests).toHaveLength(1);
  });

  it("reports a direct completed-task count before checking model availability", async () => {
    const date = formatDate(now);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    host.settings.ai = { ...host.settings.ai, provider: "off" };
    try {
      const task = await store.createTask({ title: "虚构已完成任务", date });
      await store.completeTask(task.id);
      const loop = new AgentLoop(host);
      const result = await loop.run(input({ message: "今天完成了几个任务？" }));
      expect(result.text).toBe("今天已完成 1 个任务。");
      expect(result.toolCalls).toEqual([{ name: "get_stats", ok: true }]);
      expect(result.receipts).toEqual([]);
      expect(requests).toHaveLength(0);
    } finally { vi.useRealTimers(); }
  });

  it.each(["single", "duplicate", "also-plan"])("reports the remaining count and highest priorities (%s)", async mode => {
    const date = formatDate(now);
    await store.createTask({ title: "虚构归档", date, quadrant: "not-important-not-urgent" });
    await store.createTask({ title: "虚构核对计划", date, quadrant: "important-not-urgent" });
    await store.createTask({ title: "虚构验收", date, quadrant: "important-urgent" });
    responses.push(reply("", [tool("list_tasks", { date, order: "priority", limit: 2, directReply: true }),
      ...(mode === "duplicate" ? [tool("list_tasks", { directReply: true }, "synthetic-count")] : []),
      ...(mode === "also-plan" ? [tool("plan_today", {}, "synthetic-plan")] : [])]));
    const result = await new AgentLoop(host).run(input({ message: "今天还剩几项，只说最要紧的两件。" }));
    expect(requests).toHaveLength(1);
    expect(result.text).toBe("今天还有 3 项未完成任务。先做：虚构验收、虚构核对计划。");
    expect(result.toolCalls).toEqual([{ name: "list_tasks", ok: true }]);
    expect((await store.readTaskDb({ readOnly: true })).tasks).toHaveLength(3);
  });

  it.each(["text", "voice"] as const)("reads the three status domains without a model for an overall status request (%s)", async source => {
    await store.createTask({ title: "虚构近期计划", date: formatDate(now) });
    await store.createTask({ title: "虚构较早计划", date: addDays(formatDate(now), -8) });
    const chunks: string[] = [];
    const spoken: string[] = [];
    const result = await new AgentLoop(host).run(input({ source, message: "讲讲我最近的整体状态。",
      onText: chunk => chunks.push(chunk), onVoiceText: chunk => spoken.push(chunk) }));
    expect(result.text).toContain("安排了 1 项任务，完成其中 0 项。");
    expect(result.text).toContain("0 项习惯有达标记录");
    expect(result.text).toContain("有 0 篇日记。没有可核对的状态数值。");
    expect(chunks.join("")).toBe(result.text);
    expect(spoken.join("")).toBe(source === "voice" ? result.text : "");
    expect(result.toolCalls).toEqual(Array.from({ length: 3 }, () => ({ name: "get_stats", ok: true })));
    expect(result.receipts).toEqual([]);
    expect(requests).toEqual([]);
  });

  it.each(["text", "voice"] as const)("keeps a narrowly scoped mood question on the requested topic (%s)", async source => {
    responses.push(reply("日记记载，最近精力偏低。"));
    const result = await new AgentLoop(host).run(input({ source, message: "我最近三天的情绪怎么样？" }));
    expect(result.text).toBe("日记记载，最近精力偏低。");
    expect(result.toolCalls).toEqual([]);
  });

  it("keeps the exact title when a single explicit task places its start in a separate clause", async () => {
    const title = "研习蓝色样品盒贴标签";
    const result = await new AgentLoop(host).run(input({ message: `请创建任务 ${title}，安排在明天下午三点。` }));
    expect(result.text).toContain(title);
    expect(result.receipts).toHaveLength(1);
    expect((await store.readTaskDb()).tasks).toMatchObject([{ title, date: addDays(formatDate(now), 1), time: "15:00" }]);
    expect(requests).toHaveLength(0);
  });

  it("reports precise market win rates with read-only tool results without a model rewrite", async () => {
    const date = formatDate(now);
    const stats = { domain: "trades", groupBy: "market", range: { from: date, to: date }, groups: [
      { key: "美股", byCurrency: { USD: { count: 8, winPercent: 57.14, winCount: 4, lossCount: 3 } } },
      { key: "外汇", byCurrency: { USD: { count: 4, winPercent: 66.67, winCount: 2, lossCount: 1 } } }
    ] };
    host.executeTools = async calls => calls.map(call => ({ callId: call.id!, success: true,
      output: call.name === "get_stats" ? JSON.stringify(stats) : "其他虚构交易说明", actions: [] }));
    responses.push(reply("", [tool("get_stats", { domain: "trades", range: "this_month", groupBy: "market" }),
      tool("inspect_trade_review", { period: "month" }, "additional-read")]));
    const result = await new AgentLoop(host).run(input({ message: "这个月各有记录的市场分别是什么胜率？" }));
    expect(result.text).toContain("美股：57.14%（盈利 4 笔，亏损 3 笔）");
    expect(result.text).toContain("外汇：66.67%（盈利 2 笔，亏损 1 笔）");
    expect(requests).toHaveLength(1);
  });

  it("reports the recorded rule version when the model also asks for trading statistics", async () => {
    const evidence = [{ date: "2026-11-12", label: "虚构合约多单", modelId: "model", versionId: "v1", ruleViolations: ["stop"] }];
    const rules = [
      { modelId: "model", versionId: "v2", modelName: "虚构新版", ruleId: "stop", text: "虚构新版规则" },
      { modelId: "model", versionId: "v1", modelName: "虚构第一版", ruleId: "stop", text: "虚构旧版止损规则" }
    ];
    host.executeTools = async calls => calls.map(call => ({ callId: call.id!, success: true,
      output: call.name === "inspect_trade_review" ? JSON.stringify({ evidence, rules }) : "其他虚构统计", actions: [] }));
    responses.push(reply("", [tool("get_stats", { domain: "trades", range: "this_month" }),
      tool("inspect_trade_review", { period: "month" }, "additional-read")]));
    const result = await new AgentLoop(host).run(input({ message: "给交易纪律提一条改进建议，说清楚哪笔违反哪条规则。" }));
    expect(result.text).toContain("虚构合约多单");
    expect(result.text).toContain("「虚构第一版」中的「虚构旧版止损规则」");
    expect(requests).toHaveLength(1);
  });

  it.each([true, false])("keeps verified reading links when requested (present in draft: %s)", async present => {
    const link = "[[虚构阅读/角色设定与镜头]]";
    const answer = present ? "参考：" + link : "可以先读《角色设定与镜头》。";
    host.executeTools = async calls => calls.map(call => ({ callId: call.id!, success: true,
      output: JSON.stringify({ articles: [{ title: "角色设定与镜头", link }] }), actions: [] }));
    responses.push(reply("", [tool("search_reading", { query: "虚构定格动画" })]), reply(answer));
    const chunks: string[] = [];
    const result = await new AgentLoop(host).run(input({ message: "哪些最近的阅读和虚构定格动画相关？给我原笔记链接。",
      onText: chunk => chunks.push(chunk) }));
    expect(result.text).toBe(present ? answer : answer + "\n\n笔记链接：" + link);
    expect(chunks.join("")).toBe(result.text);
    expect(result.receipts).toEqual([]);
  });

  it("reports the completion rate from the actual period without choosing a summary", async () => {
    const date = formatDate(now);
    await store.createTask({ title: "虚构本月计划", date });
    await store.createTask({ title: "虚构其他月计划", date: "2026-10-12" });
    const response = await new AgentLoop(host).run(input({ message: "我这个月任务完成率是多少？" }));
    expect(response.text).toContain("计划任务完成率为 0%，完成 0 项，共计划 1 项。");
    expect(response.toolCalls).toEqual([{ name: "get_stats", ok: true }]);
    expect(requests).toHaveLength(0);
  });

  it.each(["text", "voice"] as const)("answers a direct capacity question using the local plan (%s)", async source => {
    const facts = { today: { scheduled: 12 }, capacity: { overloaded: true, typicalCount: 6, suggestDefer: ["can-defer", "unavailable"] },
      scope: "只提供允许读取的记录", tasks: [{ id: "can-defer", title: "整理虚构样品" }, { id: "due", title: "交虚构周报" }] };
    const executeTools = vi.spyOn(host, "executeTools").mockImplementation(async calls => calls.map(call =>
      ({ callId: call.id!, success: true, output: JSON.stringify(facts), actions: [] })));
    const onVoiceText = vi.fn();
    const loop = new AgentLoop(host);
    const result = await loop.run(input({ source, message: "今天是不是排多了？", onVoiceText }));
    expect(result.text).toBe("按近期记录，今天的待办已超载。今天原排 12 项，常态每天完成约 6 项。可以考虑延后「整理虚构样品」。只统计允许读取的记录。");
    expect(executeTools.mock.calls[0][0]).toMatchObject([{ name: "plan_today", arguments: {} }]);
    if (source === "voice") expect(onVoiceText).toHaveBeenCalledExactlyOnceWith(result.text);
    expect(requests).toHaveLength(0);
    expect(result.receipts).toEqual([]);
    expect(result.confirmations).toEqual([]);
    responses.push(reply("虚构综合规划。"));
    expect((await loop.run(input({ source, message: "今天是不是排多了？顺便把虚构周报挪到明天。" }))).text)
      .toBe("虚构综合规划。");
    expect(requests).toHaveLength(1);
  });

  it.each(["text", "voice"] as const)("answers explicit device sleep questions from confirmed health records (%s)", async source => {
    const date = formatDate(now);
    const previous = addDays(date, -1);
    await store.appendHealthEntry({ date, sleepHours: 7.75 });
    await store.appendHealthEntry({ date: previous, sleepHours: 5.25 });
    await store.appendHealthEntry({ date: addDays(date, 1), sleepHours: 20 });
    const spoken = vi.fn();
    const message = "最近三天设备记录的睡眠时长平均是多少小时？";
    const result = await new AgentLoop(host).run(input({ source, message, onVoiceText: spoken }));
    expect(result.text).toContain("有 2 天设备睡眠记录，平均 6.5 小时。");
    if (source === "voice") expect(spoken).toHaveBeenCalledExactlyOnceWith(result.text);
    expect(result.toolCalls).toEqual([{ name: "get_stats", ok: true }]);
    expect(requests).toHaveLength(0);
    store.settings.privacy!.excludedVaultPrefixes = [store.path(store.settings.folders.health, previous + ".md")];
    const scoped = await new AgentLoop(host).run(input({ source, message }));
    expect(scoped.text).toContain("有 1 天设备睡眠记录，平均 7.75 小时。只统计允许读取的健康记录。");
    store.settings.privacy!.excludedVaultPrefixes.push(store.path(store.settings.folders.health, date + ".md"));
    const empty = await new AgentLoop(host).run(input({ source, message }));
    expect(empty.text).toContain("暂无可读的设备睡眠记录。只统计允许读取的健康记录。");
    expect(requests).toHaveLength(0);
  });

  it("can read one clearly requested device sleep result offline and keeps qualitative analysis in the model path", async () => {
    const date = formatDate(now);
    await store.appendHealthEntry({ date, sleepHours: 7.5 });
    const saved = host.settings.ai;
    host.settings.ai = { ...saved, provider: "off" };
    let local;
    try {
      local = await new AgentLoop(host).run(input({ message: "昨晚手表记录的睡眠时长是多少小时？" }));
    } finally { host.settings.ai = saved; }
    expect(local.text).toContain(date + " 有 1 天设备睡眠记录，平均 7.5 小时。");
    expect(requests).toHaveLength(0);
    responses.push(reply("虚构问题走一般分析。"));
    const mixed = await new AgentLoop(host).run(input({ message: "这周手表记录的睡眠时长平均是多少，为什么会这样？" }));
    expect(mixed.text).toBe("虚构问题走一般分析。");
    expect(requests).toHaveLength(1);
  });

  it("uses measured values, their date coverage, and explicit aggregations for other device questions", async () => {
    const today = formatDate(now), yesterday = addDays(today, -1), tomorrow = addDays(today, 1);
    await store.appendHealthEntry({ date: today, steps: 0, runningKm: 2.25, weightKg: 70.5 });
    await store.appendHealthEntry({ date: yesterday, steps: 1234, runningKm: 1.25, weightKg: 71.5, restingHeartRate: 61 });
    await store.appendHealthEntry({ date: tomorrow, steps: 9999, runningKm: 100, restingHeartRate: 45 });
    const loop = new AgentLoop(host);
    const questions = [
      ["今天手表记录的步数是多少步？", "有 1 天设备步数记录，记录值 0 步。"],
      ["最近三天设备记录的步数合计多少步？", "有 2 天设备步数记录，合计 1234 步。"],
      ["过去三天设备记录的跑步距离一共是多少公里？", "有 2 天设备跑步距离记录，合计 3.5 公里。"],
      ["最近三天手表记录的体重平均是多少公斤？", "有 2 天设备体重记录，平均 71 公斤。"],
      ["最近三天手表记录的静息心率平均是多少次/分？", "有 1 天设备静息心率记录，平均 61 次/分。"],
      ["今天设备记录的静息心率是多少？", "暂无可读的设备静息心率记录。"]
    ] as const;
    for (const [message, expected] of questions) {
      const onVoiceText = vi.fn();
      const result = await loop.run(input({ source: "voice", message, onVoiceText }));
      expect(result.text).toContain(expected);
      expect(result.toolCalls).toEqual([{ name: "get_stats", ok: true }]);
      expect(onVoiceText).toHaveBeenCalledExactlyOnceWith(result.text);
    }
    expect(requests).toHaveLength(0);
    responses.push(reply("虚构综合分析。"));
    const mixed = await loop.run(input({ message: "今天设备记录的步数是多少，为什么走得少？" }));
    expect(mixed.text).toBe("虚构综合分析。");
    expect(requests).toHaveLength(1);
  });

  it.each(["get_stats", "query_vault"])("adds verified habit dates only from the stats tool (%s)", async name => {
    const answer = "虚构存钱在11月11日没达标。";
    const report = { domain: "habits", range: { from: "2026-11-09", to: "2026-11-12" },
      habits: [{ name: "虚构存钱", goals: [{ period: "day", missedDates: ["2026-11-10", "2026-11-11"] }] }] };
    vi.spyOn(host, "executeTools").mockImplementation(async calls => calls.map(call =>
      ({ callId: call.id!, success: true, output: JSON.stringify(report), actions: [] })));
    responses.push(reply("", [tool(name, name === "get_stats" ? { domain: "habits", range: "this_week" }
      : { domain: "note", operation: "search", query: "虚构统计" })]), reply(answer));
    const streamed: string[] = [];
    const result = await new AgentLoop(host).run(input({ message: "复核本周虚构习惯", onText: chunk => streamed.push(chunk) }));
    expect(result.text).toBe(name === "get_stats"
      ? answer + "\n\n核对到的未达标日期：「虚构存钱」11-10、11-11。" : answer);
    expect(streamed.join("")).toContain(answer);
  });

  it("expands advanced tools when the short-text model selects that capability", async () => {
    responses.push(reply("", [tool("load_more_tools", {})]), reply("已准备好查询项目。"));
    const result = await new AgentLoop(host).run(input({ message: "查我的项目" }));
    expect(catalogs[0]).toContain("load_more_tools");
    expect(catalogs[0]).not.toContain("query_projects");
    expect(catalogs[1]).toContain("query_projects");
    expect(result.toolCalls).toEqual([{ name: "load_more_tools", ok: true }]);
  });

  it("returns the exact habit name from the delete confirmation without another model call", async () => {
    const habit = await store.createHabit({ name: "虚构阅读", frequencyUnit: "day", frequencyInterval: 1, targetCount: 1 });
    responses.push(reply("", [tool("delete_habit", { name: habit.name })]));
    const result = await new AgentLoop(host).run(input({ message: "删除虚构阅读习惯" }));
    expect(result.text).toBe("已生成删除「虚构阅读」的确认卡，点击确认后才会删除。");
    expect(result.confirmations).toMatchObject([{ type: "delete_habit", habitIds: [habit.id] }]);
    expect(requests).toHaveLength(1);
    expect((await store.readHabitDb()).habits.some(item => item.id === habit.id)).toBe(true);
  });

  it("makes an explicit tomorrow draft selection continue to a capacity-checked confirmation", async () => {
    const date = addDays(todayString(), 1);
    const prepare = vi.fn(async () => ({ id: "preview-tomorrow", type: "task_plan" as const, title: "确认安排",
      description: "点确认后保存", content: "虚构草案", date, taskPlanToken: "preview-token" }));
    runtime = new AgentRuntime({ store, refreshViews: async () => {}, prepareTaskPlan: prepare });
    responses.push(reply("", [tool("plan_today", { draftTomorrow: true })]),
      reply("", [tool("propose_task_plan", { tasks: [{ title: "准备虚构材料", date }] })]));
    const result = await new AgentLoop(host).run(input({ message: "给我安排一下明天" }));
    expect(toolChoices[1]).toEqual({ type: "function", function: { name: "propose_task_plan" } });
    expect(prepare).toHaveBeenCalledOnce();
    expect(result.confirmations).toMatchObject([{ type: "task_plan" }]);
    expect((await store.readTaskDb()).tasks).toEqual([]);
  });

  it("keeps provisional tool text and generated write claims out of the voice stream", async () => {
    const onVoiceText = vi.fn();
    responses.push(reply("我已经记好了。", [tool("create_task", { title: "虚构语音回执" })]), reply("任务已创建。"));
    const result = await new AgentLoop(host).run(input({ source: "voice", message: "把虚构语音回执记作待办。", onVoiceText }));
    expect(result.receipts).toHaveLength(1);
    expect(result.voiceSpeech).toBe("已创建任务：虚构语音回执。");
    expect(onVoiceText).not.toHaveBeenCalled();
    expect((await store.readTaskDb()).tasks).toMatchObject([{ title: "虚构语音回执" }]);
  });

  it("speaks only verified journal, habit and trading receipts and can undo a saved voice write", async () => {
    const habit = await store.createHabit({ name: "虚构阅读习惯", frequencyUnit: "day", frequencyInterval: 1, targetCount: 1 });
    const loop = new AgentLoop(host);
    const voice = async (message: string, name: string, args: Record<string, unknown>) => {
      responses.push(reply("", [tool(name, args)]));
      responses.push(name === "undo_latest_operation" ? voiceUndoApproval() : reply("模型输出的示例文字。"));
      return loop.run(input({ source: "voice", message }));
    };
    const checkin = await voice("给虚构阅读习惯打卡", "complete_habit", { name: habit.name });
    expect(checkin.voiceSpeech).toBe("已完成今日打卡：虚构阅读习惯。");
    expect((await store.readHabitDb()).checkins).toContainEqual(expect.objectContaining({ habitId: habit.id, status: "done" }));
    const transcript = "记到晚间日记：嗯，虚构蓝纸盒今天没整理。\n## 虚构行\n~~~  先保留这句。  ";
    const note = await voice(transcript, "append_journal_entry", { period: "晚", content: "今天没整理蓝纸盒。", heading: "原话" });
    expect(note.voiceSpeech).toBe("好，已经记进日记了。");
    const diaryPath = store.dailyNotePath(todayString(), "晚");
    const firstDiary = await store.readPath(diaryPath);
    expect(firstDiary).toContain("## 整理\n\n今天没整理蓝纸盒。");
    expect(firstDiary).toContain("## 原话\n\n~~~~\n" + transcript + "\n~~~~");
    const second = "记到晚间日记：准备先整理一个。";
    await voice(second, "append_journal_entry", { period: "晚", content: "先整理一个。"});
    const diary = await store.readPath(diaryPath);
    expect(diary.match(/^## 原话$/gm)).toHaveLength(1);
    expect(diary).toContain(transcript);
    expect(diary).toContain("~~~\n" + second + "\n~~~");
    expect(diary.indexOf("先整理一个。")).toBeLessThan(diary.indexOf("## 原话"));
    const trade = await voice("记一笔虚构交易，A股 ZTEST8 做多", "record_trade", {
      trades: [{ market: "A股", symbol: "ZTEST8", direction: "long" }] });
    expect(trade.voiceSpeech).toBe("已记下 1 笔交易。");
    expect((await readTradeDatabase(store)).trades).toHaveLength(1);
    const undo = await voice("撤销", "undo_latest_operation", {});
    expect(undo.voiceSpeech).toBe("已撤销这次交易记录。");
    expect((await readTradeDatabase(store)).trades).toHaveLength(0);
  });

  it("preserves the original diary turn through batch confirmation", async () => {
    const message = "请都记下。\n晚间原话：嗯，虚构路线今天才画完。";
    const date = formatDate(now);
    responses.push(reply("", [
      tool("append_journal_entry", { date, period: "晚", content: "虚构路线绘制完毕。" }, "journal"),
      ...["纸夹", "纸袋", "纸盒"].map(title => tool("create_task", { title: "虚构归档" + title, date }, title))
    ]));
    const result = await new AgentLoop(host).run(input({ message }));
    const [action] = result.confirmations;
    expect(action.type).toBe("tool_batch");
    expect(JSON.stringify(action)).not.toContain("今天才画完");
    const path = store.dailyNotePath(date, "晚");
    expect(await store.readPath(path)).toBe("");
    await executeConfirmedToolBatch(action, runtime, () => {});
    expect(await store.readPath(path)).toContain("## 原话\n\n~~~\n" + message + "\n~~~");
    expect((await store.readTaskDb()).tasks).toHaveLength(3);
  });

  it("preserves journal frontmatter and stops before appending into an open code fence", async () => {
    const date = formatDate(now), path = store.dailyNotePath(date, "晚");
    const header = "\uFEFF---\r\nsubject: |\r\n  ## 整理\r\n---\r\n";
    const available = header + "\r\n## 原话\r\n\r\n已有原话\r\n";
    await store.writeFile(path, available);
    const args = { date, period: "晚", content: "汇总虚构新句。" };
    const original = "记下今天整理好了。";
    const stored = await runtime.executeAiToolCall(tool("append_journal_entry", args, "journal-frontmatter"), "kimi", original);
    expect(stored.success).toBe(true);
    const diary = await store.readPath(path);
    expect(diary.startsWith(header)).toBe(true);
    expect(diary).toContain("## 整理\n\n汇总虚构新句。");
    expect(diary).toContain(original);

    const openFence = header + "\n## 整理\n\n~~~text\n用户尚在填写。\n";
    await store.writeFile(path, openFence);
    const blocked = await runtime.executeAiToolCall(tool("append_journal_entry", args, "journal-open-fence"), "kimi", original);
    expect(blocked.success).toBe(false);
    expect(blocked.output).toContain("未闭合");
    expect(await store.readPath(path)).toBe(openFence);
  });

  it("leaves hidden Markdown headings alone when writing the evening diary", async () => {
    const date = formatDate(now), path = store.dailyNotePath(date, "晚");
    const comment = "<!--\n## 原话\n虚构模板\n-->\n%%\n## 整理\n%%\n";
    await store.writeFile(path, "# 虚构日记\n" + comment);
    const args = { date, period: "晚", content: "写完地图。" };
    const original = "刚把虚构地图画好了。";
    const saved = await runtime.executeAiToolCall(tool("append_journal_entry", args, "journal-comment"), "kimi", original);
    expect(saved.success).toBe(true);
    expect(await store.readPath(path)).toContain(comment + "\n## 整理");
    expect(await store.readPath(path)).toContain("## 原话\n\n~~~\n" + original);
    const unfinished = "%%\n虚构草稿还在填写\n";
    await store.writeFile(path, unfinished);
    const blocked = await runtime.executeAiToolCall(tool("append_journal_entry", args, "journal-open-comment"), "kimi", original);
    expect(blocked.output).toContain("未闭合的属性、注释或代码块");
    expect(await store.readPath(path)).toBe(unfinished);
  });

  it("keeps an automatically saved memory when undoing the task from the same turn", async () => {
    const loop = new AgentLoop(host);
    const title = "虚构样品盒贴标签", preference = "我习惯用虚构绿色标签归档";
    responses.push(reply("", [tool("create_task", { title }, "same-turn-task"), tool("append_memory_note", { content: preference }, "same-turn-memory")]), reply("已保存。"));
    await loop.run(input({ message: `创建任务${title}。${preference}。` }));
    expect((await store.readTaskDb()).tasks).toHaveLength(1);
    expect((await store.readPersonalMemories()).records.map(record => record.content)).toContain(preference);

    const callsBeforeUndo = requests.length;
    const undo = await loop.run(input({ source: "voice", message: "撤销刚才那个。" }));
    expect(undo.text).toContain(title);
    expect(undo.voiceSpeech).toBe(undo.text);
    expect(requests).toHaveLength(callsBeforeUndo);
    expect((await store.readTaskDb()).tasks).toEqual([]);
    expect((await store.readPersonalMemories()).records.map(record => record.content)).toContain(preference);

    responses.push(reply("", [tool("undo_latest_operation", { memoryOnly: true })]));
    const memoryUndo = await loop.run(input({ message: "撤销刚才保存的记忆。" }));
    expect(memoryUndo.text).toContain("个人记忆");
    expect((await store.readPersonalMemories()).records.map(record => record.content)).not.toContain(preference);
  });

  it("clarifies a bare voice deletion and preserves an older idea without using the model", async () => {
    const idea = await runtime.executeAiToolCall(tool("upsert_idea", {
      title: "虚构旧想法", description: "用彩纸制作地图。"
    }, "older-voice-idea"), "kimi");
    const task = await runtime.executeAiToolCall(tool("create_task", {
      title: "虚构待办"
    }, "new-voice-task"), "kimi");
    expect(idea).toMatchObject({ success: true });
    expect(task).toMatchObject({ success: true });
    expect(await runtime.undoOperation("new-voice-task")).toBe(true);
    const result = await new AgentLoop(host).run(input({ source: "voice", message: "删除。" }));

    expect(result.text).toContain("你想删除哪一条");
    expect(result.toolCalls).toEqual([]);
    expect(requests).toEqual([]);
    expect((await new OperationLedger(store).latestReversible())?.operationId).toBe("older-voice-idea");
  });

  it("offers a completed read-only response to the voice output", async () => {
    const onVoiceText = vi.fn();
    responses.push(reply("正在查看。", [tool("get_stats", { domain: "tasks", range: "today" })]), reply("今天还没完成任务。"));
    const result = await new AgentLoop(host).run(input({ source: "voice", message: "请概括一下今天的工作进展。", onVoiceText }));
    expect(result.text).toBe("今天还没完成任务。");
    expect(onVoiceText).toHaveBeenCalledExactlyOnceWith("今天还没完成任务。");
  });

  it("speaks a single requested count straight from the tool without a second model turn", async () => {
    const habit = await store.createHabit({ name: "虚构跑步", frequencyUnit: "day", frequencyInterval: 1, targetCount: 1 });
    await store.recordHabitStatus(habit.id, "done", todayString());
    const onVoiceText = vi.fn();
    responses.push(reply("", [tool("get_stats", { domain: "habits", range: "today", habitName: "虚构跑步", voiceAnswer: "habit_checkin" })]));
    const result = await new AgentLoop(host).run(input({ source: "voice", message: "今天虚构跑步打卡了吗？", onVoiceText }));
    expect(result.text).toBe("今天已给「虚构跑步」打卡。");
    expect(onVoiceText).toHaveBeenCalledExactlyOnceWith(result.text);
    expect(roles).toEqual(["fast"]);
  });

  it("speaks the requested top tasks in tool order without another model turn or a write", async () => {
    const date = todayString();
    await store.createTask({ title: "虚构归档", date, quadrant: "not-important-not-urgent" });
    await store.createTask({ title: "虚构汇总", date, quadrant: "important-not-urgent" });
    await store.createTask({ title: "虚构核对", date, quadrant: "important-urgent" });
    const before = await store.readTaskDb();
    const onVoiceText = vi.fn();
    responses.push(reply("", [tool("plan_today", { voicePriorityCount: 2 })]));

    const result = await new AgentLoop(host).run(input({ source: "voice", message: "今天该先做哪两件事？", onVoiceText }));

    expect(result.text).toBe("先做「虚构核对」，今天到期，重要且紧急。然后做「虚构汇总」，今天到期，重要不紧急。");
    expect(onVoiceText).toHaveBeenCalledExactlyOnceWith(result.text);
    expect(requests).toHaveLength(1);
    expect(await store.readTaskDb()).toEqual(before);
  });

  it("retries the required plan call when the model returns an unrelated read", async () => {
    const date = addDays(todayString(), 1);
    const prepare = vi.fn(async () => ({ id: "retry-tomorrow", type: "task_plan" as const, title: "确认安排",
      description: "点确认后保存", content: "虚构草案", date, taskPlanToken: "preview-token" }));
    runtime = new AgentRuntime({ store, refreshViews: async () => {}, prepareTaskPlan: prepare });
    responses.push(reply("", [tool("plan_today", { draftTomorrow: true }), tool("list_tasks", { status: "active" }, "other-reading")]),
      reply("已准备好", [tool("list_tasks", { status: "active" })]),
      reply("", [tool("propose_task_plan", { tasks: [{ title: "准备虚构材料", date }] })]));
    const onText = vi.fn();
    const result = await new AgentLoop(host).run(input({ message: "给我安排一下明天", onText }));
    expect(catalogs.slice(1)).toEqual([["propose_task_plan"], ["propose_task_plan"]]);
    expect(result.toolCalls.filter(call => call.name === "list_tasks")).toHaveLength(1);
    expect(result.confirmations).toMatchObject([{ type: "task_plan", date }]);
    expect(onText).not.toHaveBeenCalledWith("已准备好");
    expect(prepare).toHaveBeenCalledOnce();
    expect((await store.readTaskDb()).tasks).toEqual([]);
  });

  it("repairs a rejected tomorrow draft before showing the real confirmation", async () => {
    const date = addDays(todayString(), 1);
    const prepare = vi.fn(async (tasks) => {
      if (tasks[0].time !== "09:00") throw Error("任务标题、日期或时间无法识别，请核对后再保存。");
      return { id: "repaired-tomorrow", type: "task_plan" as const, title: "确认安排", description: "点确认后保存",
        content: "虚构草案", date, taskPlanToken: "preview-token" };
    });
    runtime = new AgentRuntime({ store, refreshViews: async () => {}, prepareTaskPlan: prepare });
    const onText = vi.fn();
    responses.push(reply("", [tool("plan_today", { draftTomorrow: true })]),
      reply("确认卡已生成", [tool("propose_task_plan", { tasks: [{ title: "准备虚构材料", date, time: "09:00–10:00" }] })]),
      reply("", [tool("propose_task_plan", { tasks: [{ title: "准备虚构材料", date, time: "09:00" }] })]));
    const result = await new AgentLoop(host).run(input({ message: "给我安排一下明天", onText }));
    expect(catalogs.slice(1, 3)).toEqual([["propose_task_plan"], ["propose_task_plan"]]);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(result.confirmations).toMatchObject([{ type: "task_plan", content: "虚构草案", date }]);
    expect(result.text).toContain("尚未保存任何任务");
    expect(onText).not.toHaveBeenCalledWith("确认卡已生成");
    expect((await store.readTaskDb()).tasks).toEqual([]);
  });

  it("limits execution to four tool rounds even if the final model response asks again", async () => {
    host.executeTools = vi.fn(async (calls: AiToolCall[]) => calls.map(call => ({ callId: call.id!, success: true, output: "纯虚构查询结果", actions: [] })));
    responses.push(...Array.from({ length: 5 }, () => reply("", [tool("query_vault", { domain: "task", operation: "list" })])));
    const result = await new AgentLoop(host).run(input({ message: "读取纯虚构任务。" }));
    expect(host.executeTools).toHaveBeenCalledTimes(4);
    expect(requests).toHaveLength(5);
    expect(result.toolCalls).toHaveLength(4);
    expect(result.text).toContain("本轮处理已到上限");
  });

  it("requires confirmation before four writes in one response", async () => {
    responses.push(reply("", Array.from({ length: 4 }, (_, index) => tool("create_task", { title: `纯虚构批量${index}` }, `call-${index}`))), reply("四项任务等待确认。"));
    const execute = vi.spyOn(host, "executeTools");
    const result = await new AgentLoop(host).run(input());
    expect(execute).not.toHaveBeenCalled();
    expect((await store.readTaskDb({ readOnly: true })).tasks).toEqual([]);
    expect(result.confirmations).toHaveLength(1);
    await executeConfirmedToolBatch(result.confirmations[0], runtime, () => {});
    expect((await store.readTaskDb({ readOnly: true })).tasks).toHaveLength(4);
  });

  it("counts writes across rounds and confirms only the remaining write", async () => {
    responses.push(...Array.from({ length: 4 }, (_, index) => reply("", [tool("create_task", { title: `纯虚构分轮${index}` })])), reply("三项已保存，剩余一项待确认。"));
    const result = await new AgentLoop(host).run(input());
    expect(result.receipts).toHaveLength(3);
    expect((await store.readTaskDb({ readOnly: true })).tasks).toHaveLength(3);
    expect(result.confirmations[0]).toMatchObject({ type: "tool_batch", batchWriteCount: 4 });
    expect(result.confirmations[0].toolBatch).toHaveLength(1);
    await executeConfirmedToolBatch(result.confirmations[0], runtime, () => {});
    expect((await store.readTaskDb({ readOnly: true })).tasks.map(task => task.title).sort())
      .toEqual(Array.from({ length: 4 }, (_, index) => `纯虚构分轮${index}`));
  });

  it("retains a committed receipt when cancellation arrives after a write", async () => {
    const abort = new AbortController();
    responses.push(reply("", [tool("create_task", { title: "纯虚构取消前已保存" })]));
    const result = await new AgentLoop(host).run(input({ signal: abort.signal, onReceipt: () => abort.abort() }));
    expect(result.receipts).toHaveLength(1);
    expect(result.text).toContain("已创建");
    expect(result.text).toContain("其余处理已停止");
    expect((await store.readTaskDb({ readOnly: true })).tasks).toHaveLength(1);
  });

  it("keeps earlier receipts when a later model request fails", async () => {
    responses.push(reply("", [tool("create_task", { title: "纯虚构回复失败前已保存" })]), Error("Synthetic provider failure"));
    const result = await new AgentLoop(host).run(input());
    expect(result.receipts).toHaveLength(1);
    expect(result.text).toContain("后续回复未完成");
    expect((await store.readTaskDb({ readOnly: true })).tasks).toHaveLength(1);
  });

  it("keeps deep analysis internal and preserves mixed call order", async () => {
    const effects: string[] = [], chunks: string[] = [];
    host.executeTools = async calls => calls.map(call => { effects.push(call.name); return { callId: call.id!, success: true, output: "纯虚构结果", actions: [] }; });
    responses.push(reply("", [tool("query_vault", {}, "read"), tool("deep_analysis", { question: "纯虚构分析", scope: "纯虚构资料" }, "deep"), tool("create_task", {}, "write")]),
      reply("仅供内部使用的纯虚构深度稿"), reply("分析完成。"));
    const original = host.aiForRole;
    host.aiForRole = role => { if (role === "deep") effects.push("deep"); return original(role); };
    const result = await new AgentLoop(host).run(input({ source: "voice", onText: delta => chunks.push(delta) }));
    expect(effects).toEqual(["query_vault", "deep", "create_task"]);
    expect(roles).toEqual(["fast", "deep", "fast"]);
    expect(chunks.join("")).toBe("分析完成。");
    expect(result.usage.inputTokens).toBe(120);
  });

  it("does not estimate missing usage or call a model when disabled", async () => {
    responses.push({ content: "纯虚构无用量回复", toolCalls: [] });
    const result = await new AgentLoop(host).run(input());
    expect(result.usage.inputTokens).toBeUndefined();
    host.settings.ai.provider = "off";
    const before = requests.length;
    const offline = await new AgentLoop(host).run(input());
    expect(requests).toHaveLength(before);
    expect(host.offlineFallback).toHaveBeenCalled();
    expect(offline.usage.model).toBe("offline");
  });

  it("bounds resident context and reads the injected date without changing files", async () => {
    for (let index = 0; index < 20; index++) await store.createTask({ title: `纯虚构长标题${index}${"甲".repeat(100)}`, date: "2026-11-12" });
    const before = await readFile(join(root, store.taskDbPath()), "utf8");
    const context = await buildResidentContext(store, "纯虚构查询", now);
    expect(Buffer.byteLength(context.text, "utf8")).toBeLessThanOrEqual(RESIDENT_CONTEXT_BYTE_LIMIT);
    expect(context.text).toContain("2026-11-12");
    expect(context.text).toContain("必须给确认卡");
    expect(context.text).toContain("不得鼓励");
    expect(await readFile(join(root, store.taskDbPath()), "utf8")).toBe(before);
  });

  it("selects existing model configurations without mutating stored settings", () => {
    const settings = structuredClone(host.settings);
    settings.ai = { ...settings.ai, fallbackProvider: "custom", fallbackEndpoint: "https://fiction-fast.invalid/chat", fallbackModel: "synthetic-fast" };
    expect(settingsForAgentModel(settings, "fast").ai).toMatchObject({ model: "synthetic-fast", fallbackModel: "synthetic-model" });
    expect(settingsForAgentModel(settings, "deep").ai.model).toBe("synthetic-model");
    expect(settings.ai.model).toBe("synthetic-model");
  });

  it("requests DeepSeek non-thinking mode and records actual usage through the fallback transport", async () => {
    const settings = structuredClone(host.settings);
    settings.ai = { ...settings.ai, model: "deepseek-v4-flash", fallbackProvider: "custom",
      fallbackEndpoint: "https://fiction-fallback.invalid/chat", fallbackModel: "kimi-k2.6" };
    const wire = [
      { model: "kimi-k2.6", choices: [{ index: 0, delta: { content: "纯虚构备用回复" }, finish_reason: null }] },
      { model: "kimi-k2.6", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      { model: "kimi-k2.6", choices: [], usage: { prompt_tokens: 120, completion_tokens: 8, total_tokens: 128 } }
    ].map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n";
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValueOnce(new TypeError("Synthetic transport failure"))
      .mockResolvedValueOnce(new Response(wire, { headers: { "content-type": "text/event-stream" } }));
    vi.stubGlobal("fetch", fetch);
    const result = await new LifeOpsAi(settings).agentTurnStream([{ role: "user", content: "纯虚构问候" }], () => {}, { reasoning: "disabled" });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([settings.ai.endpoint, settings.ai.fallbackEndpoint]);
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toMatchObject({
      thinking: { type: "disabled" }, stream_options: { include_usage: true }
    });
    expect(result.providerRun).toMatchObject({ fallbackUsed: true, actualModel: "kimi-k2.6",
      responseUsage: { status: "reported", inputTokens: 120, outputTokens: 8 } });
  });

  it("uses the plugin's tool executor and persists a normal text conversation through the new entry adapter", async () => {
    const message = "请创建任务 纯虚构接入测试。";
    responses.push(reply("", [tool("create_task", { title: "纯虚构接入测试" })]), reply("已创建纯虚构接入测试。"));
    const plugin = Object.assign(Object.create(Plugin.prototype), { app: store.app, store, settings: store.settings,
      ai: host.aiForRole("main"), lifecycleGeneration: 1, unloaded: false, refreshViews: async () => {} });
    const streamed = vi.fn();
    const result = await runAgentTurn.call(plugin, message, [], streamed, { source: "text" });
    expect(result.receipts).toHaveLength(1);
    expect(streamed).toHaveBeenLastCalledWith(result.reply);
    const conversations = store.path(store.settings.folders.aiReports, "Conversations");
    const file = store.app.vault.getMarkdownFiles().find(item => item.path.startsWith(`${conversations}/`));
    expect(await store.readPath(file!.path)).toContain(message);
    expect((await store.readTaskDb({ readOnly: true })).tasks.map(task => task.title)).toEqual(["纯虚构接入测试"]);
  });
});

it("uses the four local commands without a model and gives undo receipts for local writes", async () => {
  store.settings.ai.provider = "off";
  const habit = await store.createHabit({ name: "纯虚构读书", frequencyUnit: "day", frequencyInterval: 1, targetCount: 1 });
  const plugin = Object.assign(Object.create(Plugin.prototype), { app: store.app, store, settings: store.settings,
    ai: host.aiForRole("main"), lifecycleGeneration: 1, unloaded: false, refreshViews: async () => {} });
  const submit = (message: string) => plugin.submitAgentMessage(message, [], { selfTest: true });
  expect((await submit("今天还有什么？")).reply).toContain("没有剩余");
  const created = await submit("建任务：纯虚构整理资料");
  expect(created.receipts).toHaveLength(1);
  expect((await submit("/today")).reply).toContain("纯虚构整理资料");
  const completed = await submit("完成任务：纯虚构整理资料");
  expect(completed.receipts).toHaveLength(1);
  expect((await store.readTaskDb({ readOnly: true })).tasks[0].status).toBe("completed");
  const checked = await submit("打卡 纯虚构读书");
  expect(checked.receipts).toHaveLength(1);
  expect((await store.readHabitDb()).checkins).toEqual([expect.objectContaining({ habitId: habit.id, status: "done" })]);
  const before = await readFile(join(root, store.habitDbPath()), "utf8");
  expect((await submit("删除习惯 纯虚构读书")).actions).toEqual([]);
  expect(await readFile(join(root, store.habitDbPath()), "utf8")).toBe(before);
  expect(requests).toEqual([]);
});

it("keeps a successful query for a requested undo across model rounds", async () => {
  const task = await runtime.executeAiToolCall(tool("create_task", { title: "纯虚构需撤销" }, "undo-original"), "kimi");
  expect(task.success).toBe(true);
  const plugin = Object.assign(Object.create(Plugin.prototype), { app: store.app, store, settings: store.settings,
    ai: host.aiForRole("main"), lifecycleGeneration: 1, unloaded: false, refreshViews: async () => {} });
  responses.push(
    reply("", [tool("query_vault", { domain: "task", operation: "list" }, "prior-query")]),
    reply("", [tool("undo_latest_operation", { taskTitle: "纯虚构需撤销", requirePriorQuery: true }, "undo-after-read")]),
    reply("已撤销纯虚构需撤销。")
  );
  const result = await plugin.submitAgentMessage("请先查询任务，然后撤销刚创建的纯虚构需撤销。", [], { selfTest: true });
  expect(result.reply).toContain("已撤销");
  expect((await store.readTaskDb({ readOnly: true })).tasks).toEqual([]);
  expect(requests).toHaveLength(3);
});

it("keeps a requested query prerequisite and runs a subsequent bare undo locally", async () => {
  const original = await runtime.executeAiToolCall(tool("create_task", { title: "虚构整理盒子" }, "undo-retry-original"), "kimi");
  expect(original.success).toBe(true);
  const plugin = Object.assign(Object.create(Plugin.prototype), { app: store.app, store, settings: store.settings,
    ai: host.aiForRole("main"), lifecycleGeneration: 1, unloaded: false, refreshViews: async () => {} });
  responses.push(
    reply("", [tool("undo_latest_operation", { requirePriorQuery: true }, "unsupported-query-requirement")]),
    reply("", [tool("choose_voice_job_control", { intent: "ordinary", target: "unknown" })]),
    reply("这次没有执行撤销。")
  );
  const refused = await plugin.submitAgentMessage("请先查记录再撤销刚才那个。", [], { selfTest: true });
  expect(refused.reply).toContain("没有执行");
  expect((await store.readTaskDb({ readOnly: true })).tasks).toHaveLength(1);
  const callsBeforeUndo = requests.length;
  const corrected = await plugin.submitAgentMessage("撤销刚才那个。", [], { selfTest: true });
  expect(requests).toHaveLength(callsBeforeUndo);
  expect(corrected.reply).toContain("已撤销");
  expect(corrected.reply).toContain("虚构整理盒子");
  expect((await store.readTaskDb({ readOnly: true })).tasks).toEqual([]);
});

it("keeps the target of an undo when the requested prior query has not run", async () => {
  const task = await runtime.executeAiToolCall(tool("create_task", { title: "虚构目标任务" }, "targeted-undo-original"), "kimi");
  expect(task.success).toBe(true);
  const plugin = Object.assign(Object.create(Plugin.prototype), { app: store.app, store, settings: store.settings,
    ai: host.aiForRole("main"), lifecycleGeneration: 1, unloaded: false, refreshViews: async () => {} });
  responses.push(
    reply("", [tool("undo_latest_operation", { taskTitle: "虚构目标任务", requirePriorQuery: true }, "targeted-undo")]),
    reply("这次没有执行撤销。")
  );
  const result = await plugin.submitAgentMessage("先查记录再撤销虚构目标任务。", [], { selfTest: true });
  expect(result.reply).toContain("没有执行");
  expect(requests).toHaveLength(2);
  expect((await store.readTaskDb({ readOnly: true })).tasks).toHaveLength(1);
});

describe("voice background AgentLoop", () => {
  it.each(["delete_task", "delete_habit"] as const)("offers %s in the first voice turn and prepares confirmation before writing", async name => {
    const task = await store.createTask({ title: "虚构样品清单" });
    const habit = await store.createHabit({ name: "虚构阅读", frequencyUnit: "day", frequencyInterval: 1, targetCount: 1 });
    const args = name === "delete_task" ? { taskIdOrTitle: task.title } : { name: habit.name };
    const expectedTarget = name === "delete_task" ? { taskIds: [task.id] } : { habitIds: [habit.id] };
    responses.push(reply("", [tool(name, args)]), reply("请先确认。"));

    const result = await new AgentLoop(host).run(input({ source: "voice", message: `删除${name === "delete_task" ? task.title : habit.name}` }));

    expect(catalogs[0]).toContain(name);
    expect(result.toolCalls).toEqual([{ name, ok: true }]);
    expect(result.confirmations).toMatchObject([{ type: name, ...expectedTarget }]);
    expect((await store.readTaskDb({ readOnly: true })).tasks.some(row => row.id === task.id)).toBe(true);
    expect((await store.readHabitDb()).habits.some(row => row.id === habit.id)).toBe(true);
  });

  it("keeps ordinary voice tools compact and gives the model a bounded read excerpt", async () => {
    const execute = vi.spyOn(host, "executeTools").mockImplementation(async (calls, _message, _signal, onResult) => {
      const result = { callId: calls[0].id!, output: "虚构原文。".repeat(700), success: true, actions: [] };
      onResult(calls[0], result);
      return [result];
    });
    responses.push(reply("", [{ id: "voice-read", name: "query_vault",
      arguments: { domain: "journal", operation: "get", maxChars: 15000, limit: 10 } }]), reply("读到了虚构日记。"));
    const result = await new AgentLoop(host).run(input({ source: "voice", message: "看看虚构日记" }));
    expect(result.text).toBe("读到了虚构日记。");
    expect(catalogs[0]).toContain("record_trade");
    expect(catalogs[0]).toContain("learning_progress");
    expect(catalogs[0]).not.toContain("advance_idea");
    expect(execute.mock.calls[0][0][0].arguments).toMatchObject({ maxChars: 900, limit: 3 });
    expect(requests[1].at(-1)?.content).toContain("只显示已查结果的前部");
    expect(Buffer.byteLength(requests[1].at(-1)!.content)).toBeLessThan(1_650);
  });

  it("acknowledges a long job and keeps two fast questions responsive", async () => {
    const { VoiceJobManager } = await import("../src/voice/jobs");
    let finish!: (result: string) => void;
    const manager = new VoiceJobManager(() => new Promise(resolve => { finish = resolve; }), vi.fn());
    const loop = new AgentLoop(host);
    responses.push(reply("", [{ id: "start-job", name: "start_background_job",
      arguments: { title: "虚构交易月报", question: "复盘虚构交易", scope: "十月" } }]));
    const voice = (message: string) => loop.run(input({ source: "voice", message, voiceJobs: manager }));
    expect((await voice("复盘十月的虚构交易")).text).toBe("好，我去整理一下，好了告诉你。");
    for (const [question, answer] of [["虚构问题一", "短答一。"], ["虚构问题二", "短答二。"]]) {
      responses.push(reply("", [{ id: "route", name: "choose_voice_job_control", arguments: { intent: "ordinary" } }]), reply(answer));
      expect((await voice(question)).text).toBe(answer);
      expect(manager.list()[0].status).toBe("running");
    }
    expect(roles).toEqual(["fast", "fast", "fast", "fast", "fast"]);
    finish("虚构十月报告。");
    await vi.waitFor(() => expect(manager.list()[0].status).toBe("done"));
    expect(manager.takeAnnouncement()?.result).toBe("虚构十月报告。");
  });

  it("preserves the user's relative month when the background dispatcher proposes the wrong year", async () => {
    const { backgroundVoiceQuestion, VoiceJobManager } = await import("../src/voice/jobs");
    const original = "总结上个月的虚构任务完成情况。";
    const rewritten = "总结 2025 年 10 月的任务完成情况。";
    const runBackground = vi.fn(async request => backgroundVoiceQuestion(request));
    const manager = new VoiceJobManager(runBackground, vi.fn());
    responses.push(reply("", [tool("start_background_job", { title: "上月任务完成情况", question: rewritten, scope: "2025-10" })]));

    await new AgentLoop(host).run(input({ source: "voice", message: original, voiceJobs: manager }));

    const background = await runBackground.mock.results[0].value;
    expect(background.split("\n")[0]).toBe(original);
    expect(background).toContain("日期和范围以用户原话为准");
    expect(background).toContain(rewritten);
  });

  it("keeps a new background request separate from a fully played earlier result", async () => {
    const { VoiceJobManager } = await import("../src/voice/jobs");
    const manager = new VoiceJobManager(({ title }, signal) => title === "前一份虚构分析"
      ? Promise.resolve("已经播完的虚构分析。")
      : new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })), vi.fn());
    manager.start({ title: "前一份虚构分析", question: "虚构资料", scope: "" });
    await vi.waitFor(() => expect(manager.list()[0].status).toBe("done"));
    manager.settleAnnouncement(manager.takeAnnouncement()!.id, true);
    responses.push(reply("", [tool("replay_job", { target: "latest" })]), reply("", [tool("start_background_job", {
      title: "新的虚构分析", question: "请在后台整理新的虚构资料", scope: "" })]));
    const result = await new AgentLoop(host).run(input({ source: "voice", message: "请在后台整理新的虚构资料", voiceJobs: manager }));
    expect(catalogs[0]).not.toContain("replay_job");
    expect(result.text).toBe("好，我去整理一下，好了告诉你。");
    expect(manager.list().map(job => job.status)).toEqual(["done", "running"]);
    expect(manager.takeAnnouncement()).toBeUndefined();
    manager.stop();
  });

  it.each(["cancel_job", "undo_latest_operation"])("undoes the latest saved task with an unfinished replay and the model intent %s", async intent => {
    const { VoiceJobManager } = await import("../src/voice/jobs");
    const manager = new VoiceJobManager(async () => "可续播的虚构分析。", vi.fn());
    manager.start({ title: "虚构分析", question: "虚构资料", scope: "" });
    await vi.waitFor(() => expect(manager.list()[0].status).toBe("done"));
    manager.settleAnnouncement(manager.takeAnnouncement()!.id, false);
    await runtime.executeAiToolCall(tool("create_task", { title: "纯虚构待撤销标签" }, "voice-undo-after-replay"), "kimi");
    responses.push(reply("", [tool("choose_voice_job_control", { intent, target: intent === "cancel_job" ? "ambiguous" : "latest" })]));
    if (intent === "cancel_job") responses.push(reply("", [tool("undo_latest_operation", {})]));
    responses.push(voiceUndoApproval());

    const result = await new AgentLoop(host).run(input({ source: "voice", message: "撤销。", voiceJobs: manager }));

    expect(result.voiceSpeech).toContain("已撤销创建任务「纯虚构待撤销标签」");
    expect(result.toolCalls).toContainEqual({ name: "undo_latest_operation", ok: true });
    expect((await store.readTaskDb()).tasks).toEqual([]);
    expect(manager.list()[0]).toMatchObject({ status: "done", announced: false });
  });

  it("cancels ten background jobs through the foreground tool and clarifies multiple matches", async () => {
    const { VoiceJobManager } = await import("../src/voice/jobs");
    const signals: AbortSignal[] = [];
    const manager = new VoiceJobManager((_input, signal) => {
      signals.push(signal);
      return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    }, vi.fn());
    const loop = new AgentLoop(host);
    const cancel = (target: string) => {
      responses.push(reply("", [{ id: "cancel-job", name: "choose_voice_job_control", arguments: { intent: "cancel_job", target } }]));
      return loop.run(input({ source: "voice", message: "上面那个不用了", voiceJobs: manager }));
    };
    manager.start({ title: "虚构交易", question: "虚构", scope: "" });
    manager.start({ title: "虚构学习", question: "虚构", scope: "" });
    manager.start({ title: "虚构阅读", question: "虚构", scope: "" });
    expect(manager.start({ title: "超限", question: "虚构", scope: "" })).toContain("三个");
    expect((await cancel("ambiguous")).text).toContain("虚构交易、虚构学习、虚构阅读");
    expect(signals.every(signal => !signal.aborted)).toBe(true);
    expect((await cancel(manager.list()[1].id)).text).toContain("已经取消");
    expect(signals.map(signal => signal.aborted)).toEqual([false, true, false]);
    expect((await cancel("latest")).text).toContain("虚构阅读");
    expect((await cancel(manager.list()[0].id)).text).toContain("虚构交易");
    for (let index = 0; index < 7; index++) {
      manager.start({ title: `虚构任务${index}`, question: "虚构", scope: "" });
      expect((await cancel("ambiguous")).text).toContain(`已经取消「虚构任务${index}」`);
    }
    expect(signals).toHaveLength(10);
    expect(signals.every(signal => signal.aborted)).toBe(true);
    expect(manager.list().every(job => job.status === "cancelled")).toBe(true);
  });

  it("uses the deep model and blocks an unoffered write from a background job", async () => {
    responses.push(reply("", [{ id: "write", name: "create_task", arguments: { title: "虚构后台越权" } }]),
      reply("仅提供虚构分析。"), reply("这是深度整理后的虚构分析。"));
    const execute = vi.spyOn(host, "executeTools");
    const result = await new AgentLoop(host).run(input({ source: "voice", message: "复盘虚构交易", voiceBackground: true }));
    expect(roles).toEqual(["deep", "deep", "deep"]);
    expect(catalogs[0]).toContain("get_stats");
    expect(catalogs[0]).not.toContain("create_task");
    expect(catalogs[0]).not.toContain("start_background_job");
    expect(execute).not.toHaveBeenCalled();
    expect(result.receipts).toEqual([]);
    expect(result.text).toBe("这是深度整理后的虚构分析。");
    expect(requests[2].map(message => message.role)).toEqual(["system", "user"]);
    expect(requests[2][1].content).toContain("后台任务只允许查询资料");
  });

  it.each([false, true])("keeps the full report while preparing separate speech when the summary fails: %s", async fails => {
    const detail = "# 上月任务\n\n| 周起始日 | 完成数 |\n| --- | --- |\n| 10月12日 | 4 |\n\n后半月完成数增加。建议先补逾期事项。";
    const spoken = "后半月完成得更多。接下来可以先补逾期事项。";
    responses.push(reply("初步答复。"), reply(detail), fails ? new Error("虚构播报模型不可用") : reply(spoken));

    const result = await new AgentLoop(host).run(input({ source: "voice", message: "总结上个月的虚构任务", voiceBackground: true }));

    expect(result.text).toBe(detail);
    expect(result.voiceSpeech).toBe(fails ? "详细内容已经放到面板里了。" : spoken);
    expect(roles).toEqual(["deep", "deep", "fast"]);
    expect(catalogs[2]).toEqual([]);
    expect(requests[2].slice(1)).toEqual([{ role: "user", content: detail }]);
  });

  it.each([
    { name: "same number and unit", spoken: "上周完成三项。", accepted: true },
    { name: "same signed amount", spoken: "上周净收益是负三美元。", accepted: true },
    { name: "same percentage expressed approximately", spoken: "上周完成率是六成左右。", accepted: true },
    { name: "unreported number", spoken: "上周完成四项。", accepted: false },
    { name: "same digits but wrong sign", spoken: "上周净收益是三美元。", accepted: false },
    { name: "same digits but wrong currency", spoken: "上周净收益是负三元人民币。", accepted: false },
    { name: "same digits but wrong period", spoken: "本周完成三项。", accepted: false },
    { name: "amount from a different statement", spoken: "上周完成十项。", accepted: false },
    { name: "transaction count mistaken for amount", spoken: "本周净收益是三美元。", accepted: false },
    { name: "rounded percentage with matching scope", spoken: "本周完成率是约67%。", accepted: true },
    { name: "exact half rounds up", spoken: "本周计划达成率是约68%。", accepted: true },
    { name: "incorrect integer rounding", spoken: "本周完成率是约68%。", accepted: false },
    { name: "invented percentage", spoken: "本周完成率是90%。", accepted: false },
    { name: "rounded percentage still contains a decimal", spoken: "本周完成率是约67.4%。", accepted: false }
  ])("checks numbers in the actual background report speech ($name)", async ({ spoken, accepted }) => {
    const detail = "# 上周回顾\n\n| 项目 | 数量 |\n| --- | --- |\n| 待办计划 | 10 |\n\n上周计划10项。上周完成3项。上周完成率是60%。上周净收益是-3美元。"
      + "本周完成率是67.42%。本周计划达成率是67.5%。本周记录3笔交易。本周净收益是10美元。";
    responses.push(reply("初步答复。"), reply(detail), reply(spoken));

    const result = await new AgentLoop(host).run(input({ source: "voice", message: "总结虚构周报", voiceBackground: true }));

    expect(result.text).toBe(detail);
    expect(result.voiceSpeech).toBe(accepted ? spoken : "详细内容已经放到面板里了。");
  });

  const taskSpeechReports = [
    { id: "monthly-overdue", detail: "| 周起始日 | 计划数 | 完成数 | 完成率 |\n| --- | ---: | ---: | ---: |\n"
      + "| 2026-10-12 | 10 | 8 | 80% |\n| 2026-10-19 | 10 | 6 | 60% |\n| **整月合计** | 20 | 14 | 70% |\n\n整月另有 **1 项逾期**。",
      facts: ["完成了 14 项任务", "百分之 70", "后段的完成比例有所下降", "1 项任务逾期"],
      spoken: "先处理已经逾期的事，把难的拆小了再做。", fallback: "接下来可以先把逾期的事拆成小步来做。" },
    { id: "weekly-rounding", detail: "# 虚构任务周报\n| 日期 | 计划任务数 | 完成任务数 | 计划完成率 | 逾期 |\n| --- | --- | --- | --- | --- |\n"
      + "| 2026-11-02 | 2 | 1 | 50% | 0 |\n| 2026-11-06 | 1 | 1 | 100% | 0 |\n| 全周汇总 | 3 | 2 | 66.67% | 0 |",
      facts: ["完成了 2 项任务", "大约是百分之 67", "后段的完成比例有所提高"],
      spoken: "先捡起没做完的事，再看看后面怎么排。", fallback: "接下来先看看没做完的事，再调整安排。" },
    { id: "scoped-month", detail: "## 虚构月度任务完成情况\n| 周起始日（周一） | 计划数 | 完成数 | 完成率 |\n|---|---:|---:|---:|\n"
      + "| 2026-10-05 | — | — | — |\n| 2026-10-12 | 7 | 5 | 71.43% |\n| 2026-10-19 | 39 | 26 | 66.67% |\n| 2026-10-26 | 43 | 29 | 67.44% |\n"
      + "| **合计（有数据范围 10/12–10/31）** | **89** | **60** | **67.42%** |\n\n全月另有 1 项逾期。",
      facts: ["按已有记录，完成了 60 项任务", "大约是百分之 67"],
      spoken: "接下来先把没覆盖到的记录核对一下。", fallback: "接下来先核对这份报告没有覆盖到的记录。", omitted: "1 项任务逾期" },
    { id: "unplanned", detail: "### 虚构任务统计\n| 周期 | 计划 | 已完成 | 完成率 |\n| --- | --- | --- | --- |\n| 本期合计 | 0 | 5 | — |",
      facts: ["完成了 5 项任务", "没有预先排计划"],
      spoken: "可以沿用这个节奏，看看什么做法更管用。", fallback: "接下来可以沿用这个节奏，再看看哪些做法最管用。" }
  ];
  it.each(taskSpeechReports.flatMap(report => ["natural", "invented", "unavailable"].map(mode => ({ ...report, mode }))))
    ("keeps the panel report unchanged and speaks checked key points ($id, $mode)", async report => {
      const suggestion = report.mode === "natural" ? reply(report.spoken)
        : report.mode === "invented" ? reply("把剩下 999 项排进计划。") : new Error("虚构口语模型不可用");
      responses.push(reply("初步答复。"), reply(report.detail), suggestion);

      const result = await new AgentLoop(host).run(input({ source: "voice", message: "总结虚构任务完成情况", voiceBackground: true }));

      expect(result.text).toBe(report.detail);
      for (const fact of report.facts) expect(result.voiceSpeech).toContain(fact);
      expect(result.voiceSpeech).toContain(report.mode === "natural" ? report.spoken : report.fallback);
      expect(result.voiceSpeech).not.toMatch(/\||999|看面板|2026-/u);
      if (report.omitted) expect(result.voiceSpeech).not.toContain(report.omitted);
      expect(voiceJobSpeech(result.text, result.voiceSpeech)).toBe(result.voiceSpeech);
      expect(roles).toEqual(["deep", "deep", "fast"]);
      expect(requests[2][1].content).toBe(report.fallback);
    });

  it("keeps all concurrent conversation events on a fresh day", async () => {
    const date = "2025-05-09";
    const events = ["虚构任务开始", "短问答一", "短问答二", "虚构任务结束"];
    await Promise.all(events.map(text => store.appendAgentConversation(text, "虚构答复", date)));
    const file = await store.app.vault.adapter.read(store.path(store.settings.folders.aiReports, "Conversations", `${date}.md`));
    expect(events.map(text => file.indexOf(text))).toEqual([...events.map(text => file.indexOf(text))].sort((a, b) => a - b));
    for (const event of events) expect(file).toContain(event);
  });
});

it("answers a standalone text greeting without reading records or calling the model", async () => {
  const readDashboard = vi.spyOn(store, "getTaskDashboard");
  const result = await new AgentLoop(host).run(input({ message: "下午好！" }));
  expect(result.text).toBe("下午好！");
  expect(result.toolCalls).toEqual([]);
  expect(result.usage.model).toBe("local");
  expect(readDashboard).not.toHaveBeenCalled();
  expect(requests).toEqual([]);
});

it("still handles a task question that begins with a greeting", async () => {
  responses.push(reply("我会先核对今天的任务。"));
  const result = await new AgentLoop(host).run(input({ message: "你好，今天先做什么？" }));
  expect(result.text).toBe("我会先核对今天的任务。");
  expect(requests).toHaveLength(1);
});

it("recalls an explicitly saved recurring appointment without relying on a newly generated answer", async () => {
  const loop = new AgentLoop(host);
  responses.push(reply("", [tool("append_memory_note", { content: "我周五晚上固定整理虚构读书卡。", fileName: "个人画像.md", explicit: true })]));
  const remembered = await loop.run(input({ message: "记住我周五晚上固定整理虚构读书卡。" }));
  expect(remembered.toolCalls).toContainEqual({ name: "append_memory_note", ok: true });
  const beforeRecall = requests.length;
  expect((await loop.run(input({ message: "我星期五晚上有哪些安排？" }))).text).toBe("已确认的固定安排：我周五晚上固定整理虚构读书卡。");
  expect(requests).toHaveLength(beforeRecall);
  responses.push(reply("我需要查当日的虚构待办。"));
  expect((await loop.run(input({ message: "我下周五晚上有哪些安排？" }))).text).toBe("我需要查当日的虚构待办。");
  expect(requests).toHaveLength(beforeRecall + 1);
});

it("records a literal running distance only for the configured manual habit with its exact name", async () => {
  const date = formatDate(now);
  const manual = await store.createHabit({ name: "跑步", frequencyUnit: "day", frequencyInterval: 1, targetCount: 1, startDate: date });
  const other = await store.createHabit({ name: "虚构跑步训练", frequencyUnit: "day", frequencyInterval: 1, targetCount: 1 });
  const loop = new AgentLoop(host);
  const result = await loop.run(input({ message: "我刚跑完 5 公里。" }));
  expect(result.receipts).toHaveLength(1);
  expect((await store.readHabitDb()).checkins).toMatchObject([{ habitId: manual.id, date, value: 5, count: 1 }]);
  expect(requests).toHaveLength(0);
  await store.deleteHabit(manual.id);
  responses.push(reply("请明确要打卡的虚构习惯。"));
  expect((await loop.run(input({ message: "我刚跑完 5 公里。" }))).text).toContain("明确");
  expect(requests).toHaveLength(1);
  expect((await store.readHabitDb()).checkins.some(item => item.habitId === other.id)).toBe(false);
});

it("uses an explicit timed reminder locally and preserves its named person in the voice receipt", async () => {
  const loop = new AgentLoop(host);
  const title = "虚构人名叶宁给纸盒贴标签";
  const result = await loop.run(input({ source: "voice", message: `明天下午3:15提醒${title}。` }));
  expect(result.receipts).toHaveLength(1);
  expect(result.voiceSpeech).toContain(title);
  expect(result.voiceSpeech).toContain("15:15");
  expect((await store.readTaskDb()).tasks).toMatchObject([{ title, date: addDays(formatDate(now), 1), time: "15:15" }]);
  expect(requests).toHaveLength(0);
  responses.push(reply("这是复合的虚构提醒。"));
  expect((await loop.run(input({ source: "voice", message: "明天下午三点提醒叶宁下午四点检查纸盒。" }))).text)
    .toBe("这是复合的虚构提醒。");
});

it("locally creates an explicitly requested single timed task and keeps conditional requests on the normal path", async () => {
  const loop = new AgentLoop(host);
  const saved = await loop.run(input({ message: "帮我建明天下午三点整理虚构图册的任务。" }));
  expect(saved.toolCalls).toEqual([{ name: "create_task", ok: true }]);
  expect(saved.receipts).toHaveLength(1);
  expect((await store.readTaskDb()).tasks).toMatchObject([{ title: "整理虚构图册", date: "2026-11-13", time: "15:00" }]);
  expect(requests).toHaveLength(0);
  responses.push(reply("请核对前提。"));
  expect((await loop.run(input({ message: "帮我建明天下午三点见面，然后去取件的任务。" }))).text).toBe("请核对前提。");
  expect(requests).toHaveLength(1);
  expect((await store.readTaskDb()).tasks).toHaveLength(1);
});

it("blocks a model-proposed undo for a named voice deletion", async () => {
  const original = await runtime.executeAiToolCall(tool("upsert_idea", { title: "虚构蓝色图册想法", description: "核对虚构目录" }), "kimi");
  expect(original.success).toBe(true);
  responses.push(reply("", [tool("undo_latest_operation", {})]), reply("请核对要删除的想法。"));
  const loop = new AgentLoop(host);
  const result = await loop.run(input({ source: "voice", message: "删除虚构蓝色图册想法。" }));
  expect(result.toolCalls).toContainEqual({ name: "undo_latest_operation", ok: false });
  expect((await new OperationLedger(store).readSettledOperations([original.callId])).verified.has(original.callId)).toBe(true);
});

it("answers standalone greetings and device date questions by voice without checking background jobs or loading personal records", async () => {
  const { VoiceJobManager } = await import("../src/voice/jobs");
  const jobs = new VoiceJobManager((_task, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }), vi.fn());
  jobs.start({ title: "虚构后台计划", question: "三条虚构计划", scope: "" });
  const readDashboard = vi.spyOn(store, "getTaskDashboard");
  const onVoiceText = vi.fn();
  const loop = new AgentLoop(host);
  const source = "voice" as const;
  try {
    expect(await loop.run(input({ source, message: "你好，简短回答一句。", voiceJobs: jobs, onVoiceText })))
      .toMatchObject({ text: "你好！", usage: { model: "local" } });
    expect(await loop.run(input({ source, message: "今天是几号？只说日期。", voiceJobs: jobs, onVoiceText,
      now: new Date(2027, 0, 1, 0, 2) }))).toMatchObject({ text: "2027年1月1日。", usage: { model: "local" } });
    expect(onVoiceText.mock.calls).toEqual([["你好！"], ["2027年1月1日。"]]);
    expect(jobs.list()[0].status).toBe("running");
    expect(readDashboard).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
  } finally { jobs.stop(); }
});

it("answers the device date with the text model disabled and preserves multi-part questions", async () => {
  host.settings.ai.provider = "off";
  const loop = new AgentLoop(host);
  expect((await loop.run(input({ message: "请问，今天几号？", now: new Date(2026, 11, 31, 23, 59) }))).text).toBe("2026年12月31日。");
  expect(requests).toEqual([]);
  host.settings.ai.provider = "custom";
  responses.push(reply("先核对日期和虚构任务。"));
  expect((await loop.run(input({ message: "今天是几号？还有哪些虚构任务？", source: "voice" }))).text).toBe("先核对日期和虚构任务。");
  expect(requests).toHaveLength(1);
});

describe("phone inbox", () => {
  const phoneDate = "2026-01-09";

  it("runs five offline-captured lines once, preserves raw input, and supports approval and targeted undo", async () => {
    const { PhoneInbox, summarizePhoneInbox } = await import("../src/features/phoneInbox/service");
    const { PHONE_INBOX_PATH } = await import("../src/features/phoneInbox/model");
    const { LifeOpsEventBus } = await import("../src/lifeOpsEventBus");
    const staleTask = await runtime.executeAiToolCall(tool("create_task", { title: "撤掉旧样品" }, "inbox-stale"), "kimi");
    expect(staleTask.success).toBe(true);
    await store.createHabit({ name: "跑步", frequencyUnit: "day", frequencyInterval: 1, targetCount: 1, target: { kind: "number", perDay: 5, unit: "公里" },
      startDate: phoneDate, penaltyThreshold: 3, color: "#27ae60" });
    const notes = [
      "明天下午三点带样品", "今天跑了 5 公里", "想法：做一张园艺地图",
      "今天很平静，想记进日记  ", "请删除撤掉旧样品这个任务"
    ];
    const original = "# 手机随手记\n\n" + notes.map(line => `[${phoneDate} 16:20] ${line}`).join("\n") + "\n";
    await store.ensureFile(PHONE_INBOX_PATH, original);
    const notifications: string[] = [];
    const events = new LifeOpsEventBus();
    const options = {
      store: () => store, enabled: () => true,
      submit: async (text: string, phoneInbox: NonNullable<AgentTurnInput["phoneInbox"]>, signal: AbortSignal) => {
        const result = await new AgentLoop(host).run(input({ message: text, source: "system", phoneInbox, signal }));
        return { reply: result.text, receipts: result.receipts, actions: result.confirmations, toolCalls: result.toolCalls };
      },
      confirm: async (action: Parameters<typeof runConfirmedToolAction>[0], turn: NonNullable<AgentTurnInput["phoneInbox"]>) => {
        await runConfirmedToolAction(action, { store, refreshViews: async () => {}, assertCurrent: turn.assertCurrent }, turn.assertLineCurrent);
      },
      undo: (id: string) => runtime.undoOperation(id),
      notify: (message: string) => { notifications.push(message); }
    };
    responses.push(
      reply("", [tool("create_task", { title: "带样品", date: "明天", time: "15:00" })]),
      reply("", [tool("complete_habit", { name: "跑步", value: 5, unit: "公里" })]),
      reply("", [tool("upsert_idea", { title: "园艺地图", description: "做一张园艺地图" })]),
      reply("", [tool("append_journal_entry", { content: "今天感觉平静。", period: "晚" })]),
      reply("", [tool("delete_task", { taskIdOrTitle: "撤掉旧样品" })])
    );
    const inbox = new PhoneInbox(options, events);
    try {
      await Promise.all([inbox.scan(), inbox.scan()]);
      const rows = await inbox.list();
      expect(rows.map(row => row.status)).toEqual(["confirm", "saved", "saved", "saved", "saved"]);
      expect(rows[3].message).toContain(phoneDate);
      expect(notifications).toEqual([expect.stringContaining("手机随手记已处理 5 条")]);
      expect(requests).toHaveLength(5);
      expect(catalogs.every(tools => !tools.includes("query_vault") && !tools.includes("undo_latest_operation"))).toBe(true);
      expect(store.isManagedSourcePath(PHONE_INBOX_PATH)).toBe(false);
      expect(requests[3].at(-1)?.content).toBe(notes[3]);
      expect(await store.readPath(store.dailyNotePath(phoneDate, "晚"))).toContain(notes[3]);
      expect((await store.readHabitDb()).checkins).toContainEqual(expect.objectContaining({ date: phoneDate, value: 5 }));
      expect((await store.readTaskDb()).tasks).toContainEqual(expect.objectContaining({ title: "带样品", date: "2026-01-10", time: "15:00" }));
      expect((await store.readTaskDb()).tasks.map(task => task.title)).toContain("撤掉旧样品");
      inbox.stop();
      const reopened = new PhoneInbox(options, events);
      try {
        await reopened.scan();
        expect(requests).toHaveLength(5);
        await reopened.resolve(rows[0].id, "confirm");
        expect((await store.readTaskDb()).tasks.map(task => task.title)).not.toContain("撤掉旧样品");
        await reopened.resolve(rows[0].id, "undo");
        expect(rows[4].operationId).toBeDefined();
        await runtime.undoOperation(rows[4].operationId!);
        expect((await reopened.list()).find(row => row.id === rows[4].id)?.undone).toBe(true);
        expect(summarizePhoneInbox(await reopened.list())).toContain("已撤销 2 条");
        expect((await store.readTaskDb()).tasks.map(task => task.title)).toEqual(["撤掉旧样品"]);
        expect(await store.readPath(PHONE_INBOX_PATH)).toBe(original);
      } finally { reopened.stop(); }
    } finally { inbox.stop(); }
  });

  it("blocks changes to permissions, rejects out-of-scope tool requests, and declines multiple writes on one line", async () => {
    const turn = { date: phoneDate, assertCurrent: () => {}, assertLineCurrent: vi.fn(async () => {}) };
    const request = input({ message: "纯虚构手机记录", phoneInbox: turn, source: "system" });
    responses.push(reply("", [tool("delete_habit", { name: "甲" }), tool("delete_task", { taskIdOrTitle: "乙" }, "second")]));
    expect((await new AgentLoop(host).run(request)).receipts).toEqual([]);
    responses.push(reply("", [tool("undo_latest_operation", {})]));
    await expect(new AgentLoop(host).run(request)).rejects.toThrow("需要在对话中处理");
    responses.push(reply("", [tool("create_task", { title: "纸船" })]));
    turn.assertLineCurrent.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("编辑冲突"));
    await expect(new AgentLoop(host).run(request)).rejects.toThrow("编辑冲突");
    expect((await store.readTaskDb()).tasks).toEqual([]);
  });

  it("places an invalid timestamp or empty stamped line in review without sending it", async () => {
    const { PhoneInbox } = await import("../src/features/phoneInbox/service");
    const { PHONE_INBOX_PATH } = await import("../src/features/phoneInbox/model");
    const { LifeOpsEventBus } = await import("../src/lifeOpsEventBus");
    const submit = vi.fn(async () => ({ reply: "请核对。", actions: [] }));
    const inbox = new PhoneInbox({ store: () => store, enabled: () => true, submit,
      confirm: async () => {}, undo: async () => true, notify: () => {} }, new LifeOpsEventBus());
    try {
      const notes = ["[2026-01-09 25:30] 明天取件", "[2026-02-30 12:00] 明天取餐", "[2026-01-09 15:00]",
        "[2026-01-09 9:00] 明天交虚构色卡", "[2026-01-09 09:00 明天交虚构草图", "[2026-1-9] 明天画虚构地图",
        "［２０２６－０１－０９ ０９：００］明天买虚构便签", ""].join("\n");
      const cleanLine = "虚构排队记录仍需文字模型\n";
      const ai = store.settings.ai;
      store.settings.ai = { ...ai, provider: "off" };
      await store.ensureFile(PHONE_INBOX_PATH, notes + cleanLine);
      await inbox.scan();
      expect(submit).not.toHaveBeenCalled();
      expect((await inbox.list()).map(row => [row.status, row.message])).toEqual([
        ...Array.from({ length: 4 }, () => ["review", expect.stringContaining("核对日期和时间")]),
        ["review", "这一行没有记录内容。"],
        ["review", expect.stringContaining("核对日期和时间")],
        ["review", expect.stringContaining("核对日期和时间")]
      ]);
      expect(await store.readPath(PHONE_INBOX_PATH)).toBe(notes + cleanLine);
      store.settings.ai = ai;
      await inbox.scan();
      expect(submit).toHaveBeenCalledExactlyOnceWith(cleanLine.trim(), expect.anything(), expect.any(AbortSignal));
    } finally { inbox.stop(); }
  });
});

it("uses the requested relative dates for habit creation and writes date-correct receipts", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  const name = "虚构剪纸";
  const create = await runtime.executeAiToolCall(tool("create_habit", { name, startDate: "本周一" }, "habit-date-create"), "kimi");
  expect(create.success).toBe(true);
  expect(create.output).toContain("2026-11-09 开始");
  const done = await runtime.executeAiToolCall(tool("complete_habit", { name, date: "大前天" }, "habit-date-done"), "kimi");
  const missed = await runtime.executeAiToolCall(tool("miss_habit", { name, date: "本周二" }, "habit-date-missed"), "kimi");
  expect(done.output).toContain("已完成2026-11-09打卡");
  expect(missed.output).toContain("已记录2026-11-10未完成");
  const invalid = await runtime.executeAiToolCall(tool("complete_habit", { name, date: "2月30日" }, "habit-date-invalid"), "kimi");
  expect(invalid.success).toBe(false);
  const records = await store.readHabitDb();
  expect(records.habits[0]).toMatchObject({ name, startDate: "2026-11-09" });
  expect(records.checkins).toMatchObject([{ date: "2026-11-09", status: "done" }, { date: "2026-11-10", status: "missed" }]);
});

it("waits for a complete phone inbox line while mobile sync updates an unfinished draft", async () => {
  const { PhoneInbox } = await import("../src/features/phoneInbox/service");
  const { PHONE_INBOX_PATH } = await import("../src/features/phoneInbox/model");
  const { LifeOpsEventBus } = await import("../src/lifeOpsEventBus");
  const saved = vi.fn(async (_text: string) => ({ reply: "请核对。", actions: [] }));
  const events = new LifeOpsEventBus();
  const inbox = new PhoneInbox({ store: () => store, enabled: () => true, submit: saved,
    confirm: async () => {}, undo: async () => true, notify: () => {} }, events);
  try {
    const note = await store.ensureFile(PHONE_INBOX_PATH, "# 手机随手记\n明天去");
    await inbox.scan();
    expect(saved).not.toHaveBeenCalled();
    await store.app.vault.modify(note, "# 手机随手记\n明天去拿蓝纸\n另一个未完");
    await inbox.scan();
    expect(saved.mock.calls.map(args => args[0])).toEqual(["明天去拿蓝纸"]);
    await inbox.scan(true);
    expect(saved.mock.calls.map(args => args[0])).toEqual(["明天去拿蓝纸", "另一个未完"]);
    await store.app.vault.modify(note, "# 手机随手记\n明天去拿蓝纸\n另一个未完\n");
    await inbox.scan();
    expect(saved).toHaveBeenCalledTimes(2);
    expect((await inbox.list()).map(row => row.line)).toEqual([3, 2]);
    await store.app.vault.modify(note, "# 手机随手记\n\n明天去拿蓝纸\n另一条已经改过\n");
    const [changed, moved] = await inbox.list();
    expect(changed.sourceUnavailable).toBe(true);
    expect(moved).toMatchObject({ line: 3 });
    expect(moved.sourceUnavailable).toBeUndefined();
    expect(saved).toHaveBeenCalledTimes(2);
  } finally { inbox.stop(); }
});

it("does not replay permission to process the last phone line after a blocked manual check", async () => {
  const { PhoneInbox } = await import("../src/features/phoneInbox/service");
  const { PHONE_INBOX_PATH } = await import("../src/features/phoneInbox/model");
  const { LifeOpsEventBus } = await import("../src/lifeOpsEventBus");
  const submit = vi.fn(async (_text: string) => ({ reply: "已核对。", actions: [] }));
  const inbox = new PhoneInbox({ store: () => store, enabled: () => true, submit,
    confirm: async () => {}, undo: async () => true, notify: () => {} }, new LifeOpsEventBus());
  const schedule = vi.spyOn(inbox, "schedule").mockImplementation(() => {});
  let finish!: () => void, started!: () => void;
  const hold = new Promise<void>(resolve => { finish = resolve; });
  const ready = new Promise<void>(resolve => { started = resolve; });
  try {
    await store.ensureFile(PHONE_INBOX_PATH, "已经写完\n还在修改");
    const writing = runtime.executeLocalOperation("synthetic_concurrent_save", {}, async scope => {
      await scope.writeFile(scope.path(scope.settings.folders.ideas, "synthetic-concurrent-save.md"), "虚构保存");
      started();
      await hold;
    });
    await ready;
    try {
      await expect(inbox.scan(true)).rejects.toThrow("请稍后再检查末行");
      expect(schedule).toHaveBeenCalledExactlyOnceWith(10_000);
      expect(submit).not.toHaveBeenCalled();
    } finally { finish(); await writing; }
    await inbox.scan();
    expect(submit.mock.calls.map(args => args[0])).toEqual(["已经写完"]);
    await inbox.scan(true);
    expect(submit.mock.calls.map(args => args[0])).toEqual(["已经写完", "还在修改"]);
  } finally { inbox.stop(); }
});

it("rejects a synced phone row when its final newline is removed during processing", async () => {
  const { PhoneInbox } = await import("../src/features/phoneInbox/service");
  const { PHONE_INBOX_PATH } = await import("../src/features/phoneInbox/model");
  const { LifeOpsEventBus } = await import("../src/lifeOpsEventBus");
  const original = "虚构记录写完\n";
  const note = await store.ensureFile(PHONE_INBOX_PATH, original);
  const write = vi.fn();
  const inbox = new PhoneInbox({
    store: () => store, enabled: () => true, confirm: async () => {}, undo: async () => true, notify: () => {},
    submit: async (_text, turn) => {
      await turn.assertLineCurrent();
      await store.app.vault.modify(note, original.trimEnd());
      await turn.assertLineCurrent();
      write();
      return { reply: "已保存。", actions: [] };
    }
  }, new LifeOpsEventBus());
  try {
    await inbox.scan();
    expect(write).not.toHaveBeenCalled();
    expect((await inbox.list())[0].status).toBe("review");
    expect(await store.readPath(PHONE_INBOX_PATH)).toBe(original.trimEnd());
  } finally { inbox.stop(); }
});

it("leaves later phone rows unclaimed if a guarded save starts during a batch", async () => {
  const { PhoneInbox } = await import("../src/features/phoneInbox/service");
  const { PHONE_INBOX_PATH } = await import("../src/features/phoneInbox/model");
  const { LifeOpsEventBus } = await import("../src/lifeOpsEventBus");
  let finish!: () => void, started!: () => void;
  const hold = new Promise<void>(resolve => { finish = resolve; });
  const ready = new Promise<void>(resolve => { started = resolve; });
  let writing: Promise<unknown> | undefined;
  const submit = vi.fn(async (text: string) => {
    if (text === "虚构第一行") {
      writing = runtime.executeLocalOperation("synthetic_phone_batch_save", {}, async scoped => {
        await scoped.writeFile(store.path(store.settings.folders.ideas, "synthetic-batch.md"), "纯虚构");
        started();
        await hold;
      });
      await ready;
    }
    return { reply: "核对完成。", actions: [] };
  });
  const inbox = new PhoneInbox({ store: () => store, enabled: () => true, submit,
    confirm: async () => undefined, undo: async () => true, notify: () => undefined }, new LifeOpsEventBus());
  const schedule = vi.spyOn(inbox, "schedule").mockImplementation(() => undefined);
  const source = "虚构第一行\n虚构第二行\n";
  try {
    await store.ensureFile(PHONE_INBOX_PATH, source);
    await inbox.scan();
    expect(submit.mock.calls.map(([text]) => text)).toEqual(["虚构第一行"]);
    expect(schedule).toHaveBeenCalledExactlyOnceWith(10_000);
    expect((await inbox.list()).map(row => row.line)).toEqual([1]);
    finish();
    await writing;
    await inbox.scan();
    expect(submit.mock.calls.map(([text]) => text)).toEqual(["虚构第一行", "虚构第二行"]);
    expect((await inbox.list()).map(row => row.line)).toEqual([2, 1]);
    expect(await store.readPath(PHONE_INBOX_PATH)).toBe(source);
  } finally {
    finish();
    await writing;
    inbox.stop();
  }
});

it("submits phone inbox entries without sending Markdown properties, comments or fenced samples", async () => {
  const { PhoneInbox } = await import("../src/features/phoneInbox/service");
  const { PHONE_INBOX_PATH } = await import("../src/features/phoneInbox/model");
  const { LifeOpsEventBus } = await import("../src/lifeOpsEventBus");
  const submit = vi.fn(async (_text: string) => ({ reply: "请核对。", actions: [] }));
  const inbox = new PhoneInbox({ store: () => store, enabled: () => true, submit,
    confirm: async () => {}, undo: async () => true, notify: () => {} }, new LifeOpsEventBus());
  const original = [
    "\uFEFF---", "project: 虚构属性", "---", "# 手机随手记", "<!--", "虚构模板备注", "-->",
    "%% 行内备注 %%", "%%", "虚构隐藏块", "%%", "~~~text", "虚构示例", "~~~", "[2026-01-09 15:00] 明天取样", ""
  ].join("\r\n");
  try {
    await store.ensureFile(PHONE_INBOX_PATH, original);
    await inbox.scan();
    expect(submit.mock.calls.map(([text]) => text)).toEqual(["明天取样"]);
    expect((await inbox.list()).map(row => row.line)).toEqual([15]);
    expect(await store.readPath(PHONE_INBOX_PATH)).toBe(original);
  } finally { inbox.stop(); }
});

it("recovers a committed phone write whose receipt was interrupted without sending the line again", async () => {
  const { PhoneInbox } = await import("../src/features/phoneInbox/service");
  const { PHONE_INBOX_PATH, PHONE_INBOX_STATE } = await import("../src/features/phoneInbox/model");
  const { LifeOpsEventBus } = await import("../src/lifeOpsEventBus");
  const submit = vi.fn(async (text: string, phoneInbox: NonNullable<AgentTurnInput["phoneInbox"]>, signal: AbortSignal) => {
    const result = await new AgentLoop(host).run(input({ message: text, source: "system", phoneInbox, signal }));
    expect(result.receipts).toMatchObject([{ operationId: phoneInbox.operationId }]);
    return { reply: result.text, receipts: result.receipts, actions: result.confirmations, toolCalls: result.toolCalls };
  });
  const options = { store: () => store, enabled: () => true, submit, confirm: async () => {},
    undo: (id: string) => runtime.undoOperation(id), notify: () => {} };
  const inbox = new PhoneInbox(options, new LifeOpsEventBus());
  const writeJson = store.writeJson.bind(store);
  const put = vi.spyOn(store, "writeJson").mockImplementation(async (path, value, opts) => {
    if (path.endsWith(PHONE_INBOX_STATE) && (value as { records?: Array<{ status: string }> }).records?.[0]?.status === "saved") {
      throw Error("虚构回执写入中断");
    }
    await writeJson(path, value, opts);
  });
  try {
    await store.ensureFile(PHONE_INBOX_PATH, "新增虚构色卡任务\n");
    responses.push(reply("", [tool("create_task", { title: "虚构色卡任务" })]));
    await expect(inbox.scan()).rejects.toThrow("虚构回执写入中断");
    const [originalTask] = (await store.readTaskDb()).tasks;
    expect(originalTask?.title).toBe("虚构色卡任务");
    put.mockRestore();
    inbox.stop();
    const reopened = new PhoneInbox(options, new LifeOpsEventBus());
    try {
      await reopened.scan();
      const [row] = await reopened.list();
      expect(row).toMatchObject({ status: "saved", tool: "create_task" });
      expect(row.pendingOperationId).toBeUndefined();
      expect(submit).toHaveBeenCalledTimes(1);
      await reopened.resolve(row.id, "undo");
      expect((await store.readTaskDb()).tasks).toEqual([]);
      expect((await reopened.list())[0].undone).toBe(true);
    } finally { reopened.stop(); }
  } finally { put.mockRestore(); inbox.stop(); }
});

it("keeps phone lines containing credentials local while processing clean lines", async () => {
  const { PhoneInbox } = await import("../src/features/phoneInbox/service");
  const { PHONE_INBOX_PATH, PHONE_INBOX_STATE } = await import("../src/features/phoneInbox/model");
  const { LifeOpsEventBus } = await import("../src/lifeOpsEventBus");
  const submit = vi.fn(async (_text: string) => ({ reply: "请核对。", actions: [] }));
  const inbox = new PhoneInbox({ store: () => store, enabled: () => true, submit,
    confirm: async () => {}, undo: async () => true, notify: () => {} }, new LifeOpsEventBus());
  const oldKey = store.settings.ai.apiKey;
  const credential = "fictional-config-only-123";
  const syntheticToken = ["sk", "fixture", "test", "ABC123456"].join("-");
  store.settings.ai.apiKey = credential;
  const original = [credential, "请记虚构密钥 " + syntheticToken, "虚构样品准备好了", ""].join("\n");
  try {
    await store.ensureFile(PHONE_INBOX_PATH, original);
    await inbox.scan();
    expect(submit.mock.calls.map(([text]) => text)).toEqual(["虚构样品准备好了"]);
    expect((await inbox.list()).slice(1).every(row => row.status === "review" && row.message.includes("疑似含密钥"))).toBe(true);
    expect(await store.readPath(PHONE_INBOX_PATH)).toBe(original);
    const receipt = await store.readPath(store.path(store.settings.folders.aiReports, "System", PHONE_INBOX_STATE));
    expect(receipt).not.toContain(credential);
    expect(receipt).not.toContain(syntheticToken);
  } finally { inbox.stop(); store.settings.ai.apiKey = oldKey; }
});

it("aborts the current phone submission when the inbox is disabled and keeps the input for review", async () => {
  const { PhoneInbox } = await import("../src/features/phoneInbox/service");
  const { PHONE_INBOX_PATH } = await import("../src/features/phoneInbox/model");
  const { LifeOpsEventBus } = await import("../src/lifeOpsEventBus");
  let enabled = true;
  const submit = vi.fn((_text: string, _turn: NonNullable<AgentTurnInput["phoneInbox"]>, signal: AbortSignal) =>
    new Promise<import("../src/types").AgentResponse>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
  const inbox = new PhoneInbox({ store: () => store, enabled: () => enabled, submit,
    confirm: async () => {}, undo: async () => true, notify: () => {} }, new LifeOpsEventBus());
  const note = "明天取虚构样品\n";
  try {
    await store.ensureFile(PHONE_INBOX_PATH, note);
    const running = inbox.scan();
    const observed = expect(running).rejects.toThrow("手机随手记已停止");
    await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce());
    enabled = false;
    inbox.schedule();
    await observed;
    expect(submit.mock.calls[0][2].aborted).toBe(true);
    expect(await store.readPath(PHONE_INBOX_PATH)).toBe(note);
    enabled = true;
    expect((await inbox.list())[0]).toMatchObject({ status: "processing" });
    expect((await store.readTaskDb()).tasks).toEqual([]);
  } finally { inbox.stop(); }
});

it("reads an already confirmed phone action from the ledger after the original line is moved away", async () => {
  const { PhoneInbox } = await import("../src/features/phoneInbox/service");
  const { PHONE_INBOX_PATH, PHONE_INBOX_STATE } = await import("../src/features/phoneInbox/model");
  const { LifeOpsEventBus } = await import("../src/lifeOpsEventBus");
  const setup = await runtime.executeAiToolCall(tool("create_task", { title: "虚构旧色卡" }), "kimi");
  expect(setup.success).toBe(true);
  const confirm = vi.fn(async (action: Parameters<typeof runConfirmedToolAction>[0], turn: NonNullable<AgentTurnInput["phoneInbox"]>) => {
    await runConfirmedToolAction(action, { store, refreshViews: async () => {}, assertCurrent: turn.assertCurrent }, turn.assertLineCurrent);
  });
  const options = {
    store: () => store, enabled: () => true,
    submit: async (text: string, phoneInbox: NonNullable<AgentTurnInput["phoneInbox"]>, signal: AbortSignal) => {
      const result = await new AgentLoop(host).run(input({ message: text, source: "system", phoneInbox, signal }));
      return { reply: result.text, receipts: result.receipts, actions: result.confirmations, toolCalls: result.toolCalls };
    },
    confirm, undo: (id: string) => runtime.undoOperation(id), notify: () => {}
  };
  const inbox = new PhoneInbox(options, new LifeOpsEventBus());
  const writeJson = store.writeJson.bind(store);
  const put = vi.spyOn(store, "writeJson").mockImplementation(async (path, value, opts) => {
    if (path.endsWith(PHONE_INBOX_STATE) && (value as { records?: Array<{ status: string }> }).records?.[0]?.status === "saved") {
      throw Error("虚构确认回执写入中断");
    }
    await writeJson(path, value, opts);
  });
  try {
    const note = await store.ensureFile(PHONE_INBOX_PATH, "删除虚构旧色卡\n");
    responses.push(reply("", [tool("delete_task", { taskIdOrTitle: "虚构旧色卡" })]));
    await inbox.scan();
    const [proposal] = await inbox.list();
    expect(proposal.status).toBe("confirm");
    await expect(inbox.resolve(proposal.id, "confirm")).rejects.toThrow("虚构确认回执写入中断");
    expect((await store.readTaskDb()).tasks).toEqual([]);
    put.mockRestore();
    await store.app.vault.modify(note, "# 已整理\n");
    await inbox.resolve(proposal.id, "confirm");
    const [saved] = await inbox.list();
    expect(saved).toMatchObject({ status: "saved", sourceUnavailable: true });
    expect(confirm).toHaveBeenCalledTimes(1);
    await inbox.resolve(saved.id, "undo");
    expect((await store.readTaskDb()).tasks[0]?.title).toBe("虚构旧色卡");
  } finally { put.mockRestore(); inbox.stop(); }
});
