import { Modal, Notice } from "obsidian";
import type LifeOpsPlugin from "../../main";
import { addDays, formatDate, normalizeJournalDate } from "../../date";
import { fileRevision } from "../../operationIdentity";
import type { StoreHost } from "../../store/settingsSlice";
import type { LocalOperationHost } from "../serviceHost";
import { healthSummaryLine, localSummaryText, summaryMessages, validSummaryText, weeklySummaryHighlights } from "./analysis";
import { collectChildSummaries, collectSummaryData, sameSummaryTaskMetrics, sameSummaryTradeTotals, summaryInputRevision } from "./data";
import { readSummary, readSummaryScope, renderSummary, summaryPath, summaryPathAllowed, type SummaryKind } from "./notes";
import { scheduledSummaryPeriods, summaryBackfillPeriods, summaryFolders, summaryPeriod, type SummaryLevel, type SummaryPeriod } from "./periods";
import { journalCoverageText } from "./journalCoverage";
import { configuredCredentials } from "../../credentialSecurity";

export interface SummaryHost extends LocalOperationHost {
  app: LifeOpsPlugin["app"];
  observeProvider: LifeOpsPlugin["observeProvider"];
  register(callback: () => void): void;
  store: StoreHost;
  unloaded: boolean;
  withAiFallback: LifeOpsPlugin["withAiFallback"];
}
type SummaryResult = { path: string; status: "saved" | "existing" | "unavailable"; generatedBy?: SummaryKind };
type PendingSummary = { store: StoreHost; signal?: AbortSignal; operation: Promise<SummaryResult> };
const pending = new WeakMap<SummaryHost, Map<string, PendingSummary>>();
const scheduleRuns = new WeakMap<StoreHost, { phase: string; running: boolean; retryAt: number }>();
const scheduledHosts = new WeakSet<SummaryHost>();
const scheduleStarts = new WeakMap<StoreHost, Promise<string>>();

const timeOfDay = (now: Date) => now.getHours() * 60 + now.getMinutes();
const dateCutoff = (period: SummaryPeriod, now: Date) => {
  const day = formatDate(now);
  return day < period.to ? day : period.to;
};
const providerReady = ({ ai }: StoreHost["settings"]) => ai.provider !== "off" && ai.dataDisclosureAccepted && Boolean(ai.endpoint && ai.model);

function periodIsComplete(period: SummaryPeriod, now: Date, sundayComplete: boolean): boolean {
  const today = formatDate(now);
  if (today > period.to) return true;
  if (today < period.to || period.level === "month") return false;
  return timeOfDay(now) >= 23 * 60 + 30 && (period.level === "day" || sundayComplete);
}

export function generatePeriodSummary(host: SummaryHost, period: SummaryPeriod, now: Date, signal?: AbortSignal,
  scheduled = false): Promise<SummaryResult> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  const store = host.store;
  const path = summaryPath(store, period);
  if (!summaryPathAllowed(store, path) || dateCutoff(period, now) < period.from) {
    return Promise.resolve({ path, status: "unavailable" });
  }
  const operations = pending.get(host) ?? new Map<string, PendingSummary>();
  pending.set(host, operations);
  const current = operations.get(path);
  if (current?.store === store && !current.signal?.aborted) return current.operation;
  const operation = generateSummary(host, store, period, path, now, signal, scheduled).finally(() => {
    if (operations.get(path)?.operation === operation) operations.delete(path);
  });
  operations.set(path, { store, signal, operation });
  return operation;
}

