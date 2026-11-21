import type LifeOpsPlugin from "../main";
import { Notice } from "obsidian";
import { randomUUID } from "node:crypto";
import { assertProviderActive, awaitProviderActive, providerAbortCode, ProviderRunFailure } from "../providerRun";
import { LifeOpsAi } from "../ai";
import type { AiToolCall } from "../ai";
import { AgentRuntime, toolResultsToAgentExecution } from "../agentRuntime";
import { ensureToolCallId, recordRevision } from "../operationIdentity";
import type { ToolCallResult } from "../agentRuntime";
import { ProjectJobModal } from "../projectJobModal";
import { type TaskPlanReviewAction } from "../taskPlanReviewRegistry";
import { assertProjectConfirmationDeliverable } from "../projectTools";
import { captureProjectToolSnapshot, assertProjectToolSnapshotCurrent } from "../projectToolContinuity";
import { buildInjectedContext } from "../contextInjection";
import type { VaultQueryRead } from "../vaultQueryRead";
import { produceRealtimeToolOutput, disposeRealtimeToolOutput, type RealtimeToolOutput } from "../voice/realtimeToolOutput";
import { todayString } from "../date";
import { type FactOperationOptions } from "../dataFoundation/factOperation";
import { createPersonalMemoryContextFilter } from "../personalMemoryContext";
import { readPersonalMemoryWithSources } from "../personalMemorySources";
import { isVaultPathExcluded } from "../privacy";
import { LifeOpsStore } from "../store";
import type { StoreHost } from "../store/settingsSlice";
import { runConfirmedToolAction, type StructuredJsonRequest } from "../toolRegistry";
import { writeReceipts } from "../writeReceipts";
import { executeConfirmedToolBatch, prepareToolBatch } from "../toolBatch";
import { bindTaskPlanConfirmation } from "../features/tasks/planConfirmation";
import type { AgentActionSuggestion, AgentResponse, QualityLogEntry, ProviderRunResult, ProviderRequestOptions, ProviderStage } from "../types";

export interface AgentHost {
  activeProviderRequests: LifeOpsPlugin["activeProviderRequests"];
  ai: LifeOpsPlugin["ai"];
  app: LifeOpsPlugin["app"];
  createAgentRuntime: LifeOpsPlugin["createAgentRuntime"];
  finiteProviderRevision: LifeOpsPlugin["finiteProviderRevision"];
  getProjectJobRunner: LifeOpsPlugin["getProjectJobRunner"];
  getTaskPlanReviews: LifeOpsPlugin["getTaskPlanReviews"];
  lifecycleGeneration: LifeOpsPlugin["lifecycleGeneration"];
  observeProvider: LifeOpsPlugin["observeProvider"];
  queueTaskOverload: LifeOpsPlugin["queueTaskOverload"];
  recordConversationMemory: LifeOpsPlugin["recordConversationMemory"];
  refreshViews: LifeOpsPlugin["refreshViews"];
  saveLocalOperation: LifeOpsPlugin["saveLocalOperation"];
  savedVoiceSettingsRevision: LifeOpsPlugin["savedVoiceSettingsRevision"];
  settings: LifeOpsPlugin["settings"];
  store: LifeOpsPlugin["store"];
  taskPlanReviews: LifeOpsPlugin["taskPlanReviews"];
  unloaded: LifeOpsPlugin["unloaded"];
}

export interface AgentToolExecutionResult {
  replies: string[];
  actions: AgentActionSuggestion[];
  results: ToolCallResult[];
  projectContextError?: unknown;
}

export async function appendAgentActionReceipt(this: AgentHost, title: string, receipt: string): Promise<boolean> {
    const ownerStore = this.store, store = ownerStore as unknown as StoreHost, generation = this.lifecycleGeneration;
    const policy = JSON.stringify([this.settings.folders, this.settings.privacy]);
    const storePolicy = JSON.stringify([store.settings.folders, store.settings.privacy]);
    const path = store.path(store.settings.folders.aiReports, "Conversations", `${todayString()}.md`);
    const current = () => !this.unloaded && this.lifecycleGeneration === generation && this.store === ownerStore
      && JSON.stringify([this.settings.folders, this.settings.privacy]) === policy
      && JSON.stringify([store.settings.folders, store.settings.privacy]) === storePolicy
      && !isVaultPathExcluded(path, this.settings.privacy?.excludedVaultPrefixes);
    if (!current() || !receipt.trim()) return false;
    const stamp = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    const content = [
      `<!-- lifeops-action-receipt:${randomUUID()} -->`, `## ${stamp} 系统操作回执`, "",
      "> 仅说明当次执行结果；之后可能更正或撤销，不代表当前状态。", "",
      `> 操作：${title.replace(/[\r\n]+/g, " ")}`, "",
      ...receipt.split(/\r\n?|\n/).map(line => `> ${line}`), ""
    ].join("\n");
    await store.appendFile(path, content, current);
    if (!current()) return false;
    const saved = await store.readPath(path);
    return current() && saved.includes(content);
  }

