import type LifeOpsPlugin from "../../main";
import { Notice, TFile } from "obsidian";
import { newLocalOperationId, recordRevision } from "../../operationIdentity";
import { type InjectedContext } from "../../contextInjection";
import { UndoCapacityError } from "../../dataFoundation/factOperation";
import { recentLedgerRecords, type OperationLedgerDocument } from "../../dataFoundation/operationLedger";
import { type PersonalMemoryRecord, type PersonalMemoryReview } from "../../personalMemory";
import { isSummaryMemoryRef, readPersonalMemoryWithSources } from "../../personalMemorySources";
import { openPersonalMemorySourceModal } from "../../personalMemorySourceModal";
import type { StewardOperationSummary } from "../../panel/stewardRecords";
import { isVaultPathExcluded } from "../../privacy";
import { recordConversationMemory } from "../../memorySystem";
import type { StoreHost } from "../../store/settingsSlice";
import type { AgentActionSuggestion } from "../../types";
import { archiveExpiredMemoryRecords } from "./summaryMemory";

export interface MemoryHost {
  app: LifeOpsPlugin["app"];
  createAgentRuntime: LifeOpsPlugin["createAgentRuntime"];
  getStewardMemories: LifeOpsPlugin["getStewardMemories"];
  lifeOpsEvents: LifeOpsPlugin["lifeOpsEvents"];
  lifecycleGeneration: LifeOpsPlugin["lifecycleGeneration"];
  observeProvider: LifeOpsPlugin["observeProvider"];
  personalMemoryExpiryTimer: LifeOpsPlugin["personalMemoryExpiryTimer"];
  personalMemorySourcePaths: LifeOpsPlugin["personalMemorySourcePaths"];
  personalMemorySourceRefreshTimer: LifeOpsPlugin["personalMemorySourceRefreshTimer"];
  refreshViews: LifeOpsPlugin["refreshViews"];
  saveLocalOperation: LifeOpsPlugin["saveLocalOperation"];
  settings: LifeOpsPlugin["settings"];
  store: LifeOpsPlugin["store"];
  unloaded: LifeOpsPlugin["unloaded"];
}

export async function openPersonalMemoryReview(this: MemoryHost): Promise<void> {
    let path = "";
    const ownerStore = this.store, owner = ownerStore as unknown as StoreHost, generation = this.lifecycleGeneration;
    const { captureLegacyMemoryReview } = await import("../../legacyMemoryReview");
    const review = await captureLegacyMemoryReview(owner, () => !this.unloaded && this.lifecycleGeneration === generation && this.store === ownerStore);
    await this.saveLocalOperation("generate_memory_review", {}, async store => {
      await review.assertBeforeCommit();
      review.assertScoped(store);
      path = await store.writeWorkflowDraft("personal-memory-review", review.markdown);
    }, { assertCurrent: review.assertCurrent, assertBeforeCommit: review.assertBeforeCommit });
    review.assertCurrent();
    await this.app.workspace.openLinkText(path, "", true);
    review.assertCurrent();
    new Notice("LifeOps 已打开个人记忆审查中心");
  }