async function generateSummary(host: SummaryHost, store: StoreHost, period: SummaryPeriod, path: string,
  now: Date, signal: AbortSignal | undefined, scheduled: boolean): Promise<SummaryResult> {
  signal?.throwIfAborted();
  const assertStore = () => {
    if (host.unloaded || host.store !== store) throw Error("摘要资料库已变化，请重新生成。");
  };
  const scope = await readSummaryScope(store);
  const through = dateCutoff(period, now);
  const [old, children] = await Promise.all([
    readSummary(store, period, scope.hash),
    collectChildSummaries(store, period, through, scope)
  ]);
  const inputCount = children.filter(note => note.complete).length;
  assertStore();
  const complete = periodIsComplete(period, now, children.some(note => note.complete && note.to === period.to));
  const canRefresh = old && !old.edited && (old.properties.through < through
    || !old.properties.complete && complete || old.properties.inputCount < inputCount
    || old.properties.generatedBy === "local" && providerReady(store.settings));
  const existing = { path, status: "existing" as const, generatedBy: old?.properties.generatedBy };
  if (store.getFile(path) && !canRefresh) {
    if (!old || old.edited) return existing;
  }
  const data = await collectSummaryData(store, period, now, scope.protect, children);
  assertStore();
  const inputRevision = summaryInputRevision(data);
  if (store.getFile(path) && !canRefresh && old?.properties.inputRevision === inputRevision) return existing;
  return host.observeProvider("daily_review", "text", async (request, _store, ai, providerCurrent, onCommitted) => {
    const current = () => {
      assertStore();
      providerCurrent();
    };
    const assertScope = async () => {
      current();
      if ((await readSummaryScope(store)).hash !== scope.hash || !summaryPathAllowed(store, path)) {
        throw Error("摘要可读取的资料范围有变化，请重新生成。");
      }
      current();
    };
    let operationStore: StoreHost | undefined;
    const assertInput = async () => {
      await assertScope();
      if (!operationStore) throw Error("摘要保存未能核对输入记录。");
      const currentChildren = await collectChildSummaries(operationStore, period, through, scope);
      const latest = await collectSummaryData(operationStore, period, now, scope.protect, currentChildren);
      current();
      if (Boolean(latest.stats.tasks) !== Boolean(data.stats.tasks) || latest.stats.tasks && !sameSummaryTaskMetrics(latest.metrics, data.metrics)) {
        throw Error("任务统计在摘要生成期间有变化，请重新生成摘要。");
      }
      if (Boolean(latest.stats.trades) !== Boolean(data.stats.trades) || latest.stats.trades && !sameSummaryTradeTotals(latest.metrics, data.metrics)) {
        throw Error("交易统计在摘要生成期间有变化，请重新生成摘要。");
      }
      if (summaryInputRevision(latest) !== inputRevision) throw Error("摘要依据在生成期间有变化，请重新生成摘要。");
    };
    const fallback = localSummaryText(period, data, configuredCredentials(store.settings));
    let local = false;
    const options = { ...request, beforeTextRequest: assertScope, assertTextRequestCurrent: current,
      onLocalFallback: (reason: Parameters<NonNullable<typeof request.onLocalFallback>>[0]) => {
        local = true;
        request.onLocalFallback?.(reason);
      } };
    const ask = (retry: boolean) => host.withAiFallback(
      requestOptions => ai.generateSummary(summaryMessages(period, data, scope.protect, retry), requestOptions,
        { timeoutMs: period.level === "week" ? 90_000 : 60_000,
          reasoning: period.level === "month" ? "disabled" : "enabled" }), fallback, options);
    await assertScope();
    let text = scope.protect(await ask(false));
    if (!local && !validSummaryText(text, period.level)) text = scope.protect(await ask(true));
    if (!local && !validSummaryText(text, period.level)) {
      options.onLocalFallback("invalid_response");
      text = fallback + "\n\n> 模型返回的摘要未达到格式要求，以上为 LifeOps 本地生成的结构化草稿。";
    }
    if (!local) {
      const health = healthSummaryLine(data);
      if (health) text += "\n\n" + health;
    }
    const journalCoverage = journalCoverageText(data.daily?.journalCoverage);
    if (journalCoverage) text = journalCoverage + "\n\n" + text;
    if (period.level === "week") text = weeklySummaryHighlights(data) + "\n\n" + text;
    const generatedBy = local ? "local" : "model";
    const markdown = renderSummary(period, through, scope.hash, data.metrics, inputCount, complete, generatedBy, text, inputRevision);
    const operationName = scheduled ? "scheduled_period_summary" : "generated_period_summary";
    await host.saveLocalOperation(operationName, { level: period.level, key: period.key, path }, async operation => {
      // Read through the transaction while it holds the vault lock.
      operationStore = operation;
      await assertInput();
      const previous = operation.getFile(path) ? fileRevision(await operation.readPath(path)) : undefined;
      if (previous !== old?.revision) throw Error("摘要位置已有新内容，已保留当前笔记。");
      await operation.writeFile(path, markdown);
      current();
    }, { assertCurrent: current, assertBeforeCommit: assertInput, onCommitted });
    await host.refreshViews().catch(() => undefined);
    return { path, status: "saved", generatedBy };
  }, signal);
}

export async function runScheduledSummaries(host: SummaryHost, now = new Date(), activeFrom?: string): Promise<void> {
  const store = host.store;
  if (host.unloaded || !providerReady(store.settings)) return;
  const minutes = timeOfDay(now);
  const phase = formatDate(now) + (minutes >= 23 * 60 + 30 ? "/night" : now.getDay() === 0 && minutes >= 21 * 60 + 30 ? "/week" : "/day");
  const prior = scheduleRuns.get(store);
  if (prior?.running || prior?.phase === phase && prior.retryAt > now.getTime()) return;
  const state = { phase, running: true, retryAt: Number.POSITIVE_INFINITY };
  scheduleRuns.set(store, state);
  try {
    for (const period of scheduledSummaryPeriods(now)) {
      if (host.unloaded || host.store !== store) return;
      const due = period.level === "month" ? addDays(period.to, 1) : period.to;
      if (activeFrom && due < activeFrom) continue;
      try { await generatePeriodSummary(host, period, now, undefined, true); }
      catch {
        if (!host.unloaded) state.retryAt = now.getTime() + 5 * 60_000;
      }
    }
  } finally { state.running = false; }
}

