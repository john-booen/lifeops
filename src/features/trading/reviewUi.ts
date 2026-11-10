import { Modal, Notice, type App, type Plugin } from "obsidian";
import { readTradingDocument } from "../../dataFoundation/tradingPersistence";
import { newLocalOperationId, recordRevision } from "../../operationIdentity";
import type { StoreHost } from "../../store/settingsSlice";
import { prepareTradingAction } from "../../tradingTools";
import type { AgentActionSuggestion } from "../../types";
import type { LocalOperationHost } from "../serviceHost";
import { TRADE_REVIEW_LABELS, TRADE_REVIEW_PERIODS, type TradeReviewPeriod } from "./reviewData";
import { parseTradeReviewAction, TRADE_REVIEW_ACTION, TRADE_REVIEW_MARKER, type TradeReviewAction } from "./reviewReport";

export interface TradeReviewUiHost extends LocalOperationHost, Pick<Plugin, "app" | "register" | "registerMarkdownCodeBlockProcessor"> {
  store: StoreHost;
  unloaded: boolean;
  lifecycleGeneration: number;
  executeAgentAction(action: AgentActionSuggestion): Promise<string>;
}

export function openTradeReviewPicker(app: App, generate: (period: TradeReviewPeriod) => Promise<void>, own: (modal: Modal) => void): void {
  const modal = new Modal(app);
  modal.onOpen = () => {
    modal.contentEl.createEl("h2", { text: "选择交易复盘周期" });
    for (const period of TRADE_REVIEW_PERIODS) actionButton(modal.contentEl, `${TRADE_REVIEW_LABELS[period]}复盘`, async () => {
      modal.close();
      await generate(period);
    });
  };
  own(modal);
  modal.open();
}

function isReviewPath(store: StoreHost, path: string): boolean {
  const prefix = `${store.settings.folders.aiReports}/交易/`;
  return path.startsWith(prefix) && /^(?:\d{4}-\d{2}-\d{2}|周-\d{4}-\d{2}-\d{2}|月-\d{4}-\d{2})\.md$/.test(path.slice(prefix.length));
}

async function assertReviewAction(store: StoreHost, path: string, action: TradeReviewAction): Promise<void> {
  if (!isReviewPath(store, path) || !store.getFile(path)) throw new Error("找不到复盘建议原文。");
  const raw = await store.readPath(path);
  const block = JSON.stringify(action).replace(/\x60/g, "\\u0060");
  if (!raw.startsWith(TRADE_REVIEW_MARKER + "\n") || !raw.includes(`\n\`\`\`${TRADE_REVIEW_ACTION}\n${block}\n\`\`\`\n`)) {
    throw new Error("这条复盘建议已经变化，请重新打开报告。");
  }
}

export async function addTradeReviewTask(host: LocalOperationHost, store: StoreHost, path: string, action: TradeReviewAction): Promise<boolean> {
  const source = `lifeops-trade-review:${recordRevision([path, action])}`;
  let created = false;
  await host.saveLocalOperation("local_trade_review_task", { path, source, title: action.title }, async scope => {
    created = false;
    await assertReviewAction(scope, path, action);
    const { tasks } = await scope.readTaskDb({ readOnly: true });
    if (tasks.some(task => task.source === source && task.status !== "abandoned")) return;
    await scope.createTask({ title: action.title, source, sourceNotePath: path });
    created = true;
  }, { assertBeforeCommit: () => assertReviewAction(store, path, action) });
  await host.refreshViews().catch(() => undefined);
  return created;
}

export async function prepareTradeReviewRuleChange(store: StoreHost, path: string, action: Extract<TradeReviewAction, { kind: "rule" }>,
  assertCurrent: () => void): Promise<AgentActionSuggestion> {
  await assertReviewAction(store, path, action);
  const document = await readTradingDocument(store);
  const latest = document.models.find(model => model.id === action.modelId)?.versions.at(-1);
  if (!latest || latest.id !== action.versionId || !latest.rules?.some(rule => rule.id === action.ruleId)) {
    throw new Error("规则版本已变化，请根据当前版本重新核对。");
  }
  const rules = latest.rules.map(rule => rule.id === action.ruleId ? { ...rule, text: action.revisedText, reviewPath: path } : rule);
  return prepareTradingAction({ kind: "save_model", modelId: action.modelId, input: { rules } }, {
    store, refreshViews: async () => undefined, assertCurrent
  }, newLocalOperationId("trade-review-rule"));
}

async function openTradeRuleReview(host: TradeReviewUiHost, path: string, action: Extract<TradeReviewAction, { kind: "rule" }>): Promise<void> {
  const generation = host.lifecycleGeneration;
  let closed = false;
  const card = await prepareTradeReviewRuleChange(host.store, path, action, () => {
    if (closed || host.unloaded || host.lifecycleGeneration !== generation) throw new Error("核对窗口已关闭，规则未修改。");
  });
  const modal = new Modal(host.app);
  modal.onClose = () => { closed = true; };
  modal.onOpen = () => {
    modal.contentEl.createEl("h2", { text: "核对规则改动" });
    modal.contentEl.createEl("p", { text: action.title });
    for (const paragraph of card.content.split("\n\n")) modal.contentEl.createEl("p", { text: paragraph });
    actionButton(modal.contentEl, "确认保存新版规则", async () => {
      await assertReviewAction(host.store, path, action);
      await host.executeAgentAction(card);
      modal.close();
    }).addClass("mod-cta");
  };
  host.register(() => modal.close());
  modal.open();
}

export function registerTradeReviewActions(host: TradeReviewUiHost): void {
  host.registerMarkdownCodeBlockProcessor?.(TRADE_REVIEW_ACTION, (source, element, context) => {
    if (!isReviewPath(host.store, context.sourcePath)) return;
    let action: TradeReviewAction | undefined;
    try { action = parseTradeReviewAction(JSON.parse(source)); } catch { return; }
    if (!action) return;
    const selected = action, path = context.sourcePath;
    actionButton(element, "转成任务", async () => {
      const added = await addTradeReviewTask(host, host.store, path, selected);
      new Notice(added ? "已添加任务，可在最近操作中撤销。" : "已有这项任务。");
    });
    if (selected.kind === "rule") actionButton(element, "核对规则改动", () => openTradeRuleReview(host, path, selected));
  });
}

function actionButton(parent: HTMLElement, label: string, action: () => Promise<void>): HTMLButtonElement {
  const button = parent.createEl("button", { text: label, attr: { type: "button" } });
  button.onclick = async () => {
    if (button.disabled) return;
    button.disabled = true;
    try { await action(); }
    catch (error) { new Notice(error instanceof Error ? error.message : "这次操作未完成，请重试。"); }
    finally { button.disabled = false; }
  };
  return button;
}