export async function getStewardMemories(this: MemoryHost): Promise<PersonalMemoryRecord[]> {
    return [...(await readPersonalMemoryWithSources(this.store as unknown as StoreHost)).records]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

export async function getStewardOperations(this: MemoryHost): Promise<StewardOperationSummary[]> {
    const store = this.store as unknown as StoreHost;
    const path = store.path(this.settings.folders.aiReports, "Operations", "operation-ledger.json");
    const document = await store.readJson<OperationLedgerDocument>(path, { version: 1, records: [] });
    const labels: Record<string, string> = {
      create_task: "新建任务", complete_task: "完成任务", create_habit: "新建习惯", complete_habit: "习惯打卡",
      append_journal_entry: "写入日记", append_knowledge_note: "写入知识笔记", append_trading_model_note: "补充交易模型",
      inspect_note_understanding_source: "读取笔记原文",
      confirm_note_understanding: "保存笔记理解候选",
      inspect_weekly_review_sources: "读取周回顾原文",
      confirm_weekly_review: "保存周回顾草稿",
      confirm_review_memory: "审查个人记忆", confirm_update_memory: "保存记忆", confirm_delete_task: "删除任务", confirm_delete_habit: "删除习惯",
      local_createTask: "新建任务", local_updateTask: "修改任务", local_completeTask: "完成任务", local_deleteTask: "删除任务",
      local_addJournalPlanTask: "将日记计划加到任务",
      local_createHabit: "新建习惯", local_updateHabit: "修改习惯", local_recordHabit: "习惯打卡", local_deleteHabit: "删除习惯",
      local_appendHealthEntry: "手动记录健康", manual_health_csv_batch: "导入健康 CSV",
      manual_health_screenshot: "截图记健康", manual_trade_screenshot_batch: "截图记交易",
      local_openRecordNote: "准备文字记录", local_screen_idea_candidates: "筛查日记想法候选",
      generated_period_summary: "生成日、周或月摘要", scheduled_period_summary: "自动生成摘要",
      scheduled_summary_activation: "开始自动生成摘要",
      scheduled_device_capture_source: "签收设备原记录",
      scheduled_steward_reminders: "更新主动提醒", scheduled_archive_memories: "归档过期记忆",
      scheduled_summary_memories: "从日摘要记下事实", external_vault_index: "重建外部只读索引"
    };
    const reviewFolder = store.path(this.settings.folders.aiReports, "周回顾") + "/";
    return recentLedgerRecords(document).slice(0, 30)
      .map(record => {
        const undo = record.result?.undo;
        const files = undo?.kind === "restore_guarded_files" ? undo.files : undefined;
        const target = record.toolName === "confirm_weekly_review" && files?.length === 1 ? files[0].path : undefined;
        const targetPath = typeof target === "string" && target.startsWith(reviewFolder) && !target.startsWith("/")
          && !target.includes("\\") && !/[\u0000-\u001f\u007f]/.test(target)
          && !target.split("/").some(part => !part || part === "." || part === ".." || part.startsWith("."))
          && !isVaultPathExcluded(target, this.settings.privacy?.excludedVaultPrefixes) ? target : undefined;
        return {
          id: record.operationId,
          title: labels[record.toolName] ?? "LifeOps 资料操作",
          status: record.status,
          updatedAt: record.updatedAt,
          canUndo: record.status === "verified" && record.result?.undo?.kind === "restore_guarded_files",
          ...(targetPath ? { targetPath } : {})
        };
      });
  }

export async function openStewardSource(this: MemoryHost, path: string, sourceId?: string): Promise<void> {
    try {
      if (!path || path.startsWith("/") || path.includes("\\") || path.split("/").some(part => part === ".." || part === "." || part.startsWith("."))
        || isVaultPathExcluded(path, this.settings.privacy?.excludedVaultPrefixes)) throw new Error("Unavailable source");
      if (sourceId) {
        const record = (await this.getStewardMemories()).find(item => item.sourceRefs.some(ref => ref.sourceId === sourceId && ref.path === path));
        if (!record) throw new Error("Unavailable memory source");
        if (sourceId.startsWith("confirmed:")) {
          // Show this confirmation only; never open the entire private Ledger.
          openPersonalMemorySourceModal(this.app, record, sourceId);
          return;
        }
        if (isSummaryMemoryRef({ path, sourceId }, this.store as unknown as StoreHost)) {
          const file = this.app.vault.getAbstractFileByPath(path);
          if (!(file instanceof TFile) || file.path !== path) throw new Error("Unavailable summary source");
          await this.app.workspace.getLeaf("tab").openFile(file, { state: { mode: "preview" } });
          return;
        }
        const conversationRoot = (this.store as unknown as StoreHost).path(this.settings.folders.aiReports, "Conversations");
        if (path.startsWith(`${conversationRoot}/`) && /^\d{4}-\d{2}-\d{2}\.md$/.test(path.slice(conversationRoot.length + 1))
          && sourceId === `conversation:${path.slice(conversationRoot.length + 1, -3)}`) {
          const file = this.app.vault.getAbstractFileByPath(path);
          if (!(file instanceof TFile) || file.path !== path) throw new Error("Unavailable conversation source");
          await this.app.workspace.getLeaf("tab").openFile(file, { state: { mode: "preview" } });
          return;
        }
      }
      // Only exact, current Vault paths are accepted. Never resolve an ambiguous wiki link.
      if (!path || path.startsWith("/") || path.includes("\\") || path.split("/").some(part => part === ".." || part === ".")
        || !this.store.isManagedSourcePath(path)) throw new Error("Unavailable source");
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile) || file.path !== path || file.extension !== "md") throw new Error("Unavailable source");
      await this.app.workspace.getLeaf("tab").openFile(file, { state: { mode: "preview" } });
    } catch {
      new Notice("这份来源目前无法打开，可能已移动、删除，或不在允许读取的范围。原资料没有修改。");
    }
  }

