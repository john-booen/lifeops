import type LifeOpsPlugin from "../../main";
import { Notice } from "obsidian";
import { NoteUnderstandingUpdatesModal } from "../../noteUnderstandingUpdatesModal";
import { todayString } from "../../date";
import { LIFEOPS_VIEW_TYPE, LifeOpsView } from "../../lifeOpsView";
import { generateProactiveCandidates } from "../../scheduler";
import type { ProactiveCandidate } from "../../scheduler";
import { visibleProactiveCandidates, type ProactiveFeedbackDecision } from "../../proactivePolicy";
import { deliverStewardReminder, runStewardReminders, withWeeklySummary } from "./reminders";
import { executeProactiveFeedback } from "../../proactiveFeedbackRuntime";
import type { StoreHost } from "../../store/settingsSlice";
import { getTimeContext } from "../../timeContext";
import { getWorkflowTemplate, workflowCatalogToMarkdown, workflowRunDraftMarkdown } from "../../workflows";
import type { LifeOpsWorkflowId } from "../../workflows";
import { assertTradeReviewCurrent, collectTradeReview, tradeReviewPromptData, type TradeReviewPeriod } from "../trading/reviewData";
import { parseTradeReviewAnalysis, renderTradeReview, TRADE_REVIEW_FALLBACK, TRADE_REVIEW_MARKER } from "../trading/reviewReport";

export interface ReviewHost {
  activateView: LifeOpsPlugin["activateView"];
  app: LifeOpsPlugin["app"];
  createProactiveCandidatePreview: LifeOpsPlugin["createProactiveCandidatePreview"];
  dispatchProactiveCandidate: LifeOpsPlugin["dispatchProactiveCandidate"];
  lifeOpsEvents: LifeOpsPlugin["lifeOpsEvents"];
  lifecycleGeneration: LifeOpsPlugin["lifecycleGeneration"];
  noteUnderstandingUpdates: LifeOpsPlugin["noteUnderstandingUpdates"];
  observeProvider: LifeOpsPlugin["observeProvider"];
  pendingJournalReviewSignal: LifeOpsPlugin["pendingJournalReviewSignal"];
  proactiveCycleRunning: LifeOpsPlugin["proactiveCycleRunning"];
  proactiveLifecycle: LifeOpsPlugin["proactiveLifecycle"];
  refreshViews: LifeOpsPlugin["refreshViews"];
  saveLocalOperation: LifeOpsPlugin["saveLocalOperation"];
  settings: LifeOpsPlugin["settings"];
  store: LifeOpsPlugin["store"];
  unloaded: LifeOpsPlugin["unloaded"];
  withAiFallback: LifeOpsPlugin["withAiFallback"];
}

export async function writeWorkflowCatalog(this: ReviewHost): Promise<void> {
    let path = "";
    await this.saveLocalOperation("generate_workflow_catalog", {}, async store => {
      path = await store.writeWorkflowDraft("workflow-templates", workflowCatalogToMarkdown());
    });
    new Notice(`LifeOps 工作流模板已写入：${path}`);
  }

export async function createWorkflowRunDraft(this: ReviewHost, id: LifeOpsWorkflowId): Promise<void> {
    const template = getWorkflowTemplate(id);
    if (!template) {
      new Notice(`未找到 LifeOps 工作流模板：${id}`);
      return;
    }
    let path = "";
    await this.saveLocalOperation("generate_workflow_draft", { id }, async store => {
      path = await store.writeWorkflowDraft(`${todayString()}-${id}`, workflowRunDraftMarkdown(template));
    });
    new Notice(`LifeOps 工作流草稿已写入：${path}`);
  }