export async function appendAgentConversation(this: AgentHost, userMessage: string, assistantReply: string, isCurrent: () => boolean = () => true): Promise<void> {
    const revision = this.savedVoiceSettingsRevision;
    const current = () => !this.unloaded && isCurrent() && this.savedVoiceSettingsRevision === revision;
    if (!current()) return;
    const storeHost = this.store as unknown as StoreHost;
    await storeHost.appendAgentConversation(userMessage, assistantReply, undefined, current);
    if (!current()) return;
    const injectedContext = await buildInjectedContext(storeHost).catch(() => null);
    if (injectedContext && current()) {
      await this.recordConversationMemory(userMessage, assistantReply, injectedContext, current);
    }
  }

export async function executeToolCalls(this: AgentHost, toolCalls: AiToolCall[], userMessage: string, signal?: AbortSignal, beforeToolCall?: (call:Readonly<AiToolCall>) => Promise<void>, afterToolCall?: (call: Readonly<AiToolCall>, result: ToolCallResult, results: ToolCallResult[]) => Promise<void>, sourcePaths: readonly string[] = [], assertPlanInputsCurrent?: () => Promise<void>, onQueryRead?: (result:ToolCallResult,read:VaultQueryRead)=>void, previousQuery?: VaultQueryRead, assertWriteCurrent?: () => void): Promise<AgentToolExecutionResult> {
    const results: ToolCallResult[] = [];
    const frozenCalls = structuredClone(toolCalls).map(call => ({ ...call, id: ensureToolCallId(call) }));
    const freeze = (value: unknown): void => {
      if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    };
    freeze(frozenCalls);
    if (new Set(frozenCalls.map(call => call.id)).size !== frozenCalls.length) {
      const refused = frozenCalls.map(call => ({ callId: call.id, success: false,
        output: "本轮工具调用编号重复，已停止整批执行，请重新提出安排。", actions: [] }));
      return { ...toolResultsToAgentExecution(refused), results: refused };
    }
    const batch = prepareToolBatch(frozenCalls, 0, userMessage);
    if (batch) {
      await bindTaskPlanConfirmation(this.store as unknown as StoreHost, batch);
      return { ...toolResultsToAgentExecution([batch]), results: [batch] };
    }
    const queries = frozenCalls.filter(call => call.name === "query_vault");
    const planSources = [...new Set([...sourcePaths, ...queries.flatMap(call => typeof call.arguments.path === "string" ? [call.arguments.path.trim()] : []).filter(Boolean)])];
    const containsPlan = frozenCalls.some(call => ["propose_task_plan","propose_project_work_plan"].includes(call.name));
    const queryInputs = containsPlan && queries.length ? await captureProjectToolSnapshot(this.store as unknown as StoreHost, planSources).catch(() => undefined) : undefined;
    const checkPlanInputs = async () => {
      await assertPlanInputsCurrent?.();
      if (queries.some(call => typeof call.arguments.path !== "string" || !call.arguments.path.trim())) {
        throw new Error("这份安排还包含未绑定具体原文的查询，请先读取准确路径，再重新提出完整安排。");
      }
      if (queries.length) {
        if (!queryInputs) throw new Error("查询来源暂时无法核对，未生成安排卡。");
        await assertProjectToolSnapshotCurrent(this.store as unknown as StoreHost, queryInputs);
      }
    };
    const runtime = this.createAgentRuntime(planSources, checkPlanInputs);
    let priorQuery = previousQuery;
    const ownedReads = new Set<VaultQueryRead>();
    const acceptQuery = (result: ToolCallResult, read: VaultQueryRead) => {
      onQueryRead?.(result, read);
      priorQuery = read;
      if (!onQueryRead) ownedReads.add(read);
    };
    const assertPriorQuery = async () => {
      if (!priorQuery) throw new Error("本轮没有成功查询。");
      await priorQuery.assertSourcesCurrent();
      assertProviderActive(signal);
      priorQuery.assertCurrent();
    };
    try {
    for (const toolCall of frozenCalls) {
      assertProviderActive(signal);
      if (beforeToolCall) {
        try { await beforeToolCall(toolCall); }
        catch (projectContextError) {
          if (!results.length) throw projectContextError;
          return { ...toolResultsToAgentExecution(results), results, projectContextError };
        }
      }
      assertProviderActive(signal);
      const result = await runtime.executeAiToolCall(toolCall, "kimi", userMessage,
        { assertCurrent: () => { assertProviderActive(signal); assertWriteCurrent?.(); },
          assertBeforeCommit: assertWriteCurrent && beforeToolCall ? () => beforeToolCall(toolCall) : undefined, signal, assertPriorQuery, onQueryRead: acceptQuery });
      results.push(result);
      if (afterToolCall) {
        try { await afterToolCall(toolCall, result, results); }
        catch (projectContextError) { return { ...toolResultsToAgentExecution(results), results, projectContextError }; }
      }
      assertProviderActive(signal);
    }
    return { ...toolResultsToAgentExecution(results), results };
    } finally { for (const read of ownedReads) read.dispose(); }
  }

