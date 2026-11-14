import * as agentService from "./agent/service";
import * as reviewService from "./features/review/service";
import { queueTaskOverload, startStewardReminders } from "./features/review/reminders";
import * as summaryService from "./features/summaries/service";
import * as memoryService from "./features/memory/service";
import { startMemoryMaintenance, tickMemoryMaintenance } from "./features/memory/summaryMemory";
import type { AgentToolExecutionResult } from "./agent/service";
import { runAgentTurn, type AgentTurnHost } from "./agent/run";
import { buildResidentContext } from "./agent/context";
import { Notice, Platform, Plugin, TFile, TFolder, WorkspaceLeaf } from "obsidian";
import { assertProviderActive, ProviderRunFailure } from "./providerRun";
import { pluginAssetUrl } from "./pluginAssetUrl";
import { captureReleaseHeartbeat, type ReleaseLoadIssue } from "./releaseHeartbeat";
import { LifeOpsAi } from "./ai";
import type { AiToolCall } from "./ai";
import { AgentRuntime } from "./agentRuntime";

import { newLocalOperationId } from "./operationIdentity";
import type { ToolCallResult } from "./agentRuntime";

import { type ContextSourceRecorder } from "./sourceReferences";

import { ProjectBoardModal } from "./projectBoard";
import { NoteUnderstandingUpdatesModal } from "./noteUnderstandingUpdatesModal";

import { ProjectJobRunner } from "./projectJobRunner";
import { ProjectJobModal } from "./projectJobModal";
import { TaskPlanReviewRegistry } from "./taskPlanReviewRegistry";
import { type ProjectCommand, type ProjectSnapshot } from "./projectContinuity";

import { prepareProjectTaskResultGuard } from "./projectTools";

import { captureKindLabel, captureSavedMessage, classifyByRules } from "./classifier";

import type { InjectedContext } from "./contextInjection";

import type { ReadonlyRecordLibrary } from "./readonlyRecordLibrary";
import type { VaultQueryRead } from "./vaultQueryRead";

import { type RealtimeToolOutput } from "./voice/realtimeToolOutput";

import { parseHealthCsv } from "./csv";
import { todayString } from "./date";
import { DEFAULT_SETTINGS } from "./defaults";
import { hasInterruptedFactOperation, recoverFactOperation, type FactOperationOptions } from "./dataFoundation/factOperation";
import { type PersonalMemoryRecord, type PersonalMemoryReview } from "./personalMemory";
import { readPersonalMemoryWithSources } from "./personalMemorySources";

import type { StewardOperationSummary } from "./panel/stewardRecords";
import { LIFEOPS_VIEW_TYPE, LifeOpsView } from "./lifeOpsView";
import type { LocalRecordKind } from "./localRecordNotes";
import { refreshJournalPresentation, clearJournalPresentation } from "./journalPresentation";
import { LifeOpsEventBus } from "./lifeOpsEventBus";
import { resolvePlatformCapabilities } from "./platformCapabilities";
import { restrictCredentialFilePermissions } from "./credentialSecurity";
import { setProviderEgressSink } from "./privacy";
import { CsvImportModal, HealthEntryModal, QuickCaptureModal } from "./modals";
import { openTradeForm, type TradeFormHost } from "./features/trading/service";
import { openTradeBackfill, type TradeBackfillHost } from "./features/trading/backfillModal";
import { openTradeCsvImport, type TradeCsvHost } from "./features/trading/csvImportModal";
import { openTradeScreenshotImport, type TradeScreenshotHost } from "./features/trading/screenshotImportModal";
import { recognizeTradeScreenshot as runTradeScreenshotVision } from "./features/trading/screenshotVision";
import type { TradeScreenshot } from "./features/trading/screenshotImport";
import { openTradeReviewPicker, registerTradeReviewActions, type TradeReviewUiHost } from "./features/trading/reviewUi";
import type { TradeReviewPeriod } from "./features/trading/reviewData";
import * as taskService from "./features/tasks/service";
import * as habitService from "./features/habits/service";
import * as journalService from "./features/journal/service";
import { JournalSignalLifecycle } from "./features/journal/signalLifecycle";
import { HabitPunishmentLifecycle } from "./features/habits/punishmentLifecycle";
import { migrateM1Fields } from "./dataFoundation/migrateM1";
import { migrateTradingHistory } from "./dataFoundation/migrateM2";
import * as todayService from "./features/today/service";
import { openIdeaCandidates, type IdeaUiHost } from "./features/ideas/candidateReview";
import { mountIdeaPanel } from "./features/ideas/panel";
import { mountLearningPanel, openLearningPlan, registerLearningCommands, type LearningUiHost } from "./features/learning/panel";
import { subscribeLearningNotes } from "./features/learning/capture";
import { subscribeReadingNotes } from "./features/reading/capture";
import { PHONE_INBOX_PATH } from "./features/phoneInbox/model";
import { PhoneInbox } from "./features/phoneInbox/service";
import { PhoneInboxModal } from "./features/phoneInbox/modal";
import { runConfirmedToolAction } from "./toolRegistry";
import type { JournalPlanChoice } from "./features/today/model";
import { settingsForAgentModel } from "./agent/models";
import type { LocalOperationHost } from "./features/serviceHost";
import { LifeOpsSettingTab } from "./settingsTab";
import type { ProactiveCandidate } from "./scheduler";
import { type ProactiveFeedbackDecision } from "./proactivePolicy";
import { ProactiveLifecycle } from "./proactiveLifecycle";
import { LifeOpsStore } from "./store";
import type { StoreHost } from "./store/settingsSlice";

import { tradingContextRevision, prepareTradingAction } from "./tradingTools";

import { TradingResearchBoard } from "./tradingResearchBoard";
import { runVoiceAgentSelfTest, runVoiceRuntimeSelfTest } from "./voiceCheck";
import { openSetupWizard } from "./features/setup/wizard";
import { migrateRealtimeVoiceSettings } from "./settingsMigration";
import { migrateLinkedNoteNames } from "./linkedNoteSettings";

import { voiceSettingsRevision } from "./voice/voiceSettingsBoundary";
import type { LifeOpsWorkflowId } from "./workflows";
import type { AgentActionSuggestion, AgentConversationMessage, AgentSubmissionOptions, AgentResponse, CaptureKind, ClassifiedInput, DashboardStats, HabitInput, HabitCheckinStatus, HabitDashboardItem, HabitDefinition, HealthEntry, LifeOpsSettings, LifeOpsTask, LifeOpsTaskInput, LifeOpsTaskQuadrant, QualityLogEntry, ProviderRequestOptions, ProviderStage, TaskDashboardData, VoiceMetricEntry } from "./types";

export default class LifeOpsPlugin extends Plugin {
  settings: LifeOpsSettings = DEFAULT_SETTINGS;
  private store!: LifeOpsStore;
  private ai!: LifeOpsAi;
  private statusBar!: HTMLElement;
  private styleEl: HTMLStyleElement | null = null;
  private readonly sourceChangeTimers = new Map<string, number>();
  private readonly proactiveLifecycle = new ProactiveLifecycle(() => { void this.runProactiveCycle(); }, notify =>
    this.lifeOpsEvents.subscribe(event => {
      if (event.type === "task.changed" || event.type === "habit.changed") notify();
      else if (event.type.startsWith("vault.")) {
        const payload = event.payload as { path?: string; oldPath?: string };
        if ([payload.path, payload.oldPath].some(path => path && this.store.isManagedSourcePath(path))) notify();
      }
    }));
  private pendingJournalReviewSignal = false;
  private proactiveCycleRunning = false;
  private savedVoiceSettingsRevision = "";
  private activeVoiceRequests = new Set<AbortController>();
  private activeProviderRequests = new Set<{ controller: AbortController; stage: ProviderStage; revision: string }>();
  private unloaded = false;
  private noteUnderstandingUpdates: NoteUnderstandingUpdatesModal | null = null;
  private lifecycleGeneration = 0;
  private dataFoundationBootstrap: Promise<void> | null = null;
  private dataFoundationEventsRegistered = false;
  private projectJobRunner: ProjectJobRunner | null = null;
  private taskPlanReviews: TaskPlanReviewRegistry | null = null;
  private readonly platformCapabilities = resolvePlatformCapabilities({
    isDesktopApp: Platform.isDesktopApp,
    platform: typeof process !== "undefined" ? process.platform : "unknown",
    hasNodeRuntime: typeof process !== "undefined" && typeof process.getuid === "function",
    hasElectronBridge: typeof window !== "undefined" && typeof (window as Window & { require?: unknown }).require === "function"
  });
  readonly lifeOpsEvents = new LifeOpsEventBus();
  private journalSignals?: JournalSignalLifecycle;
  private habitPunishments?: HabitPunishmentLifecycle;
  private phoneInbox?: PhoneInbox;