export function openUnderstandingUpdates(this: ReviewHost, path?: string): void {
    if (this.unloaded) return; this.noteUnderstandingUpdates?.close(); const generation = this.lifecycleGeneration;
    const assertHost = () => { if (this.unloaded || this.lifecycleGeneration !== generation) throw new Error("插件已关闭，未继续核对原文更新。"); };
    const modal = new NoteUnderstandingUpdatesModal(this.app, this.store as unknown as StoreHost, async (message, assertForm) => {
      assertHost(); assertForm(); await this.activateView(); assertHost(); assertForm();
      const view = this.app.workspace.getLeavesOfType(LIFEOPS_VIEW_TYPE)[0]?.view;
      if (!(view instanceof LifeOpsView)) throw new Error("对话窗口暂时未准备好，请重新打开。");
      await view.openConversationDraft(message, () => { assertHost(); assertForm(); });
    }, assertHost, () => { if (this.noteUnderstandingUpdates === modal) this.noteUnderstandingUpdates = null; }, path ?? this.app.workspace.getActiveFile()?.path);
    this.noteUnderstandingUpdates = modal; modal.open();
  }

export async function generateProactiveCandidateReport(this: ReviewHost): Promise<void> {
    const candidates = await this.createProactiveCandidatePreview(3, true);
    await this.store.appendProactiveCandidates(candidates);
    new Notice(candidates.length > 0
      ? `LifeOps 已生成 ${candidates.length} 条主动候选，已写入 Proactive/candidates.jsonl`
      : "LifeOps 当前没有需要生成的主动候选");
  }

export async function createProactiveCandidatePreview(this: ReviewHost, limit = 3, force = false): Promise<ProactiveCandidate[]> {
    const time = getTimeContext();
    const now = new Date();
    const [board, personalMemories, policyState] = await Promise.all([
      this.store.getTaskDashboard(),
      this.store.readPersonalMemories(),
      this.store.readProactivePolicyState()
    ]);
    const pendingHabitCount = board.habits.filter((item) => item.requiredToday && item.status === "pending").length;
    const habitFailureCount = board.habits.reduce((max, item) => Math.max(max, item.weeklyFailures), 0);
    const candidateMemoryCount = personalMemories.records.filter((entry) => entry.status === "candidate").length;
    const lastCandidateAt = policyState.deliveries.at(-1)?.deliveredAt;
    const candidates = generateProactiveCandidates({
      time,
      now,
      lastCandidateAt: force ? undefined : lastCandidateAt,
      pendingHabitCount,
      habitFailureCount,
      candidateMemoryCount,
      recentTradingSignal: false,
      overdueTaskCount: board.overdue.length,
      newJournalSignal: this.pendingJournalReviewSignal,
      sustainedFatigueRisk: false,
      highRiskActivity: false
    }, {
      enabled: force || this.settings.proactive.enabled,
      proactiveLevel: force ? 2 : this.settings.proactive.level,
      minMinutesBetweenCandidates: force ? 0 : 0,
      quietHoursStart: 0,
      quietHoursEnd: 0
    });
    return candidates.slice(0, limit);
  }

export function markJournalReviewSignal(this: ReviewHost, path: string): void {
    if (path.startsWith(`${this.settings.folders.dailyRoot}/`) && path.endsWith(".md")) {
      this.pendingJournalReviewSignal = true;
    }
  }

export async function runProactiveCycle(this: ReviewHost): Promise<void> {
  if (this.store.canWriteFacts?.() === false) return;
  await runStewardReminders(this);
}

export function dispatchProactiveCandidate(this: ReviewHost, candidate: ProactiveCandidate): void {
  deliverStewardReminder(this, candidate);
}