export async function undoStewardOperation(this: MemoryHost, id: string): Promise<void> {
    try {
      await this.createAgentRuntime().undoOperation(id);
    } catch {
      new Notice("撤销没有完成。资料可能已有后续修改，已停止处理并保留当前内容。请把这条提示反馈给我协助核对。");
      return;
    }
    // Runtime has already verified the selected operation and refreshed its views.
    new Notice("已撤销你选中的这一条操作。");
  }

export async function prepareStewardMemoryReview(this: MemoryHost, record: PersonalMemoryRecord, review: PersonalMemoryReview): Promise<AgentActionSuggestion[]> {
    const current = (await this.store.readPersonalMemories()).records.find(item => item.id === record.id);
    if (!current || recordRevision(current) !== recordRevision(record)) throw new Error("记忆已变化，请刷新后重新核对。");
    const result = await this.createAgentRuntime().executeToolCall({
      toolName: "review_personal_memory",
      arguments: { memoryId: record.id, decision: review.decision, ...(review.decision === "correct" ? { correctedContent: review.content.trim() } : {}) },
      source: "system", callId: newLocalOperationId("steward-memory-review")
    });
    if (!result.success || !result.actions.length
      || result.actions.some(action => action.expectedTargetRevisions?.[`memory:${record.id}`] !== recordRevision(record))) {
      throw new Error("记忆确认卡没有生成，请刷新后重新核对。");
    }
    return result.actions;
  }

export async function undoLatestLifeOpsOperation(this: MemoryHost): Promise<void> {
    let operationId: string | null;
    try {
      operationId = await this.createAgentRuntime().undoLatestOperation();
    } catch (error) {
      new Notice(error instanceof UndoCapacityError ? error.message
        : "撤销没有完成，已停止继续处理。资料可能已有后续修改，或恢复检查未通过。请保留当前状态，把这条提示反馈给我协助核对。", 10000);
      return;
    }
    if (!operationId) {
      new Notice("LifeOps 当前没有可撤销的写入操作");
      return;
    }
    await this.refreshViews();
    new Notice(`LifeOps 已撤销最近一次写入：${operationId}`);
  }

export async function recordAgentConversationMemory(this: MemoryHost, userMessage: string, assistantReply: string, injectedContext: InjectedContext, isCurrent: () => boolean = () => true): Promise<void> {
    if (!isCurrent()) return;
    await recordConversationMemory(this.store as unknown as StoreHost, userMessage, assistantReply, injectedContext, isCurrent).catch((error) => {
      if (!isCurrent() || (error instanceof Error && error.name === "AbortError")) return;
      new Notice("本次记忆候选未能保存，已保留原有记忆。可稍后重新提出需要记住的内容。");
    });
    if (!isCurrent()) return;
    this.lifeOpsEvents.publish({
      type: "conversation.assistant_reply",
      source: "conversation",
      payload: { userMessageLength: userMessage.length, replyLength: assistantReply.length }
    });
  }

export function queuePersonalMemorySourceRefresh(this: MemoryHost, path: string, includeDescendants = false): void {
    if (this.unloaded || !path) return;
    const affected = (source: string): boolean => source === path || (includeDescendants && source.startsWith(`${path}/`));
    if (!affected((this.store as unknown as StoreHost).personalMemoryPath())
      && ![...(this.personalMemorySourcePaths ?? [])].some(affected)) return;
    window.clearTimeout(this.personalMemorySourceRefreshTimer);
    this.personalMemorySourceRefreshTimer = window.setTimeout(() => {
      if (!this.unloaded) void this.refreshViews().catch(() => undefined);
    }, 150);
  }

export function schedulePersonalMemoryExpiry(this: MemoryHost, records: PersonalMemoryRecord[]): void {
    this.personalMemorySourcePaths = new Set(records.flatMap(record => record.sourceRefs.map(source => source.path)));
    window.clearTimeout(this.personalMemoryExpiryTimer);
    const now = Date.now();
    const next = Math.min(...records.filter(record => record.status !== "forgotten" && !record.archivedAt)
      .map(record => Date.parse(record.expiresAt ?? "")).filter(time => time > now));
    if (!Number.isFinite(next) || this.unloaded) return;
    this.personalMemoryExpiryTimer = window.setTimeout(() => {
      if (!this.unloaded) void archiveExpiredMemoryRecords(this, new Date()).catch(() => undefined);
    }, Math.min(2_147_483_647, Math.max(1, next - now + 1)));
  }