export async function executeAgentToolCall(this: AgentHost, toolCall: AiToolCall, userMessage = "", assertCurrent?: () => void, onRealtimeOutput?: (output:RealtimeToolOutput)=>void, assertPriorQuery?: () => Promise<void>, onSuccessfulQuery?: () => void): Promise<AgentResponse> {
    let queryRead:VaultQueryRead|undefined;
    let realtimeOutput:RealtimeToolOutput|undefined, transferred=false;
    try{
    assertCurrent?.();
    toolCall = structuredClone(toolCall);
    const storeHost = this.store as unknown as StoreHost;
    // Authorization and writes always receive the current user's exact words.
    const result = await this.createAgentRuntime([], undefined, assertCurrent).executeAiToolCall(toolCall, "qwen-omni", userMessage,
      {assertCurrent:()=>assertCurrent?.(),assertPriorQuery,onQueryRead:(_result,read)=>{queryRead=read;}});
    const status = result.actions.length ? "等待确认，尚未执行。" : result.success ? "本项处理成功。" : "本项未完成。";
    let reply: string;
    try {
      const records = (await readPersonalMemoryWithSources(storeHost)).records;
      const protectedReply = createPersonalMemoryContextFilter(records)(result.output);
      reply = protectedReply === result.output ? result.output : `${status}${protectedReply}`;
    } catch {
      // A memory read failure must not turn a completed write or pending card
      // into a false failure, nor release unchecked historical content.
      reply = `${status}个人记忆暂时无法核对，已省略本次详细内容，请稍后重试查询。`;
    }
    assertCurrent?.();
    queryRead?.assertCurrent();
    if(onRealtimeOutput){
      realtimeOutput=await produceRealtimeToolOutput(storeHost,result,reply,queryRead);
      assertCurrent?.();queryRead?.assertCurrent();
      if (queryRead && result.success) onSuccessfulQuery?.();
      onRealtimeOutput(realtimeOutput);transferred=true;
    }
    return {
      reply,
      receipts: writeReceipts([result]),
      actions: result.actions
    };
    }finally{if(!transferred){disposeRealtimeToolOutput(realtimeOutput);queryRead?.dispose();}}
  }

export async function assertAgentActionDeliverable(this: AgentHost, action: AgentActionSuggestion, assertCurrent?: () => void, beforeFinalCheck?:()=>Promise<void>): Promise<void> {
    if(action.type==="project_change"){
      const generation=this.lifecycleGeneration;
      await assertProjectConfirmationDeliverable(action,{store:this.store as unknown as StoreHost,refreshViews:async()=>{},assertCurrent:()=>{
        assertCurrent?.();if(this.unloaded||this.lifecycleGeneration!==generation)throw Error("插件已关闭，旧项目卡未继续展示。");
      }},beforeFinalCheck);return;
    }
    if (action.type !== "task_plan") throw new Error("本次安排卡类型无法核对，未提供旧卡。");
    await beforeFinalCheck?.();
    await this.getTaskPlanReviews().assertDeliverable(action as TaskPlanReviewAction, assertCurrent);
  }