async function summaryActivationDay(host: SummaryHost, now: Date): Promise<string> {
  const store = host.store, today = formatDate(now);
  const path = store.path(store.settings.folders.aiReports, "摘要", "调度.json");
  const current = () => {
    if (host.unloaded || host.store !== store || !summaryPathAllowed(store, path)) throw Error("摘要调度已停止。");
  };
  const read = async (scope: StoreHost) => {
    const doc = await scope.readJson<{ version: number; from?: string }>(path, { version: 1 });
    if (doc.version !== 1 || doc.from !== undefined && normalizeJournalDate(doc.from, today) !== doc.from) throw Error("摘要调度格式异常。");
    return doc.from;
  };
  current();
  let from = await read(store);
  if (from) return from;
  await host.saveLocalOperation("scheduled_summary_activation", {}, async scope => {
    current();
    from = await read(scope);
    if (!from) { from = today; await scope.writeJson(path, { version: 1, from }); }
  }, { assertCurrent: current });
  return from ?? today;
}

export function startSummarySchedule(host: SummaryHost, now = new Date()): Promise<void> {
  scheduledHosts.add(host);
  return tickSummarySchedule(host, now);
}

export async function tickSummarySchedule(host: SummaryHost, now = new Date()): Promise<void> {
  const store = host.store;
  if (store.canWriteFacts?.() === false || !scheduledHosts.has(host) || host.unloaded || !providerReady(store.settings)) return;
  let start = scheduleStarts.get(store);
  if (!start) { start = summaryActivationDay(host, now); scheduleStarts.set(store, start); }
  try {
    const activeFrom = await start;
    if (host.store === store) await runScheduledSummaries(host, now, activeFrom);
  } catch { if (scheduleStarts.get(store) === start) scheduleStarts.delete(store); }
}

export async function openPeriodSummary(host: SummaryHost, level: SummaryLevel, signal?: AbortSignal): Promise<void> {
  const now = new Date();
  const result = await generatePeriodSummary(host, summaryPeriod(level, formatDate(now)), now, signal);
  if (result.status === "unavailable") { new Notice("这个摘要目录目前不可用。"); return; }
  if (signal?.aborted) return;
  await openSummaryNote(host, result.path).catch(() => undefined);
  if (result.status === "saved") new Notice("已保存" + summaryFolders[level] + "摘要，可在最近操作撤销。");
}

export async function openSummaryNote(host: SummaryHost, path: string): Promise<void> {
  const folder = host.store.path(host.store.settings.folders.aiReports, "摘要");
  const file = path.startsWith(folder + "/") && summaryPathAllowed(host.store, path) ? host.store.getFile(path) : null;
  if (file?.path !== path || !host.app.workspace?.getLeaf) throw Error("摘要暂时无法打开。");
  await host.app.workspace.getLeaf("tab").openFile(file, { state: { mode: "preview" } });
}

export function openSummaryBackfill(host: SummaryHost): void {
  const modal = new SummaryBackfillModal(host);
  host.register(() => modal.close());
  modal.open();
}

class SummaryBackfillModal extends Modal {
  private readonly controller = new AbortController();
  constructor(private readonly host: SummaryHost) { super(host.app); }

  onOpen(): void {
    const now = new Date();
    const periods = summaryBackfillPeriods(now);
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "补齐最近八周摘要" });
    contentEl.createEl("p", { text: periods[0].from + " 至 " + periods.at(-1)!.to + "，最多生成 56 篇日摘要和 8 篇周摘要。" });
    contentEl.createEl("p", { text: "已配置的模型会收到允许读取的统计、日记信号和用户对话摘句。手写或编辑过的笔记会保留。关闭可停止，之后可继续。" });
    const progress = contentEl.createEl("p");
    const button = contentEl.createEl("button", { text: "确认开始补齐", cls: "mod-cta" });
    button.onclick = async () => {
      button.disabled = true;
      let saved = 0, unavailable = 0, local = 0;
      try {
        for (const [index, period] of periods.entries()) {
          this.controller.signal.throwIfAborted();
          progress.setText("已核对 " + index + " / " + periods.length + "，已保存 " + saved + " 篇。");
          const result = await generatePeriodSummary(this.host, period, now, this.controller.signal);
          if (result.status === "saved") saved++;
          if (result.status === "unavailable") unavailable++;
          if (result.generatedBy === "local") local++;
        }
        progress.setText("已保存 " + saved + " 篇，暂不可用 " + unavailable + " 篇。"
          + (local ? "有 " + local + " 篇是本地草稿，可以再次补齐。" : ""));
      } catch {
        if (!this.controller.signal.aborted) progress.setText("暂时中断，已保存 " + saved + " 篇。可以从现有记录继续。");
      } finally { button.disabled = false; }
    };
  }

  onClose(): void { this.controller.abort(); this.contentEl.empty(); }
}