  async onload(): Promise<void> {
    const openedAt = new Date();
    const generation = ++this.lifecycleGeneration;
    this.unloaded = false;
    const current = () => this.isLifecycleCurrent(generation);
    const heartbeat = captureReleaseHeartbeat(this.app.vault.adapter, this.manifest, current, () => this.settings?.folders.aiReports);
    const issues: ReleaseLoadIssue[] = [];
    try {
      await this.loadLifeOps(generation, issues);
    } catch (error) {
      await heartbeat([...issues, "startup"]);
      throw error;
    }
    if (!current()) return;
    this.app.workspace.onLayoutReady(() => {
      if (!current()) return;
      void this.bootstrapDataFoundation(issues).then(
        async () => {
          await heartbeat(issues);
          if (current() && !issues.length) {
            if (this.settings.setupComplete === false) openSetupWizard(this);
            void summaryService.startSummarySchedule(this as unknown as summaryService.SummaryHost);
            startStewardReminders(this as unknown as reviewService.ReviewHost, openedAt);
            void startMemoryMaintenance(this as unknown as memoryService.MemoryHost);
            this.phoneInbox?.schedule();
          }
        },
        (error) => {
          if (!current()) return;
          console.error("LifeOps failed to bootstrap the data foundation", error);
          new Notice("LifeOps 资料暂时无法就绪。若提示保存中断，请先使用“检查并恢复未完成操作”；否则把这条提示反馈给我。", 10000);
          return heartbeat([...issues, "data"]);
        }
      );
    });
  }

  private async loadLifeOps(generation: number, issues: ReleaseLoadIssue[]): Promise<void> {
    for (const limitation of this.platformCapabilities.limitations) console.info(`LifeOps platform boundary: ${limitation}`);
    await this.loadSettings();
    if (!this.isLifecycleCurrent(generation)) return;
    await this.hardenPluginDataPermissions(issues);
    if (!this.isLifecycleCurrent(generation)) return;
    await this.injectStyles(issues);
    if (!this.isLifecycleCurrent(generation)) return;
    this.store = new LifeOpsStore(this.app, this.settings);
    registerTradeReviewActions(this as unknown as TradeReviewUiHost);
    const refreshJournalStyle = () => {
      if (this.isLifecycleCurrent(generation)) refreshJournalPresentation(this.app, this.settings.folders.dailyRoot);
    };
    this.registerEvent(this.app.workspace.on("file-open", refreshJournalStyle));
    this.registerEvent(this.app.workspace.on("layout-change", refreshJournalStyle));
    this.registerEvent(this.app.workspace.on("editor-change", refreshJournalStyle));
    this.registerEvent(this.app.metadataCache.on("changed", refreshJournalStyle));
    this.app.workspace.onLayoutReady(refreshJournalStyle);
    try {
      const interrupted = await hasInterruptedFactOperation(this.store as unknown as StoreHost);
      if (!this.isLifecycleCurrent(generation)) return;
      if (interrupted) {
        issues.push("recovery");
        new Notice("上次保存被中断。请先运行“检查并恢复未完成操作”，再继续修改资料。", 10000);
      }
    } catch {
      if (!this.isLifecycleCurrent(generation)) return;
      issues.push("recovery");
      new Notice("保存保护记录需要核对。请先停止修改资料，并把这条提示反馈给我协助处理。", 10000);
    }
    setProviderEgressSink((record) => this.store.appendProviderEgressAudit(record));
    this.ai = new LifeOpsAi(this.settings);
    this.registerView(LIFEOPS_VIEW_TYPE, (leaf: WorkspaceLeaf) => new LifeOpsView(leaf, this));
    if (Platform.isDesktopApp) {
      this.phoneInbox = new PhoneInbox({
        store: () => this.store as unknown as StoreHost,
        enabled: () => this.isLifecycleCurrent(generation) && this.settings.phoneInboxEnabled === true,
        submit: (text, turn, signal) => this.submitAgentMessage(text, [], { phoneInbox: turn, signal }),
        confirm: async (action, turn) => {
          await turn.assertLineCurrent();
          await runConfirmedToolAction(action, {
            store: this.store as unknown as StoreHost,
            assertCurrent: turn.assertCurrent,
            refreshViews: () => this.refreshViews()
          }, turn.assertLineCurrent);
        },
        undo: id => this.createAgentRuntime().undoOperation(id),
        notify: message => new Notice(message)
      }, this.lifeOpsEvents);
      this.addCommand({ id: "open-phone-inbox", name: "手机随手记回执", callback: () => this.openPhoneInbox() });
    }
    this.addRibbonIcon("layout-dashboard", "Open LifeOps", () => this.activateView(true));
    this.statusBar = this.addStatusBarItem();

    this.registerLifeOpsCommands();
    this.addSettingTab(new LifeOpsSettingTab(this));
    this.addCommand({ id: "open-setup", name: "打开初次设置向导", callback: () => openSetupWizard(this) });
    await this.updateStatusBar();
    if (!this.isLifecycleCurrent(generation)) return;
    this.registerInterval(window.setInterval(() => {
      void summaryService.tickSummarySchedule(this as unknown as summaryService.SummaryHost);
      void tickMemoryMaintenance(this as unknown as memoryService.MemoryHost);
      void this.updateStatusBar();
    }, 60_000));
    this.proactiveLifecycle.setEnabled(this.settings.proactive.enabled);
  }

  private registerLifeOpsCommands(): void {
    this.addCommand({
      id: "open-lifeops-dashboard",
      name: "打开 LifeOps 面板",
      callback: () => this.activateView(true)
    });
    this.addCommand({
      id: "initialize-lifeops-vault",
      name: "Initialize LifeOps vault structure",
      callback: async () => {
        await this.store.initializeVault();
        await this.refreshViews();
        new Notice("LifeOps 文件夹和模板已初始化");
      }
    });
    this.addCommand({
      id: "quick-capture",
      name: "Quick capture",
      callback: () => this.openQuickCapture()
    });
    this.addCommand({
      id: "create-lifeops-task",
      name: "Create LifeOps task",
      callback: () => this.openTaskModal()
    });
    this.addCommand({
      id: "open-lifeops-projects",
      name: "打开目标与项目",
      callback: () => this.openProjectBoard()
    });
    this.addCommand({ id: "open-lifeops-task-plan", name: "查看与创建可恢复安排", callback: () => this.openProjectTaskPlan() });
    this.addCommand({id:"open-lifeops-trading-research",name:"交易模型版本与案例",callback:()=>this.openTradingResearch()});
    registerLearningCommands(this as unknown as LearningUiHost);
    this.addCommand({
      id: "generate-daily-review",
      name: "生成日摘要",
      callback: () => this.generateDailyReview()
    });
    this.addCommand({
      id: "generate-trading-review",
      name: "生成交易复盘（日、周、月）",
      callback: () => openTradeReviewPicker(this.app, period => this.generateTradingReview(undefined, period), modal => this.register(() => modal.close()))
    });
    this.addCommand({
      id: "write-lifeops-workflow-templates",
      name: "Write LifeOps workflow templates",
      callback: () => this.writeWorkflowCatalog()
    });
    this.addCommand({
      id: "create-lifeops-nightly-consolidation-draft",
      name: "Create LifeOps nightly consolidation draft",
      callback: () => this.createWorkflowRunDraft("nightly_consolidation")
    });
    this.addCommand({
      id: "create-lifeops-weekly-review-draft",
      name: "生成周摘要",
      callback: () => this.generateWeeklySummary()
    });
    this.addCommand({ id: "backfill-lifeops-summaries", name: "补齐最近八周摘要",
      callback: () => summaryService.openSummaryBackfill(this as unknown as summaryService.SummaryHost) });
    this.addCommand({ id: "check-lifeops-understanding-updates", name: "查看原文理解的更新", callback: () => this.openUnderstandingUpdates() });
    this.addCommand({
      id: "generate-lifeops-proactive-candidates",
      name: "Generate LifeOps proactive candidates",
      callback: () => this.generateProactiveCandidates()
    });
    this.addCommand({
      id: "open-lifeops-personal-memory-review",
      name: "Open LifeOps personal memory review",
      callback: () => this.openPersonalMemoryReview()
    });
    this.addCommand({
      id: "undo-latest-lifeops-operation",
      name: "Undo latest LifeOps operation",
      callback: () => this.undoLatestLifeOpsOperation()
    });
    this.addCommand({
      id: "recover-interrupted-lifeops-operation",
      name: "检查并恢复未完成操作",
      callback: async () => {
        try {
          const result = await recoverFactOperation(this.store as unknown as StoreHost);
          await this.bootstrapDataFoundation();
          new Notice(result === "restored" ? "已恢复中断前的资料，可以重新执行刚才的操作。"
            : result === "kept" ? "已确认上次操作完整保存，无需重做。" : "没有需要恢复的中断操作。");
          await this.refreshViews();
        } catch {
          new Notice("恢复检查没有完成，已停止继续处理。请保留当前状态，把这条提示反馈给我协助核对。", 10000);
        }
      }
    });
    this.addCommand({
      id: "run-lifeops-voice-runtime-self-test",
      name: "Run LifeOps voice runtime self-test",
      callback: () => this.runVoiceRuntimeSelfTestCommand()
    });
    this.addCommand({
      id: "run-lifeops-voice-agent-self-test",
      name: "Run LifeOps voice agent self-test",
      callback: () => this.runVoiceAgentSelfTestCommand()
    });
    this.addCommand({
      id: "import-health-csv",
      name: "Import health CSV",
      callback: () => this.openHealthCsvImport()
    });
    this.addCommand({ id: "import-trade-csv", name: "导入交易 CSV", callback: () => openTradeCsvImport(this as unknown as TradeCsvHost) });
    this.addCommand({ id: "import-trade-screenshot", name: "截图记交易", callback: () => this.openTradeScreenshotImport() });
    this.addCommand({ id: "backfill-trades", name: "回填历史交易", callback: () => openTradeBackfill(this as unknown as TradeBackfillHost) });
    this.addCommand({
      id: "record-health-entry",
      name: "Record health entry",
      callback: () => this.openHealthEntryModal()
    });
    this.addCommand({
      id: "record-trade-entry",
      name: "Record trade entry",
      callback: () => this.openTradeEntryModal()
    });
    this.addCommand({
      id: "process-gateway-inbox",
      name: "Process external gateway inbox",
      callback: () => this.processGatewayInbox()
    });
    this.addCommand({
      id: "rebuild-lifeops-vault-index",
      name: "Rebuild LifeOps vault index",
      callback: () => this.rebuildVaultIndex()
    });
    this.addCommand({
      id: "sync-lifeops-data-foundation",
      name: "Sync LifeOps data foundation",
      callback: () => this.syncDataFoundation()
    });
    this.addCommand({
      id: "rebuild-lifeops-knowledge-structure",
      name: "Rebuild LifeOps knowledge structure",
      callback: () => this.rebuildKnowledgeStructure()
    });
    this.addCommand({
      id: "test-lifeops-retrieval",
      name: "Test LifeOps retrieval",
      callback: () => this.testRetrieval()
    });
    this.addCommand({
      id: "accept-punishments",
      name: "确认 LifeOps 复盘提醒",
      callback: () => this.acceptPunishments()
    });
  }