export function createAgentRuntime(this: AgentHost, sourcePaths: readonly string[] = [], assertPlanInputsCurrent?: () => Promise<void>, assertProposalCurrent?: () => void): AgentRuntime {
    const frozenSources = [...sourcePaths];
    const generation=this.lifecycleGeneration;
    const requestStructured = (stage: ProviderStage, timeoutMs?: number): StructuredJsonRequest => (messages, options, source) => {
      const settings = this.store.settings.ai;
      if (settings.provider === "off" || !settings.dataDisclosureAccepted || !settings.endpoint || !settings.model) {
        throw new Error("请先配置允许读取笔记的模型。");
      }
      return this.observeProvider<string>(stage, source === "qwen-omni" ? "voice" : "text",
        (observed, _store, ai, current) => ai.generatePlanningJson(messages, {
          ...options, ...observed, assertTextRequestCurrent: () => { current(); options.assertTextRequestCurrent?.(); }
        }, timeoutMs), options.signal);
    };
    return new AgentRuntime({
      store: this.store as unknown as StoreHost,
      assertCurrent:()=>{if(this.unloaded||this.lifecycleGeneration!==generation)throw new Error("本次对话已关闭，旧确认卡不能继续保存。");},
      refreshViews: () => this.refreshViews(),
      onTaskOverload: (taskId, reason) => this.queueTaskOverload?.(taskId, reason),
      requestIdeaPlan: requestStructured("idea_advance", 60_000),
      requestQuizReview: requestStructured("learning_quiz"),
      prepareTaskPlan: async (tasks, message, proposalId, projectId) => {
        await assertPlanInputsCurrent?.();
        const action = await this.getTaskPlanReviews().prepare(tasks, message, frozenSources, proposalId, projectId, assertProposalCurrent);
        try { await assertPlanInputsCurrent?.(); }
        catch (error) { this.taskPlanReviews?.dismiss(action); throw error; }
        return action;
      },
      prepareProjectWorkPlan:async(tasks,message,proposalId,projectId,nextStep)=>{
        await assertPlanInputsCurrent?.();
        const action=await this.getTaskPlanReviews().prepareWorkPlan(tasks,message,frozenSources,proposalId,projectId,nextStep,assertProposalCurrent);
        try{await assertPlanInputsCurrent?.();}catch(error){this.taskPlanReviews?.dismiss(action);throw error;}
        return action;
      }
    });
  }

export async function saveLocalOperation(this: AgentHost, name: string, args: Record<string, unknown>, execute: (store: StoreHost) => Promise<unknown>, options?: FactOperationOptions): Promise<void> {
    const result = await this.createAgentRuntime().executeLocalOperation(name, args, execute, undefined, options);
    if (!result.success) throw new Error(result.output);
  }

export function dismissAgentAction(this: AgentHost, action: AgentActionSuggestion): void {
    if (action.type === "task_plan") this.taskPlanReviews?.dismiss(action as TaskPlanReviewAction);
    if (action.type === "idea_advance") void import("../features/ideas/advance")
      .then(({ dismissIdeaAdvance }) => dismissIdeaAdvance(this.store as unknown as StoreHost, action));
  }