export async function generateTradingReview(this: ReviewHost, signal?: AbortSignal, period: TradeReviewPeriod = "day"): Promise<void> {
    await this.observeProvider("trading_review", "text", async (request, store, ai, current, onCommitted) => {
      const base = store as unknown as StoreHost;
      const data = await collectTradeReview(base, period);
      current();
      let local = false;
      const text = await this.withAiFallback(options => ai.tradingReview(tradeReviewPromptData(data), options), TRADE_REVIEW_FALLBACK,
        { ...request, onLocalFallback: reason => { local = true; request.onLocalFallback?.(reason); } });
      current();
      let analysis;
      try { analysis = parseTradeReviewAnalysis(local ? TRADE_REVIEW_FALLBACK : text, data); }
      catch { request.onLocalFallback?.("invalid_response"); analysis = parseTradeReviewAnalysis(TRADE_REVIEW_FALLBACK, data); local = true; }
      const markdown = renderTradeReview(data, analysis, local);
      const path = base.path(base.settings.folders.aiReports, "交易", `${data.period.slug}.md`);
      await this.saveLocalOperation("generated_createTradingReview", { period, path }, async scope => {
        current();
        await assertTradeReviewCurrent(scope, data);
        const old = scope.getFile(path) ? await scope.readPath(path) : undefined;
        if (old !== undefined && !old.startsWith(TRADE_REVIEW_MARKER + "\n")) throw Error("复盘输出位置已有手写笔记，请先核对。");
        const next = old === undefined ? `${TRADE_REVIEW_MARKER}\n${markdown}` : `${old}${old.endsWith("\n") ? "" : "\n"}\n---\n\n${markdown}`;
        await scope.writeFile(path, next);
        current();
      }, { assertCurrent: current, assertBeforeCommit: () => assertTradeReviewCurrent(base, data), onCommitted });
      await this.refreshViews().catch(() => undefined);
      const file = base.getFile(path);
      if (file && this.app.workspace.getLeaf) await this.app.workspace.getLeaf("tab").openFile(file, { state: { mode: "preview" } }).catch(() => undefined);
      new Notice(`已保存交易复盘。${path}`);
    }, signal);
  }

export async function getProactiveCandidates(this: ReviewHost): Promise<ProactiveCandidate[]> {
    if (!this.settings.proactive.enabled) return [];
    const saved = await this.store.readProactiveCandidates(100);
    const state = await this.store.readProactivePolicyState();
    const visible = visibleProactiveCandidates(saved, state).slice(0, 6);
    return withWeeklySummary(this.store as unknown as StoreHost, visible).catch(() => visible.map(item => ({ ...item, summaryPath: undefined })));
  }

export async function respondToProactiveCandidate(this: ReviewHost, candidateId: string, decision: ProactiveFeedbackDecision): Promise<void> {
    const candidates = await this.store.readProactiveCandidates(100);
    let result: Awaited<ReturnType<typeof executeProactiveFeedback>> | undefined;
    let audit: import("../../proactivePolicy").ProactiveFeedbackAuditRecord | undefined;
    try {
      await this.saveLocalOperation("respond_proactive_candidate", { candidateId, decision }, async store => {
        result = await executeProactiveFeedback(candidates, await store.readProactivePolicyState(), candidateId, decision, {
        writePolicyState: (nextState) => store.writeProactivePolicyState(nextState),
        createWorkflowDraft: async (workflowId, candidate) => {
          const template = getWorkflowTemplate(workflowId);
          if (!template) throw new Error(`找不到 LifeOps 工作流模板：${workflowId}`);
          return store.writeWorkflowDraft(
            `${todayString()}-${workflowId}-${candidate.id}`,
            workflowRunDraftMarkdown(template)
          );
        },
        appendAudit: async (record) => { audit = record; }
        });
      });
    } catch (error) {
      if (audit) await this.store.appendProactiveFeedbackAudit({ ...audit, outcome: "failed", error: "本次操作未通过保存或恢复检查。" }).catch(() => undefined);
      throw error;
    }
    if (audit) await this.store.appendProactiveFeedbackAudit(audit).catch(() => { new Notice("提醒已经处理，但附加历史记录未保存。"); });
    if (!result) throw new Error("这次提醒处理未完成，请重试。");
    if (result.workflowPath) new Notice(`已接受提醒并生成工作流草稿：${result.workflowPath}`);
    const candidate = candidates.find((item) => item.id === candidateId)!;
    try {
      this.lifeOpsEvents.publish({
        type: "proactive.feedback",
        source: "runtime",
        payload: {
          candidateId,
          kind: candidate.kind,
          decision,
          effect: result.effect.kind,
          workflowPath: result.workflowPath
        }
      });
      await this.refreshViews();
    } catch {
      new Notice("提醒已经处理，但页面更新失败，请刷新页面。");
    }
  }