  private isLifecycleCurrent(generation: number): boolean {
    return !this.unloaded && this.lifecycleGeneration === generation;
  }

  private bootstrapDataFoundation(issues?: ReleaseLoadIssue[]): Promise<void> {
    if (this.unloaded) return Promise.resolve();
    if (this.dataFoundationBootstrap) return this.dataFoundationBootstrap;
    const pending = this.initializeDataFoundation(this.lifecycleGeneration, issues).finally(() => {
      if (this.dataFoundationBootstrap === pending) this.dataFoundationBootstrap = null;
    });
    this.dataFoundationBootstrap = pending;
    return pending;
  }

  private async initializeDataFoundation(generation: number, issues?: ReleaseLoadIssue[]): Promise<void> {
    await this.store.initializeVault();
    if (!this.isLifecycleCurrent(generation)) return;
    const assertMigrationCurrent = () => {
      if (!this.isLifecycleCurrent(generation)) throw Error("插件已关闭，数据迁移已停止。");
    };
    await migrateM1Fields(this.store as unknown as StoreHost, assertMigrationCurrent);
    if (!this.isLifecycleCurrent(generation)) return;
    await migrateTradingHistory(this.store as unknown as StoreHost, assertMigrationCurrent);
    if (!this.isLifecycleCurrent(generation)) return;
    if (!this.dataFoundationEventsRegistered) {
      this.registerVaultSourceEvents();
      subscribeLearningNotes(this.localOperationHost(), this.store as unknown as StoreHost, this.lifeOpsEvents,
        () => this.isLifecycleCurrent(generation));
      subscribeReadingNotes(this.localOperationHost(), this.store as unknown as StoreHost, this.lifeOpsEvents,
        (messages, options) => this.observeProvider("reading_index", "unknown", (request, store) =>
          new LifeOpsAi(settingsForAgentModel(store.settings, "fast")).generateFastJson(messages, { ...options, ...request }), options.signal),
        () => this.isLifecycleCurrent(generation));
      this.dataFoundationEventsRegistered = true;
    }
    await this.store.syncVaultSources();
    if (!this.isLifecycleCurrent(generation)) return;
    this.journalSignals ??= new JournalSignalLifecycle(
      () => this.store as unknown as StoreHost, this.lifeOpsEvents,
      (messages, options) => this.observeProvider("daily_review", "unknown", (request, store) =>
        new LifeOpsAi(settingsForAgentModel(store.settings, "fast")).extractJournalSignals(messages, { ...options, ...request }), options.signal)
    );
    this.journalSignals.start();
    this.habitPunishments ??= new HabitPunishmentLifecycle((now, current) => {
      const store = this.store;
      return habitService.runScheduledPunishmentCheck(this.localOperationHost(), store as unknown as StoreHost, now, () => {
        current();
        if (store !== this.store) throw Error("习惯设置已变化，本次判定已停止。");
      });
    });
    this.habitPunishments.start();
    await this.updateStatusBar(issues);
  }

  onunload(): void {
    this.noteUnderstandingUpdates?.close(); this.noteUnderstandingUpdates = null;
    this.projectJobRunner?.stopForHostUnload();
    this.projectJobRunner = null;
    this.taskPlanReviews?.clear();
    this.taskPlanReviews = null;
    this.unloaded = true;
    this.lifecycleGeneration += 1;
    this.dataFoundationBootstrap = null;
    this.dataFoundationEventsRegistered = false;
    for (const request of this.activeProviderRequests ?? []) request.controller.abort("plugin unloaded");
    for (const request of this.activeVoiceRequests ?? []) request.abort("plugin unloaded");
    clearJournalPresentation(this.app);
    window.clearTimeout(this.personalMemoryExpiryTimer);
    window.clearTimeout(this.personalMemorySourceRefreshTimer);
    setProviderEgressSink(null);
    for (const timer of this.sourceChangeTimers.values()) window.clearTimeout(timer);
    this.sourceChangeTimers.clear();
    this.proactiveLifecycle.stop();
    this.journalSignals?.stop();
    this.journalSignals = undefined;
    this.habitPunishments?.stop();
    this.habitPunishments = undefined;
    this.phoneInbox?.stop();
    this.phoneInbox = undefined;
    this.lifeOpsEvents.clear();
    this.styleEl?.remove();
    this.app.workspace.detachLeavesOfType(LIFEOPS_VIEW_TYPE);
  }

  async loadSettings(): Promise<void> {
    const generation = this.lifecycleGeneration;
    const saved = await this.loadData();
    if (!this.isLifecycleCurrent(generation)) return;
    this.settings = mergeSettings(DEFAULT_SETTINGS, saved ?? {});
    this.settings.setupComplete = saved?.setupComplete ?? Boolean(saved?.folders);
    this.savedVoiceSettingsRevision = voiceSettingsRevision(this.settings);
  }

  async saveSettings(options?: { onPersisted?: () => void }): Promise<void> {
    const generation = this.lifecycleGeneration;
    if (!this.isLifecycleCurrent(generation)) return;
    for (const request of this.activeProviderRequests ?? []) {
      if (request.revision !== this.finiteProviderRevision(request.stage)) request.controller.abort("provider settings changed");
    }
    const nextVoiceRevision = voiceSettingsRevision(this.settings);
    if (nextVoiceRevision !== this.savedVoiceSettingsRevision) {
      // Revoke before the first await, including when persisting the new settings later fails.
      this.savedVoiceSettingsRevision = nextVoiceRevision;
      for (const request of this.activeVoiceRequests ?? []) request.abort("voice settings changed");
      for (const leaf of this.app.workspace.getLeavesOfType(LIFEOPS_VIEW_TYPE)) {
        if (leaf.view instanceof LifeOpsView) leaf.view.invalidateVoiceSettings();
      }
    }
    this.proactiveLifecycle.setEnabled(this.settings.proactive.enabled);
    await this.saveData(this.settings);
    options?.onPersisted?.();
    if (!this.isLifecycleCurrent(generation)) return;
    await this.hardenPluginDataPermissions();
    if (!this.isLifecycleCurrent(generation)) return;
    this.store = new LifeOpsStore(this.app, this.settings);
    setProviderEgressSink((record) => this.store.appendProviderEgressAudit(record));
    this.ai = new LifeOpsAi(this.settings);
    this.journalSignals?.restart();
    this.phoneInbox?.schedule();
    await this.updateStatusBar();
  }