export async function executeAgentAction(this: AgentHost, action: AgentActionSuggestion): Promise<string> {
    if(this.unloaded)throw new Error("插件已关闭，未继续执行确认操作。");const actionGeneration=this.lifecycleGeneration;
    action = structuredClone(action);
    if (action.type === "idea_advance") {
      const { confirmIdeaAdvance } = await import("../features/ideas/advance");
      const receipt = await confirmIdeaAdvance(this.store as unknown as StoreHost, this.createAgentRuntime(), action, () => {
        if (this.unloaded || this.lifecycleGeneration !== actionGeneration) throw new Error("本次安排已停止。");
      });
      await this.refreshViews().catch(() => undefined);
      return receipt;
    }
    if (action.type === "tool_batch") return executeConfirmedToolBatch(action, this.createAgentRuntime(), () => {
      if (this.unloaded || this.lifecycleGeneration !== actionGeneration) throw new Error("本次批量保存已停止。");
    });
    if (action.type === "task_plan") {
      const request = new AbortController(), runner = this.getProjectJobRunner();
      const completion = this.getTaskPlanReviews().start(action as TaskPlanReviewAction, request.signal);
      try { new ProjectJobModal(this.app, runner, { request, completion }).open(); }
      catch (error) { request.abort(); await completion.catch(() => undefined); throw error; }
      const result = await completion;
      if (!this.unloaded) new Notice(result.message);
      return result.message;
    }
    if (await runConfirmedToolAction(action, {
      store: this.store as unknown as StoreHost,
      assertCurrent:()=>{if(this.unloaded||this.lifecycleGeneration!==actionGeneration)throw new Error("本次确认已停止，未继续保存。");},
      refreshViews: () => this.refreshViews(),
    })) {
      const count = (action.taskIds?.length ?? 0) + (action.habitIds?.length ?? 0);
      if (action.type === "review_memory") {
        const label = action.memoryDecision === "forget" ? "遗忘" : action.memoryDecision === "correct" ? "纠正" : "确认";
        new Notice(`LifeOps 已完成个人记忆${label}`);
        return `LifeOps 已完成个人记忆${label}。`;
      } else if (action.type === "update_memory") {
        new Notice("LifeOps 已写入个人记忆并完成读回校验");
        return "LifeOps 已写入个人记忆并完成读回校验。";
      } else if (action.type === "note_understanding") {
        new Notice("理解候选已核验保存，尚未成为本人事实");
        return "理解候选已核验保存；同一原文版本不会重复创建，原笔记未修改。是否记住仍需另行确认。";
      } else if (action.type === "weekly_review") {
        new Notice("周回顾草稿已保存，假设仍待核对");
        return `周回顾草稿已核验保存：${action.weeklyReviewPath}。支持、反例和未知信息保留，前稿和原文未覆盖；没有确认记忆或完成任务。`;
      } else if (action.type === "project_change") {
        new Notice("LifeOps 已保存目标与项目变更");
        return action.projectCommand?.kind === "record_task_result"
          ? `任务结果已记录为${action.projectCommand.entryKind === "review" ? "回顾" : "产出"}；原任务和项目阶段保持不变。`
          : "这项目标或项目变更已核验保存。";
      } else if(action.type === "trading_change") {new Notice("交易研究记录已保存");return "交易规则版本或案例已核验保存，旧版本与更正历史保留；没有执行交易。";
      } else if (action.type === "delete_trade") {
        new Notice("已删除交易记录");
        return `已删除「${action.content}」。可在最近操作中撤销。`;
      } else {
        new Notice(action.type === "delete_habit" ? `LifeOps 已删除 ${count} 个习惯` : `LifeOps 已删除 ${count} 个任务`);
        return action.type === "delete_habit" ? `LifeOps 已删除 ${count} 个习惯。` : `LifeOps 已删除 ${count} 个任务。`;
      }
    }

    if (action.type === "create_task") {
      const result = await this.createAgentRuntime().executeToolCall({
        toolName: "create_task",
        arguments: {
          title: action.content.trim(),
          date: action.date,
          category: "AI建议"
        },
        source: "system",
        callId: action.id,
        confirmedByUser: true
      });
      if (!result.success) throw new Error(result.output);
      new Notice(result.output);
      return result.output;
    }

    if (action.type === "append_knowledge_note") {
      const result = await this.createAgentRuntime().executeToolCall({
        toolName: "append_knowledge_note",
        arguments: { content: action.content, date: action.date },
        source: "system",
        callId: action.id,
        confirmedByUser: true
      });
      if (!result.success) throw new Error(result.output);
      new Notice(result.output);
      return result.output;
    }

    if (action.type === "append_trading_model_note") {
      const result = await this.createAgentRuntime().executeToolCall({
        toolName: "append_trading_model_note",
        arguments: { content: action.content, date: action.date },
        source: "system",
        callId: action.id,
        confirmedByUser: true
      });
      if (!result.success) throw new Error(result.output);
      new Notice(result.output);
      return result.output;
    }

    const journalResult = await this.createAgentRuntime().executeConfirmedJournalSuggestion(action);
    if (journalResult) {
      if (!journalResult.success) throw new Error(journalResult.output);
      new Notice(journalResult.output);
      return journalResult.output;
    }

    const captureResult = await this.createAgentRuntime().executeConfirmedCaptureSuggestion(action);
    if (!captureResult) throw new Error(`暂不支持的 AI 动作：${action.type}`);
    if (!captureResult.success) throw new Error(captureResult.output);
    new Notice(captureResult.output);
    return captureResult.output;
  }

export function finiteProviderRevision(this: AgentHost, stage: ProviderStage): string {
    const settings = this.settings;
    const config = stage === "embedding" ? [settings.embedding, settings.ai.apiKey]
      : stage === "vision" || stage === "screen" ? [settings.vision, settings.ai.apiKey, settings.realtimeVoice.apiKey]
      : stage === "transcription" ? [settings.voice, settings.ai.apiKey] : [settings.ai];
    return recordRevision([config, settings.folders, settings.privacy, settings.externalVaults]);
  }