  private async hardenPluginDataPermissions(issues?: ReleaseLoadIssue[]): Promise<void> {
    if (!Platform.isDesktopApp || !this.manifest.dir) return;
    const adapter = this.app.vault.adapter as typeof this.app.vault.adapter & {
      getFullPath?: (path: string) => string;
    };
    if (typeof adapter.getFullPath !== "function") return;
    const dataPath = adapter.getFullPath(`${this.manifest.dir}/data.json`);
    try {
      await restrictCredentialFilePermissions(dataPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      issues?.push("settingsPermissions");
      console.error("LifeOps could not restrict plugin data.json permissions to the current macOS user.");
    }
  }

  private registerVaultSourceEvents(): void {
    this.registerEvent(this.app.vault.on("create", (file) => {
      if (file instanceof TFolder) this.queuePersonalMemorySourceRefresh(file.path, true);
      if (file instanceof TFile) {
        this.queuePersonalMemorySourceRefresh(file.path);
        this.markJournalReviewSignal(file.path);
        this.lifeOpsEvents.publish({
          type: "vault.created",
          source: "vault",
          payload: { path: file.path }
        });
        this.queueVaultSourceUpsert(file.path);
      }
    }));
    this.registerEvent(this.app.vault.on("modify", (file) => {
      if (file instanceof TFile) {
        this.queuePersonalMemorySourceRefresh(file.path);
        this.markJournalReviewSignal(file.path);
        this.lifeOpsEvents.publish({
          type: "vault.modified",
          source: "vault",
          payload: { path: file.path }
        });
        this.queueVaultSourceUpsert(file.path);
      }
    }));
    this.registerEvent(this.app.vault.on("delete", (file) => {
      this.queuePersonalMemorySourceRefresh(file.path, file instanceof TFolder);
      if (!(file instanceof TFile) || !this.store.isManagedSourcePath(file.path)) return;
      this.lifeOpsEvents.publish({
        type: "vault.deleted",
        source: "vault",
        payload: { path: file.path }
      });
      this.clearVaultSourceTimer(file.path);
      void this.store.removeVaultSource(file.path).catch((error) => {
        console.error("LifeOps failed to remove deleted Vault source", error);
      });
    }));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      this.queuePersonalMemorySourceRefresh(oldPath, file instanceof TFolder);
      this.queuePersonalMemorySourceRefresh(file.path, file instanceof TFolder);
      if (!(file instanceof TFile)) return;
      this.clearVaultSourceTimer(oldPath);
      this.clearVaultSourceTimer(file.path);
      const managed = this.store.isManagedSourcePath(oldPath) || this.store.isManagedSourcePath(file.path);
      if (!managed && file.path !== PHONE_INBOX_PATH) return;
      this.lifeOpsEvents.publish({
        type: "vault.renamed",
        source: "vault",
        payload: { oldPath, path: file.path }
      });
      if (!managed) return;
      void this.store.renameVaultSource(oldPath, file.path).catch((error) => {
        console.error("LifeOps failed to rename Vault source", error);
      });
    }));
  }

  private queueVaultSourceUpsert(path: string): void {
    if (!this.store.isManagedSourcePath(path)) return;
    this.clearVaultSourceTimer(path);
    const timer = window.setTimeout(() => {
      this.sourceChangeTimers.delete(path);
      void this.store.upsertVaultSource(path).catch((error) => {
        console.error("LifeOps failed to update Vault source", error);
      });
    }, 500);
    this.sourceChangeTimers.set(path, timer);
  }

  private clearVaultSourceTimer(path: string): void {
    const timer = this.sourceChangeTimers.get(path);
    if (timer !== undefined) window.clearTimeout(timer);
    this.sourceChangeTimers.delete(path);
  }

  async activateView(openInMain = false): Promise<void> {
    if (openInMain) {
      // Keep the native tab group alive if its only leaf is the old LifeOps view.
      const leaf = this.app.workspace.getLeaf(true);
      this.app.workspace.detachLeavesOfType(LIFEOPS_VIEW_TYPE);
      await leaf.setViewState({
        type: LIFEOPS_VIEW_TYPE,
        active: true
      });
      return;
    }

    const leaves = this.app.workspace.getLeavesOfType(LIFEOPS_VIEW_TYPE);
    if (leaves.length === 0) {
      await this.app.workspace.getLeaf(true).setViewState({
        type: LIFEOPS_VIEW_TYPE,
        active: true
      });
    }
    const leaf = this.app.workspace.getLeavesOfType(LIFEOPS_VIEW_TYPE)[0];
    if (leaf) {
      this.app.workspace.revealLeaf(leaf);
    }
  }

  openQuickCapture(): void {
    new QuickCaptureModal(this.app, async (value) => {
      await this.capture(value.content, "obsidian", {
        date: value.date,
        kind: value.kind === "auto" ? undefined : value.kind
      });
    }, async (audio) => this.transcribeAgentAudio(audio)).open();
  }

  openLocalRecordPicker(): void {
    return journalService.openLocalRecordPicker.call(this as unknown as journalService.JournalHost);
  }

  createRecordLibrary(): ReadonlyRecordLibrary {
    return journalService.createRecordLibrary.call(this as unknown as journalService.JournalHost);
  }

  async openLocalRecordNote(kind: LocalRecordKind, date = todayString(), isCurrent: () => boolean = () => true): Promise<void> {
    return journalService.openLocalRecordNote.call(this as unknown as journalService.JournalHost, kind, date, isCurrent);
  }

  openTaskModal(): void {
    return taskService.openTaskModal.call(this);
  }

  openProjectBoard(): void { new ProjectBoardModal(this.app, this).open(); }
  openProjectTaskPlan(projectId = "", onChanged?: () => Promise<void>): void {
    if (this.unloaded) return;
    new ProjectJobModal(this.app, this.getProjectJobRunner(), undefined, projectId, onChanged).open();
  }
  private getProjectJobRunner(): ProjectJobRunner {
    if (this.unloaded) throw new Error("插件已关闭，请重开后检查安排。");
    if (!this.projectJobRunner) {
      const generation = this.lifecycleGeneration;
      this.projectJobRunner = new ProjectJobRunner(this.store as unknown as StoreHost, this.createAgentRuntime(), () => new Date(), () => {
        if (this.unloaded || this.lifecycleGeneration !== generation) throw new Error("插件已关闭，安排已停止；重开后先检查再恢复。");
      });
    }
    return this.projectJobRunner;
  }
  private getTaskPlanReviews(): TaskPlanReviewRegistry {
    if (this.unloaded) throw new Error("插件已关闭，请重新提出安排。");
    if (!this.taskPlanReviews) {
      const generation = this.lifecycleGeneration;
      this.taskPlanReviews = new TaskPlanReviewRegistry(this.store as unknown as StoreHost, () => this.getProjectJobRunner(), () => {
        if (this.unloaded || this.lifecycleGeneration !== generation) throw new Error("旧安排卡已失效，请重新提出并核对。");
      });
    }
    return this.taskPlanReviews;
  }

  async getProjectSnapshot(): Promise<ProjectSnapshot> { return this.store.getProjectSnapshot(); }
  openTradingResearch():void {
    const host=this.store as unknown as StoreHost;
    new TradingResearchBoard(this.app,{
      ownModal:modal=>this.register(()=>modal.close()),
      getSnapshot:async()=>{
        if(this.unloaded)throw new Error("插件已关闭，请重新打开交易记录。");
        const before=await tradingContextRevision(host),snapshot=await this.store.getTradingSnapshot();
        if(await tradingContextRevision(host)!==before)throw new Error("交易资料变化，请重新打开。");
        return {...snapshot,contextRevision:before};
      },
      prepare:async(command,expectedContext,assertFormCurrent)=>{
        if(await tradingContextRevision(host)!==expectedContext)throw new Error("表单所依据的交易资料已变化，请重新打开后核对。");
        const generation=this.lifecycleGeneration;
        return prepareTradingAction(command,{store:host,refreshViews:()=>this.refreshViews(),assertCurrent:()=>{
          assertFormCurrent?.();
          if(this.unloaded||this.lifecycleGeneration!==generation)throw new Error("本次窗口已关闭，未继续保存交易记录。");
        }},newLocalOperationId("trading_review"));
      },
      confirm:action=>this.executeAgentAction(action),openSource:path=>this.openProjectSource(path)
    }).open();
  }

  async saveProjectCommand(command: ProjectCommand, expectedRevision: string, operationId: string): Promise<string> {
    if (this.unloaded) throw new Error("插件已关闭，请重新打开后再保存。");
    const submitted = structuredClone(command);
    const generation = this.lifecycleGeneration;
    let targetId = "";
    let resultGuard: import("./projectTools").ProjectTaskResultGuard | undefined;
    const result = await this.createAgentRuntime().executeLocalOperation("local_project_change", { command: submitted, expectedRevision }, async scope => {
      resultGuard = await prepareProjectTaskResultGuard(this.store as unknown as StoreHost, submitted, operationId);
      targetId = await scope.applyProjectCommand(submitted, expectedRevision, operationId);
    }, operationId, { assertCurrent: () => {
      if (this.unloaded || this.lifecycleGeneration !== generation) throw new Error("本次窗口已关闭，已停止继续保存。");
      resultGuard?.assertPolicy();
    }, assertBeforeCommit: submitted.kind === "record_task_result" ? async () => { await resultGuard?.(); } : undefined });
    if (!result.success) throw new Error(result.output);
    return targetId;
  }

  async openProjectSource(path: string): Promise<void> {
    const store = this.store as unknown as StoreHost;
    if (!store.isManagedSourcePath(path)) throw new Error("这份原文不在当前可读取的资料范围内。");
    const file = this.store.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error("原文暂时不可用，项目记录仍已保留。");
    await this.app.workspace.getLeaf(false).openFile(file, { state: { mode: "preview" } });
  }

  openTaskModalWithDefaults(defaults: Partial<LifeOpsTaskInput>): void {
    return taskService.openTaskModalWithDefaults.call(this, defaults);
  }

  openTaskEditModal(task: LifeOpsTask): void {
    return taskService.openTaskEditModal.call(this, task);
  }

  openTaskActionsModal(task: LifeOpsTask): void {
    return taskService.openTaskActionsModal.call(this, task);
  }

  openHabitModal(): void {
    return habitService.openHabitModal.call(this);
  }

  openHabitEditModal(habit: HabitDefinition): void {
    return habitService.openHabitEditModal.call(this, habit);
  }

  openHabitDetailModal(item: HabitDashboardItem): void {
    return habitService.openHabitDetailModal.call(this, item);
  }

  openHabitCheckinModal(habit: HabitDefinition, defaults: { status?: HabitCheckinStatus; date?: string; note?: string } = {}): void {
    return habitService.openHabitCheckinModal.call({ app: this.app, ...this.localOperationHost() }, habit, defaults);
  }

  openHealthEntryModal(): void {
    new HealthEntryModal(this.app, async (entry) => {
      await this.saveLocalOperation("local_appendHealthEntry", { arguments: [cleanHealthEntry(entry)] }, store => store.appendHealthEntry(cleanHealthEntry(entry)));
      await this.refreshViews();
      new Notice("LifeOps 已保存健康记录");
    }).open();
  }

  openTradeEntryModal(): void {
    void openTradeForm(this as unknown as TradeFormHost).catch(error => new Notice(error instanceof Error ? error.message : "交易表单无法打开。"));
  }

  openTradeEditModal(id: string): Promise<void> {
    return openTradeForm(this as unknown as TradeFormHost, id);
  }

  openCalendarNoteModal(date: string): void {
    return journalService.openCalendarNoteModal.call(this as unknown as journalService.JournalHost, date);
  }

  async capture(raw: string, source: string, options: { date?: string; kind?: CaptureKind; signal?: AbortSignal } = {}): Promise<void> {
    await this.observeProvider("classification", "text", async (request, _store, ai, current, onCommitted) => {
      const fallback = options.kind ? manualClassification(raw, options.kind, options.date ?? undefined, source) : classifyByRules(raw, source, options.date);
      const classified = options.kind ? fallback : await ai.classify(raw, fallback, request);
      current();
      await this.saveLocalOperation("local_recordClassifiedInput", { arguments: [{ ...classified, source }] }, async store => {
        current(); await store.recordClassifiedInput({ ...classified, source }); current();
      }, { assertCurrent: current, onCommitted });
      await this.refreshViews();
      new Notice(captureSavedMessage(classified));
    }, options.signal);
  }

  async submitAgentMessage(message: string, history: AgentConversationMessage[] = [], options: AgentSubmissionOptions = {}): Promise<AgentResponse> {
    return this.submitAgentMessageStream(message, history, undefined, options);
  }

  async submitAgentMessageStream(
    message: string,
    history: AgentConversationMessage[] = [],
    onText: (content: string) => void = () => undefined,
    options: AgentSubmissionOptions = {}
  ): Promise<AgentResponse> {
    if (options.source !== "voice") return runAgentTurn.call(this as unknown as AgentTurnHost, message, history, onText, options);
    const request = new AbortController();
    const abort = () => request.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    (this.activeVoiceRequests ??= new Set()).add(request);
    try {
      return await runAgentTurn.call(this as unknown as AgentTurnHost, message, history, onText, { ...options, signal: request.signal });
    } finally {
      this.activeVoiceRequests.delete(request);
      options.signal?.removeEventListener("abort", abort);
    }
  }

  async appendQualityLog(entry: QualityLogEntry): Promise<void> {
    await this.store.appendQualityLog(entry);
  }

  hasPhoneInbox(): boolean { return this.phoneInbox?.enabled === true; }

  openPhoneInbox(): void {
    if (!this.phoneInbox) return;
    const modal = new PhoneInboxModal(this.app, this.phoneInbox);
    this.register(() => modal.close());
    modal.open();
  }

  async appendAgentActionReceipt(title: string, receipt: string): Promise<boolean> {
    return agentService.appendAgentActionReceipt.call(this as unknown as agentService.AgentHost, title, receipt);
  }

  async appendAgentConversation(userMessage: string, assistantReply: string, isCurrent: () => boolean = () => true): Promise<void> {
    return agentService.appendAgentConversation.call(this as unknown as agentService.AgentHost, userMessage, assistantReply, isCurrent);
  }

  async buildAgentInjectedContextBlock(): Promise<string> {
    return (await buildResidentContext(this.store as unknown as StoreHost, "", new Date())).text;
  }

  async collectVoiceSessionHotwords(configured: string | undefined): Promise<string[]> {
    const { collectSessionHotwords } = await import("./voice/sessionHotwords");
    return collectSessionHotwords(this.store as unknown as StoreHost, configured);
  }

  openTradeScreenshotImport(image?: File): void {
    openTradeScreenshotImport(this as unknown as TradeScreenshotHost, image);
  }

  async buildVoiceSessionContextBlock(): Promise<string> {
    return (await buildResidentContext(this.store as unknown as StoreHost, "", new Date(), "voice")).text;
  }

  async appendVoiceMetric(entry: VoiceMetricEntry): Promise<void> {
    await this.store.appendVoiceMetric(entry);
  }

  private async runVoiceRuntimeSelfTestCommand(): Promise<void> {
    const report = runVoiceRuntimeSelfTest();
    const path = await this.store.writeVoiceRuntimeSelfTestReport(report);
    await this.store.appendQualityLog({
      inputSource: "voice",
      captureMode: "self-test",
      actionSuggestions: 0,
      errorCode: report.ok ? "" : "VOICE_RUNTIME_SELF_TEST_FAILED",
      errorMessage: report.ok ? "" : report.checks.filter((item) => !item.ok).map((item) => `${item.name}: ${item.detail}`).join("; ")
    });
    new Notice(report.ok
      ? `LifeOps 语音运行时自检通过：${path}`
      : `LifeOps 语音运行时自检失败：${path}`);
  }

  private async runVoiceAgentSelfTestCommand(): Promise<void> {
    const report = await runVoiceAgentSelfTest(
      (message, history, onText) => this.submitAgentMessageStream(message, history, onText, {
        source: "voice",
        selfTest: true
      })
    );
    const path = await this.store.writeVoiceAgentSelfTestReport(report);
    await this.store.appendQualityLog({
      inputSource: "voice",
      captureMode: "agent-self-test",
      actionSuggestions: report.cases.reduce((sum, item) => sum + item.actions, 0),
      errorCode: report.ok ? "" : "VOICE_AGENT_SELF_TEST_FAILED",
      errorMessage: report.ok ? "" : report.cases.filter((item) => !item.ok).map((item) => `${item.name}: ${item.failures.join(", ")}`).join("; ")
    });
    new Notice(report.ok
      ? `LifeOps 语音 Agent 自检通过：${path}`
      : `LifeOps 语音 Agent 自检失败：${path}`);
  }

  private async writeWorkflowCatalog(): Promise<void> {
    return reviewService.writeWorkflowCatalog.call(this as unknown as reviewService.ReviewHost);
  }

  private async createWorkflowRunDraft(id: LifeOpsWorkflowId): Promise<void> {
    return reviewService.createWorkflowRunDraft.call(this as unknown as reviewService.ReviewHost, id);
  }

  private async generateWeeklySummary(): Promise<void> {
    return summaryService.openPeriodSummary(this as unknown as summaryService.SummaryHost, "week");
  }

  openUnderstandingUpdates(path?: string): void {
    return reviewService.openUnderstandingUpdates.call(this as unknown as reviewService.ReviewHost, path);
  }

  private async generateProactiveCandidates(): Promise<void> {
    return reviewService.generateProactiveCandidateReport.call(this as unknown as reviewService.ReviewHost);
  }

  private async createProactiveCandidatePreview(limit = 3, force = false): Promise<ProactiveCandidate[]> {
    return reviewService.createProactiveCandidatePreview.call(this as unknown as reviewService.ReviewHost, limit, force);
  }

  private markJournalReviewSignal(path: string): void {
    return reviewService.markJournalReviewSignal.call(this as unknown as reviewService.ReviewHost, path);
  }

  private async runProactiveCycle(): Promise<void> {
    return reviewService.runProactiveCycle.call(this as unknown as reviewService.ReviewHost);
  }

  private dispatchProactiveCandidate(candidate: ProactiveCandidate): void {
    return reviewService.dispatchProactiveCandidate.call(this as unknown as reviewService.ReviewHost, candidate);
  }

  private async openPersonalMemoryReview(): Promise<void> {
    return memoryService.openPersonalMemoryReview.call(this as unknown as memoryService.MemoryHost);
  }

  async getStewardMemories(): Promise<PersonalMemoryRecord[]> {
    return memoryService.getStewardMemories.call(this as unknown as memoryService.MemoryHost);
  }

  async getStewardOperations(): Promise<StewardOperationSummary[]> {
    return memoryService.getStewardOperations.call(this as unknown as memoryService.MemoryHost);
  }

  async openStewardSource(path: string, sourceId?: string): Promise<void> {
    return memoryService.openStewardSource.call(this as unknown as memoryService.MemoryHost, path, sourceId);
  }

  openStewardLearningPlan(): void {
    openLearningPlan(this as unknown as LearningUiHost, "adjust");
  }

  openStewardSummary(path: string): Promise<void> {
    return summaryService.openSummaryNote(this as unknown as summaryService.SummaryHost, path);
  }

  async undoStewardOperation(id: string): Promise<void> {
    return memoryService.undoStewardOperation.call(this as unknown as memoryService.MemoryHost, id);
  }

  async prepareStewardMemoryReview(record: PersonalMemoryRecord, review: PersonalMemoryReview): Promise<AgentActionSuggestion[]> {
    return memoryService.prepareStewardMemoryReview.call(this as unknown as memoryService.MemoryHost, record, review);
  }

  openStewardSettings(): void {
    const settings = (this.app as typeof this.app & { setting?: { open(): void; openTabById(id: string): void } }).setting;
    if (!settings?.open || !settings.openTabById) {
      new Notice("请打开 Obsidian 设置，在第三方插件中选择 LifeOps。当前设置没有修改。");
      return;
    }
    settings.open();
    settings.openTabById(this.manifest.id);
  }

  private async undoLatestLifeOpsOperation(): Promise<void> {
    return memoryService.undoLatestLifeOpsOperation.call(this as unknown as memoryService.MemoryHost);
  }


  async transcribeAgentAudio(audio: Blob, signal?: AbortSignal): Promise<string> {
    const request = new AbortController();
    const abort = () => request.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted || this.unloaded) abort();
    (this.activeVoiceRequests ??= new Set()).add(request);
    try {
      assertProviderActive(request.signal);
      const text = await this.observeProvider("transcription", "voice", (options, _store, ai) => ai.transcribeAudio(audio, undefined, options.signal, options), request.signal);
      assertProviderActive(request.signal);
      return text;
    } finally {
      this.activeVoiceRequests.delete(request);
      signal?.removeEventListener("abort", abort);
    }
  }

  getPluginAssetUrl(relativePath: string): string {
    const adapter = this.app.vault.adapter as typeof this.app.vault.adapter & { getBasePath?: () => string };
    const vaultBasePath = adapter.getBasePath?.();
    const pluginDir = this.manifest.dir;
    if (!vaultBasePath || !pluginDir) throw new Error("无法定位 LifeOps 插件本地资源目录");
    return pluginAssetUrl(path => adapter.getResourcePath(path), pluginDir, relativePath);
  }

  async setAgentSpeakReplies(value: boolean): Promise<void> {
    this.settings.realtimeVoice.speakReplies = value;
    await this.saveSettings();
  }

  private async executeToolCalls(
    toolCalls: AiToolCall[],
    userMessage: string,
    signal?: AbortSignal,
    beforeToolCall?: (call:Readonly<AiToolCall>) => Promise<void>,
    afterToolCall?: (call: Readonly<AiToolCall>, result: ToolCallResult, results: ToolCallResult[]) => Promise<void>,
    sourcePaths: readonly string[] = [],
    assertPlanInputsCurrent?: () => Promise<void>,
    onQueryRead?: (result:ToolCallResult,read:VaultQueryRead)=>void,
    previousQuery?: VaultQueryRead,
    assertWriteCurrent?: () => void
  ): Promise<AgentToolExecutionResult> {
    return agentService.executeToolCalls.call(this as unknown as agentService.AgentHost, toolCalls, userMessage, signal, beforeToolCall, afterToolCall, sourcePaths, assertPlanInputsCurrent, onQueryRead, previousQuery, assertWriteCurrent);
  }

  async executeAgentToolCall(toolCall: AiToolCall, userMessage = "", assertCurrent?: () => void,
    onRealtimeOutput?: (output:RealtimeToolOutput)=>void, assertPriorQuery?: () => Promise<void>,
    onSuccessfulQuery?: () => void): Promise<AgentResponse> {
    return agentService.executeAgentToolCall.call(this as unknown as agentService.AgentHost, toolCall, userMessage, assertCurrent, onRealtimeOutput, assertPriorQuery, onSuccessfulQuery);
  }

  async assertAgentActionDeliverable(action: AgentActionSuggestion, assertCurrent?: () => void,
    beforeFinalCheck?:()=>Promise<void>): Promise<void> {
    return agentService.assertAgentActionDeliverable.call(this as unknown as agentService.AgentHost, action, assertCurrent, beforeFinalCheck);
  }

  private createAgentRuntime(sourcePaths: readonly string[] = [], assertPlanInputsCurrent?: () => Promise<void>,
    assertProposalCurrent?: () => void): AgentRuntime {
    return agentService.createAgentRuntime.call(this as unknown as agentService.AgentHost, sourcePaths, assertPlanInputsCurrent, assertProposalCurrent);
  }

  private async saveLocalOperation(name: string, args: Record<string, unknown>, execute: (store: StoreHost) => Promise<unknown>, options?: FactOperationOptions): Promise<void> {
    return agentService.saveLocalOperation.call(this as unknown as agentService.AgentHost, name, args, execute, options);
  }

  /** Explicit single-file maintenance only. No startup hook, batch, or model tool. */
  async normalizeLegacyJournalLayout(path: string, expectedHash: string): Promise<{
    path: string; operationId: string; changed: boolean; beforeHash: string; afterHash: string; removedPrefixBytes: number;
  }> {
    return journalService.normalizeLegacyJournalLayout.call(this as unknown as journalService.JournalHost, path, expectedHash);
  }

  private async recordConversationMemory(userMessage: string, assistantReply: string, injectedContext: InjectedContext, isCurrent: () => boolean = () => true): Promise<void> {
    return memoryService.recordAgentConversationMemory.call(this as unknown as memoryService.MemoryHost, userMessage, assistantReply, injectedContext, isCurrent);
  }

  dismissAgentAction(action: AgentActionSuggestion): void {
    return agentService.dismissAgentAction.call(this as unknown as agentService.AgentHost, action);
  }
  async executeAgentAction(action: AgentActionSuggestion): Promise<string> {
    return agentService.executeAgentAction.call(this as unknown as agentService.AgentHost, action);
  }

  async recordHabit(habit: HabitDefinition): Promise<void> {
    return habitService.recordHabit.call(this.localOperationHost(), habit);
  }

  async recognizeTradeScreenshot(image: TradeScreenshot, signal: AbortSignal) {
    return this.observeProvider("vision", "text", (options, store, _ai, current) =>
      runTradeScreenshotVision(store.settings, image, options, current), signal);
  }

  async recordHabitStatus(habitId: string, status: HabitCheckinStatus, date?: string, note = ""): Promise<void> {
    return habitService.recordHabitStatus.call(this.localOperationHost(), habitId, status, date, note);
  }

  async clearHabitCheckin(habitId: string, date?: string): Promise<void> {
    return habitService.clearHabitCheckin.call(this.localOperationHost(), habitId, date);
  }

  private localOperationHost(): LocalOperationHost {
    return {
      saveLocalOperation: (name, args, execute, options) => this.saveLocalOperation(name, args, execute, options),
      refreshViews: () => this.refreshViews(),
      onTaskOverload: (taskId, reason) => this.queueTaskOverload(taskId, reason)
    };
  }

  private queueTaskOverload(taskId: string, reason: string): void {
    queueTaskOverload(this as unknown as reviewService.ReviewHost, taskId, reason);
  }

  async createTask(task: LifeOpsTaskInput): Promise<void> {
    return taskService.createTask.call(this.localOperationHost(), task);
  }

  async updateTask(taskId: string, task: LifeOpsTaskInput, expectedRevision?: string): Promise<void> {
    return taskService.updateTask.call(this.localOperationHost(), taskId, task, expectedRevision);
  }

  async deleteTask(taskId: string): Promise<void> {
    return taskService.deleteTask.call(this.localOperationHost(), taskId);
  }

  async postponeTask(taskId: string, days: number): Promise<void> {
    return taskService.postponeTask.call(this.localOperationHost(), taskId, days);
  }

  async postponeTasks(taskIds: string[], days: number): Promise<void> {
    return taskService.postponeTasks.call(this.localOperationHost(), taskIds, days);
  }

  async skipRepeatedTask(taskId: string): Promise<void> {
    return taskService.skipRepeatedTask.call(this.localOperationHost(), taskId);
  }

  async moveTaskToDate(taskId: string, date: string): Promise<void> {
    return taskService.moveTaskToDate.call(this.localOperationHost(), taskId, date);
  }

  async duplicateTaskToDate(taskId: string, date: string): Promise<void> {
    return taskService.duplicateTaskToDate.call(this.localOperationHost(), taskId, date);
  }

  async moveTaskOrder(taskId: string, direction: "up" | "down"): Promise<void> {
    return taskService.moveTaskOrder.call(this.localOperationHost(), taskId, direction);
  }

  async createHabit(habit: HabitInput): Promise<void> {
    return habitService.createHabit.call(this.localOperationHost(), habit);
  }

  async updateHabit(habitId: string, habit: HabitInput, expectedRevision?: string): Promise<void> {
    return habitService.updateHabit.call(this.localOperationHost(), habitId, habit, expectedRevision);
  }

  async deleteHabit(habitId: string): Promise<void> {
    return habitService.deleteHabit.call(this.localOperationHost(), habitId);
  }

  async completeTask(taskId: string, note = ""): Promise<void> {
    return taskService.completeTask.call(this.localOperationHost(), taskId, note);
  }

  async completeTaskAndLog(taskId: string, note = ""): Promise<void> {
    return taskService.completeTaskAndLog.call(this.localOperationHost(), taskId, note);
  }

  async abandonTask(taskId: string): Promise<void> {
    return taskService.abandonTask.call(this.localOperationHost(), taskId);
  }

  async moveTaskToQuadrant(taskId: string, quadrant: LifeOpsTaskQuadrant): Promise<void> {
    return taskService.moveTaskToQuadrant.call(this.localOperationHost(), taskId, quadrant);
  }

  async generateDailyReview(signal?: AbortSignal): Promise<void> {
    return summaryService.openPeriodSummary(this as unknown as summaryService.SummaryHost, "day", signal);
  }

  async generateTradingReview(signal?: AbortSignal, period?: TradeReviewPeriod): Promise<void> {
    return reviewService.generateTradingReview.call(this as unknown as reviewService.ReviewHost, signal, period);
  }

  async rebuildVaultIndex(): Promise<void> {
    const result = await this.store.rebuildVaultIndex();
    const vector = await this.rebuildVectorIndexIfEnabled();
    new Notice(vector
      ? `LifeOps 已索引 ${result.indexedFiles}/${result.totalMarkdownFiles} 个 Markdown 文件，向量 ${vector.indexedFiles} 个（新增 ${vector.generatedFiles}，复用 ${vector.reusedFiles}）`
      : `LifeOps 已索引 ${result.indexedFiles}/${result.totalMarkdownFiles} 个 Markdown 文件`);
  }

  async syncDataFoundation(): Promise<void> {
    const result = await this.store.syncVaultSources();
    new Notice(
      `LifeOps 数据底座已同步：更新 ${result.addedOrChanged}，删除 ${result.deleted}，未变化 ${result.unchanged}`
    );
  }

  async rebuildKnowledgeStructure(): Promise<void> {
    const result = await this.store.rebuildKnowledgeStructure();
    new Notice(`LifeOps 知识结构已重建：${result.chunks} 个分块，${result.nodes} 个节点，${result.edges} 条关系`);
  }

  async testRetrieval(): Promise<void> {
    const query = "最近交易复盘和任务状态";
    const semantic = await this.buildSemanticContext(query);
    const keyword = await this.store.buildRetrievalContext(query, 5);
    const knowledge = await this.store.buildKnowledgeContext(query);
    const context = [semantic, keyword, knowledge].filter(Boolean).join("\n\n");
    const reportPath = await this.store.createRetrievalDebugReport(query, { semantic, keyword, knowledge });
    new Notice(context ? `LifeOps 检索测试成功：${context.length} 字符，报告已写入 ${reportPath}` : `LifeOps 检索测试没有命中，报告已写入 ${reportPath}`);
  }

  private async buildSemanticContext(query: string, signal?: AbortSignal, record?: ContextSourceRecorder): Promise<string> {
    const embedding = { ...this.settings.embedding };
    if (embedding.provider === "off" || !embedding.endpoint || !embedding.model) return "";
    return this.observeProvider("embedding", "text", async (options, store, ai, current) => {
      try {
        const vector = await ai.getEmbedding(query, options);
        current();
        const result = await store.buildSemanticContext(vector, embedding.topK, record);
        current(); return result;
      } catch (error) {
        current();
        options.onLocalFallback?.(error instanceof ProviderRunFailure ? error.code : "local_error");
        return "";
      }
    }, signal);
  }

  private async rebuildVectorIndexIfEnabled(signal?: AbortSignal): Promise<{ indexedFiles: number; reusedFiles: number; generatedFiles: number } | null> {
    const embedding = { ...this.settings.embedding };
    if (embedding.provider === "off" || !embedding.endpoint || !embedding.model) return null;
    return this.observeProvider("embedding", "unknown", async (options, store, ai, current, onCommitted) => {
      current();
      return store.rebuildVectorIndex(embedding.model, async input => {
        current();
        const result = await this.observeProvider("embedding", "unknown", request => ai.getEmbedding(input, request), options.signal);
        current(); return result;
      }, current, onCommitted);
    }, signal);
  }

  async acceptPunishments(): Promise<void> {
    return habitService.acceptPunishments.call(this.localOperationHost());
  }

  private personalMemoryExpiryTimer = 0;
  private personalMemorySourceRefreshTimer = 0;
  private personalMemorySourcePaths = new Set<string>();

  private queuePersonalMemorySourceRefresh(path: string, includeDescendants = false): void {
    return memoryService.queuePersonalMemorySourceRefresh.call(this as unknown as memoryService.MemoryHost, path, includeDescendants);
  }

  private schedulePersonalMemoryExpiry(records: PersonalMemoryRecord[]): void {
    return memoryService.schedulePersonalMemoryExpiry.call(this as unknown as memoryService.MemoryHost, records);
  }

  async refreshViews(): Promise<void> {
    const memoryRecords = await readPersonalMemoryWithSources(this.store as unknown as StoreHost).then(document => document.records).catch(() => null);
    this.schedulePersonalMemoryExpiry(memoryRecords ?? []);
    for (const leaf of this.app.workspace.getLeavesOfType(LIFEOPS_VIEW_TYPE)) {
      const view = leaf.view;
      if (view instanceof LifeOpsView) {
        await view.render();
      }
    }
    await this.updateStatusBar();
  }

  async getStats(): Promise<DashboardStats> {
    return this.store.getDashboardStats();
  }

  async getTaskDashboard(): Promise<TaskDashboardData> {
    return this.store.getTaskDashboard();
  }

  getTodayCard(board: TaskDashboardData) {
    return todayService.getTodayCard(this.store as unknown as StoreHost, board);
  }

  correctYesterdayHabit(taskId: string): Promise<void> {
    return habitService.confirmYesterdayHabit.call({ app: this.app, ...this.localOperationHost() }, this.store as unknown as StoreHost, taskId);
  }

  addJournalPlanTask(plan: JournalPlanChoice): Promise<void> {
    return todayService.addJournalPlanTask(this.localOperationHost(), this.store as unknown as StoreHost, plan);
  }

  mountIdeaPanel(container: HTMLElement): () => Promise<void> {
    return mountIdeaPanel(this as unknown as IdeaUiHost, container);
  }

  openIdeaCandidates(): void { openIdeaCandidates(this as unknown as IdeaUiHost); }

  mountLearningPanel(container: HTMLElement): () => Promise<void> {
    return mountLearningPanel(this as unknown as LearningUiHost, container);
  }

  async getProactiveCandidates(): Promise<ProactiveCandidate[]> {
    return reviewService.getProactiveCandidates.call(this as unknown as reviewService.ReviewHost);
  }

  async respondToProactiveCandidate(candidateId: string, decision: ProactiveFeedbackDecision): Promise<void> {
    return reviewService.respondToProactiveCandidate.call(this as unknown as reviewService.ReviewHost, candidateId, decision);
  }

  private openHealthCsvImport(): void {
    new CsvImportModal(this.app, async (value) => {
      const entries = parseHealthCsv(value);
      await this.saveLocalOperation("manual_health_csv_batch", { entries }, async store => {
        for (const entry of entries) await store.appendHealthEntry(entry);
      });
      await this.refreshViews();
      new Notice(`LifeOps 已导入 ${entries.length} 条健康记录`);
    }).open();
  }

  private async injectStyles(issues?: ReleaseLoadIssue[]): Promise<void> {
    const generation = this.lifecycleGeneration;
    const path = this.manifest.dir ? `${this.manifest.dir}/styles.css` : `.obsidian/plugins/${this.manifest.id}/styles.css`;
    try {
      const css = await this.app.vault.adapter.read(path);
      if (!this.isLifecycleCurrent(generation)) return;
      this.styleEl?.remove();
      const style = document.createElement("style");
      this.styleEl = style;
      style.id = "lifeops-assistant-styles";
      style.textContent = css;
      document.head.appendChild(style);
      this.register(() => style.remove());
    } catch {
      if (!this.isLifecycleCurrent(generation)) return;
      issues?.push("styles");
      new Notice("LifeOps 样式加载失败，请重新安装插件");
    }
  }

  private async processGatewayInbox(): Promise<void> {
    new Notice("当前私测版不启用外部网关消息处理；原收件箱内容已保留。", 8000);
  }

  private async updateStatusBar(issues?: ReleaseLoadIssue[]): Promise<void> {
    const generation = this.lifecycleGeneration;
    const statusBar = this.statusBar;
    if (!statusBar || !this.isLifecycleCurrent(generation)) return;
    try {
    const stats = await this.store.getDashboardStats();
    if (!this.isLifecycleCurrent(generation)) return;
    const warning = stats.punishmentOpen ? " | 待确认复盘提醒" : "";
    statusBar.setText(`LifeOps: ${stats.todoOpen} 待办 · ${stats.habitDone}/${stats.habitTotal} 打卡${warning}`);
    statusBar.toggleClass("lifeops-warning", stats.punishmentOpen);
    } catch {
      if (!this.isLifecycleCurrent(generation)) return;
      issues?.push("dashboard");
      statusBar.setText("LifeOps | 资料读取需要检查");
      statusBar.toggleClass("lifeops-warning", true);
    }
  }

  private finiteProviderRevision(stage: ProviderStage): string {
    return agentService.finiteProviderRevision.call(this as unknown as agentService.AgentHost, stage);
  }

  private async observeProvider<T>(stage: ProviderStage, inputSource: QualityLogEntry["inputSource"],
    action: (options: ProviderRequestOptions, store: LifeOpsStore, ai: LifeOpsAi, current: () => void, onCommitted: () => void) => Promise<T>, signal?: AbortSignal): Promise<T> {
    return (agentService.observeProvider<T>).call(this as unknown as agentService.AgentHost, stage, inputSource, action, signal);
  }

  private async withAiFallback(action: (options: ProviderRequestOptions) => Promise<string>, fallback: string, options: ProviderRequestOptions = {}): Promise<string> {
    return agentService.withAiFallback.call(this as unknown as agentService.AgentHost, action, fallback, options);
  }

}

function mergeSettings(defaults: LifeOpsSettings, saved: Partial<LifeOpsSettings>): LifeOpsSettings {
  const privacy = {
    excludedVaultPrefixes: saved.privacy?.excludedVaultPrefixes
      ?? defaults.privacy?.excludedVaultPrefixes
      ?? [],
    plaintextCredentialStorageAccepted: saved.privacy?.plaintextCredentialStorageAccepted === true
  };
  const savedRealtimeVoice = saved.realtimeVoice ?? {};
  const realtimeVoice = migrateRealtimeVoiceSettings({
    ...defaults.realtimeVoice,
    ...savedRealtimeVoice,
    plaintextCredentialStorageAccepted: privacy.plaintextCredentialStorageAccepted
  });
  if (realtimeVoice.model === "qwen3.5-omni-plus-realtime") {
    realtimeVoice.model = defaults.realtimeVoice.model;
  }
  const voice = { ...defaults.voice, ...(saved.voice ?? {}) };
  if (voice.provider === "aliyun-tingwu") {
    voice.provider = "off";
    voice.dataDisclosureAccepted = false;
  }
  voice.aliyunAccessKeyId = "";
  voice.aliyunAccessKeySecret = "";
  voice.aliyunAppKey = "";
  const ai = { ...defaults.ai, ...(saved.ai ?? {}) };
  const embedding = { ...defaults.embedding, ...(saved.embedding ?? {}) };
  const vision = { ...defaults.vision, ...(saved.vision ?? {}), cameraEnabled: false, cameraMode: "off" as const, privacyNoticeAccepted: false, screenEnabled: false, screenPrivacyNoticeAccepted: false };
  if (!privacy.plaintextCredentialStorageAccepted) {
    ai.dataDisclosureAccepted = false;
    embedding.dataDisclosureAccepted = false;
    vision.remoteDataDisclosureAccepted = false;
    voice.dataDisclosureAccepted = false;
    realtimeVoice.dataDisclosureAccepted = false;
  }
  return {
    ...defaults,
    ...saved,
    linkedNoteNames: migrateLinkedNoteNames(saved),
    folders: { ...defaults.folders, ...(saved.folders ?? {}) },
    ai,
    embedding,
    vision,
    proactive: { ...defaults.proactive, ...(saved.proactive ?? {}), level: Math.min(3, saved.proactive?.level ?? defaults.proactive.level) as 0 | 1 | 2 | 3, highPriorityVoiceEnabled: false },
    privacy,
    gateway: { ...defaults.gateway, ...(saved.gateway ?? {}), sharedSecret: "" },
    voice,
    realtimeVoice,
    habits: saved.habits && saved.habits.length > 0 ? saved.habits : defaults.habits
  };
}

function manualClassification(raw: string, kind: CaptureKind, date = todayString(), source = "obsidian"): ClassifiedInput {
  const content = raw.trim();
  return {
    kind,
    confidence: 1,
    title: content.slice(0, 40) || captureKindLabel(kind),
    content,
    date,
    raw,
    source,
    reason: "用户在快速记录中手动指定类型"
  };
}

function cleanHealthEntry(entry: HealthEntry): HealthEntry {
  return {
    date: entry.date || todayString(),
    sleepHours: entry.sleepHours,
    weightKg: entry.weightKg,
    steps: entry.steps,
    exercise: entry.exercise?.trim() || undefined,
    fatigue: entry.fatigue,
    energy: entry.energy,
    note: entry.note?.trim() || undefined
  };
}

function normalizeToolMatchText(text: string): string {
  return text.replace(/\s+/g, "").replace(/[，,。.!！?？:：;；、"'“”‘’]/g, "").trim();
}