export async function observeProvider<T>(this: AgentHost, stage: ProviderStage, inputSource: QualityLogEntry["inputSource"], action: (options: ProviderRequestOptions, store: LifeOpsStore, ai: LifeOpsAi, current: () => void, onCommitted: () => void) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.store.canWriteFacts?.() === false) throw Error("请用设备随手记提交，由常开 Mac 处理。");
    if (this.store.enforcesDeviceExecution?.()) await this.store.assertFactWritesAllowed?.();
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const entry = { controller, stage, revision: this.finiteProviderRevision(stage) };
    (this.activeProviderRequests ??= new Set()).add(entry);
    const store = this.store, ai = this.ai;
    const providerRuns: ProviderRunResult[] = [];
    const providerTraceId = randomUUID();
    let localFallbackUsed = false, errorCode: string | undefined;
    let committed = false, actionSucceeded = false;
    const current = () => {
      if (this.unloaded || this.finiteProviderRevision(stage) !== entry.revision) controller.abort("provider state changed");
      assertProviderActive(controller.signal);
    };
    try {
      current();
      const result = await action({ signal: controller.signal, onProviderRun: run => { providerRuns.push(run); },
        onLocalFallback: reason => { localFallbackUsed = true; errorCode = reason; } }, store, ai, current, () => { committed = true; });
      // Cancellation after the transaction committed cannot report an already
      // saved fact as an unsaved request. Stopping does not undo saved facts.
      if (!committed) current();
      actionSucceeded = true;
      return result;
    } catch (error) {
      errorCode = !committed && (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) ? providerAbortCode(controller.signal)
        : error instanceof ProviderRunFailure ? error.code : "operation_failed";
      if (errorCode === "cancelled" || errorCode === "timeout") { localFallbackUsed = false; assertProviderActive(controller.signal); }
      throw error;
    } finally {
      try {
        // Diagnostic I/O gets its own deadline, including for already cancelled
        // actions. Starting it with the business signal would skip cancellation logs.
        const logWait = new AbortController();
        const logDeadline = setTimeout(() => logWait.abort("diagnostic wait expired"), 1000);
        const appendObservation = () => awaitProviderActive(async () => {
          await store.appendQualityLog?.({ inputSource, providerTraceId, providerStage: stage, providerRuns,
            fallbackUsed: localFallbackUsed || providerRuns.some(run => run.fallbackUsed), localFallbackUsed, errorCode });
        }, logWait.signal);
        try {
          try { await appendObservation(); }
          catch { /* A logging failure cannot change a response, retry, or cancellation. */ }
          // Keep the provider's completed result, but record a distinct delivery
          // cancellation if it arrived during diagnostic I/O. Both observations
          // share one trace and the original deadline; no saved fact is relabelled.
          if (actionSucceeded && !committed) {
            try { current(); }
            catch (error) {
              if (error instanceof Error && error.name === "AbortError" && !logWait.signal.aborted) {
                errorCode = providerAbortCode(controller.signal);
                localFallbackUsed = false;
                try { await appendObservation(); } catch { /* Preserve the cancellation. */ }
              }
              throw error;
            }
          }
        }
        finally { clearTimeout(logDeadline); }
      } finally {
        this.activeProviderRequests.delete(entry);
        signal?.removeEventListener("abort", abort);
      }
    }
  }

export async function withAiFallback(this: AgentHost, action: (options: ProviderRequestOptions) => Promise<string>, fallback: string, options: ProviderRequestOptions = {}): Promise<string> {
    let unavailable = false;
    try {
      assertProviderActive(options.signal);
      const result = await action({ ...options, onProviderRun: run => {
        unavailable ||= run.status === "unavailable";
        options.onProviderRun?.(run);
      } });
      assertProviderActive(options.signal);
      if (!unavailable) return result;
      options.onLocalFallback?.("unavailable");
      return `${fallback}\n\n> AI 未启用，以上为 LifeOps 本地生成的结构化草稿。`;
    } catch (error) {
      assertProviderActive(options.signal);
      if (error instanceof Error && error.name === "AbortError") throw error;
      if (error instanceof ProviderRunFailure && error.code === "response_incomplete") throw error;
      options.onLocalFallback?.(error instanceof ProviderRunFailure ? error.code : "network");
      new Notice("AI 生成失败，已改用本地草稿。");
      return `${fallback}\n\n> AI 请求失败，以上为 LifeOps 本地生成的结构化草稿。`;
    }
  }
