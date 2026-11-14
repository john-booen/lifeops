import { weeklyReviewQueryRevision } from "./weeklyReview";
import { noteUnderstandingSourceRevision } from "./noteUnderstandingSource";
import type { AiToolCall } from "./ai";
import { createHash, randomUUID } from "node:crypto";
import { ensureToolCallId, isSafeOperationId, isSafeRuntimeOperationId, UndoRecoveryRequiredError, INVALID_OPERATION_ID_MESSAGE, MAX_CONFIRMATION_ACTION_ID_LENGTH, MAX_TOOL_CALL_ID_LENGTH } from "./operationIdentity";
import { OperationLedger, operationFingerprint, operationTrigger, type OperationClaim, type OperationLedgerDocument, type OperationResultSnapshot } from "./dataFoundation/operationLedger";
import type { GuardedFileChange } from "./dataFoundation/factOperation";
import { getLifeOpsTool, getRecordedUndoEvidence, getTaskOverloadSignal, performRecordedToolOperation, undoRecordedOperation, type ToolExecutionContext } from "./toolRegistry";
import { tradingContextRevision } from "./tradingTools";
import { personalMemorySourceAssessment, personalMemoryReadSnapshot } from "./personalMemory";
import type { AgentActionSuggestion, AgentWriteReceipt, ClassifiedInput } from "./types";
import type { StoreHost } from "./store/settingsSlice";
import type {VaultQueryRead} from "./vaultQueryRead";
import {isOwnedVaultQueryRead} from "./vaultQuery";
import {isOwnedStoredQueryRead} from "./storedQueryRead";
const isHeldQuery=(name:string)=>["query_vault","query_projects","query_trading_research","list_personal_memory_candidates"].includes(name);
const isOwnedQueryRead=(store:StoreHost,read:VaultQueryRead)=>isOwnedVaultQueryRead(store,read)||isOwnedStoredQueryRead(store,read);

export interface ToolCallRequest {
  toolName: string;
  arguments: Record<string, unknown>;
  source: "qwen-omni" | "kimi" | "system";
  callId: string;
  userMessage?: string;
  confirmedByUser?: boolean;
}

export interface ToolCallResult {
  callId: string;
  success: boolean;
  output: string;
  actions: AgentActionSuggestion[];
  receipt?: AgentWriteReceipt;
  priorQueryUnverified?: true;
}

/** Host-only execution controls. A model cannot obtain these from tool arguments. */
export interface ToolExecutionControl {
  assertCurrent: () => void;
  signal?: AbortSignal;
  /** Host-owned live successful query, required for an explicit query-then-undo request. */
  assertPriorQuery?: () => Promise<void>;
  assertBeforeCommit?: () => Promise<void>;
  onQueryRead?: (result:ToolCallResult,read:VaultQueryRead)=>void;
  /** Runs inside the existing create_task Fact transaction, before audit/commit. */
  checkpoint?: (store: StoreHost, result: ToolCallResult) => Promise<OperationResultSnapshot["jobCheckpoint"] | void>;
  userUndoPaths?: readonly string[];
}

/** Local-only evidence: it is neither serialized in tool results nor accepted from a model. */
export interface CommittedTaskEvidence {
  operationId: string;
  arguments: Record<string, unknown>;
  source: ToolCallRequest["source"];
  files: GuardedFileChange[];
}
const committedTaskEvidence = new WeakMap<ToolCallResult, { host: StoreHost; evidence: CommittedTaskEvidence }>();
const committedContextEvidence = new WeakMap<ToolCallResult, { host: StoreHost; evidence: CommittedTaskEvidence }>();
const committedToolReceipts = new WeakMap<ToolCallResult, StoreHost>();
/** A verified Fact receipt can retire voice history even if its WAL tail needs recovery. */
export function hasCommittedToolReceipt(result:ToolCallResult,store:StoreHost):boolean{
 return committedToolReceipts.get(result)===store||!!getCommittedContextEvidence(result,store);
}
/** Only a verified, newly committed Runtime operation may advance context reads. */
export function getCommittedContextEvidence(result: ToolCallResult, store: StoreHost): CommittedTaskEvidence | undefined {
  const entry = committedContextEvidence.get(result);
  return entry?.host === store ? structuredClone(entry.evidence) : undefined;
}
export function getCommittedTaskEvidence(result: ToolCallResult, store: StoreHost): CommittedTaskEvidence | undefined {
  const entry = committedTaskEvidence.get(result);
  return entry?.host === store ? structuredClone(entry.evidence) : undefined;
}

export class AgentRuntime {
  private readonly operationLedger: OperationLedger;

  constructor(private readonly context: ToolExecutionContext) {
    this.operationLedger = new OperationLedger(context.store);
  }

  async executeToolCall(request: ToolCallRequest, control?: ToolExecutionControl): Promise<ToolCallResult> {
    // Claim and execution must use the same payload even if the caller edits it while awaiting disk.
    request = structuredClone(request);
    try { control?.assertCurrent(); }
    catch { return { callId: request.callId, success: false, output: "这次安排已停止，尚未派发本项保存。", actions: [] }; }
    if (control?.checkpoint && (request.toolName !== "create_task" || !this.context.store.runFactOperation)) {
      return { callId: request.callId, success: false, output: "持久安排只支持受保护的新建任务，已停止。", actions: [] };
    }
    if (!(request.source === "system" ? isSafeRuntimeOperationId(request.callId) : isSafeOperationId(request.callId, MAX_TOOL_CALL_ID_LENGTH))) {
      return invalidOperationIdResult();
    }
    const tool = getLifeOpsTool(request.toolName);
    if (!tool) {
      return {
        callId: request.callId,
        success: false,
        output: `暂不支持这个工具：${request.toolName}`,
        actions: []
      };
    }
    if (tool.safety === "forbidden") {
      return {
        callId: request.callId,
        success: false,
        output: `这个工具当前被禁止执行：${tool.name}`,
        actions: []
      };
    }
    if (tool.safety === "ui-confirm") {
      if (!tool.prepareConfirmation) {
        return {
          callId: request.callId,
          success: false,
          output: `工具缺少确认准备器，已停止执行：${tool.name}`,
          actions: []
        };
      }
      try {
        const result = await tool.prepareConfirmation(request.arguments, this.context, {
          operationId: request.callId,
          source: request.source,
          userMessage: request.userMessage,
          signal: control?.signal,
          assertCurrent: control?.assertCurrent
        });
        return {
          callId: request.callId,
          success: result.success,
          output: result.output,
          // A retried model call must not create a second independently writable card.
          actions: result.actions.map((action, index) => ({ ...action, id: `proposal:${request.callId}:${index}` }))
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          callId: request.callId,
          success: false,
          output: `确认卡没有生成：${message}`,
          actions: []
        };
      }
    }
    if (tool.name === "undo_latest_operation" && request.arguments.requirePriorQuery === true
      && !(request.source === "system" && request.confirmedByUser === true)) {
      try {
        control?.assertCurrent();
        if (typeof control?.assertPriorQuery !== "function") throw new Error("No owned prior query");
        await control.assertPriorQuery();
        control.assertCurrent();
      } catch {
        return { callId: request.callId, success: false, output: "本轮查询尚未成功核对，未继续撤销；原记录保持不变。",
          actions: [], priorQueryUnverified: true };
      }
    }
    if (!tool.execute) {
      return {
        callId: request.callId,
        success: false,
        output: `工具没有可执行实现，已停止：${tool.name}`,
        actions: []
      };
    }

    let queryRead: VaultQueryRead | undefined, queryReadTransferred = false;
    const readPolicy = () => JSON.stringify([this.context.store.settings?.folders, this.context.store.settings?.privacy, this.context.store.settings?.externalVaults]);
    const policy = tool.safety === "safe" ? readPolicy() : undefined;
    const deliverRead = (result: ToolCallResult) => {
      if (policy !== undefined && result.success) {
        try {
          control?.assertCurrent();
          this.context.assertCurrent?.();
          if (policy !== readPolicy()) throw Error("查询权限已变化。");
          if (queryRead) {
            if (!isOwnedQueryRead(this.context.store, queryRead) || result.output !== queryRead.text) throw Error("查询结果无法核对。");
            queryRead.assertCurrent();
            control?.onQueryRead?.(result, queryRead);
            queryReadTransferred = !!control?.onQueryRead;
          }
        } catch {
          return { callId: request.callId, success: false, output: "查询权限或结果身份无法核对，请重新读取。", actions: [] };
        }
      }
      return result;
    };
    try{
    let preparedQuery:Awaited<ReturnType<typeof tool.execute>>|undefined;
    let claim;
    let operationId = tool.name === "append_memory_note" ? `confirmed:conversation:${request.callId}` : request.callId;
    let queryMemoryRevision: string | undefined;
    let queryProjectRevision: string | undefined;
    let queryTradingRevision: string | undefined;
    let queryWeeklyRevision: string | undefined;
    let queryNoteRevision: string | undefined;
    try {
      if (tool.name === "query_vault" || tool.name === "query_projects" || tool.name === "query_trading_research" || tool.name === "list_personal_memory_candidates") {
        queryMemoryRevision = await readQueryMemoryRevision(this.context.store, tool.name === "list_personal_memory_candidates");
        // Provider tool-call IDs still pair the exact request and response. Only
        // the local read cache varies by memory state; writes keep stable IDs.
        operationId = `${request.callId}:memory:${queryMemoryRevision}`;
      }
      if(isHeldQuery(tool.name)){
        preparedQuery=await tool.execute(request.arguments,{...this.context,onVaultQueryRead:read=>{if(queryRead||!isOwnedQueryRead(this.context.store,read)){read.dispose();throw Error("查询实际读取身份无法核对。");}queryRead=read;}},{operationId,source:request.source});
        if(!preparedQuery.success)return tool.name==="query_vault"?{callId:request.callId,...preparedQuery}:{callId:request.callId,success:false,output:"查询记录、原文或个人记忆暂无法安全核对，已停止本次查询，请重新读取。",actions:[]};
        if(!queryRead||preparedQuery.output!==queryRead.text)throw Error("查询实际读取身份无法核对。");
        if (queryRead.hasExternalSources) {
          await queryRead.assertSourcesCurrent();
          return deliverRead({ callId: request.callId, ...preparedQuery });
        }
        operationId=`${request.callId}:memory:${createHash("sha256").update(`${queryMemoryRevision}:${queryRead.revision}`).digest("hex")}`;
      }
      if (tool.name === "query_projects") {
        queryProjectRevision = await this.context.store.getProjectContextRevision();
        operationId += `:project:${queryProjectRevision}`;
      }
      if(tool.name === "query_trading_research") {queryTradingRevision=await tradingContextRevision(this.context.store);operationId+=`:trading:${queryTradingRevision}`;}
      if (tool.name === "inspect_weekly_review_sources") { queryWeeklyRevision = await weeklyReviewQueryRevision(this.context.store, request.arguments); operationId += `:weekly:${queryWeeklyRevision}`; }
      if (tool.name === "inspect_note_understanding_source") { queryNoteRevision = await noteUnderstandingSourceRevision(this.context.store, request.arguments); operationId += `:note:${queryNoteRevision}`; }
      claim = await this.operationLedger.claim({
        operationId,
        toolName: request.toolName,
        source: request.source,
        ...(tool.safety === "direct-write" ? { trigger: operationTrigger(request.toolName, request.arguments) ?? "user" } : {}),
        arguments: request.arguments
      });
    } catch(error) {
      if (error instanceof UndoRecoveryRequiredError) return { callId: request.callId, success: false, output: error.message, actions: [] };
      const queryParameterError=tool.name==="query_vault"&&error instanceof Error&&/路径无效|日期无效|关键词为空|date 和 period|该路径|指定路径/.test(error.message)?error.message:undefined;
      return { callId: request.callId, success: false, output: queryParameterError??(tool.name==="query_vault"?"查询原文、选择、个人记忆或权限刚刚变化或暂无法安全核对，已停止本次查询，请重新读取。":tool.name === "query_projects"
        ? "目标与项目或个人记忆暂时无法安全核对，已停止本次查询，请稍后重新查询。"
        : tool.name === "inspect_note_understanding_source" ? error instanceof Error && /保存尚未结束|资料整理仍在进行/.test(error.message)
          ? "有保存或资料整理尚未结束，本次没有提供原文。请稍后重新读取。"
          : "所选笔记、个人记忆或读取依据暂时无法安全核对，本次没有提供原文，请稍后重新读取。"
        : "操作记录无法安全读取，已停止这次操作。请先检查并恢复未完成操作。"), actions: [] };
    }
    if (claim.kind === "cached" && claim.record.result) {
      // A cached call ID binds its old arguments, not this new user sentence.
      // Named Undo must not present an old success as confirmation of a name.
      if (tool.name === "undo_latest_operation" && (undoTaskTitle(request.arguments) !== undefined||request.arguments.creationOnly === true || request.arguments.memoryOnly === true)) {
        return { callId: request.callId, success: false, output: "此调用编号已有撤销回执，本次点名撤销没有重复执行。请先查询最新记录。", actions: [] };
      }
      const { jobCheckpoint: _localCheckpoint, tradeEdits, ...publicResult } = claim.record.result;
      if(queryRead&&publicResult.success&&publicResult.output!==queryRead.text)return {callId:request.callId,success:false,output:"查询缓存与本次实际原文不一致，已停止旧内容。",actions:[]};
      return deliverRead({
        callId: request.callId,
        ...publicResult,
        ...(tool.safety === "direct-write" && tool.name !== "undo_latest_operation" && publicResult.success && publicResult.undo
          ? { receipt: { operationId, ...(tradeEdits ? { tradeEdits } : {}) } } : {})
      });
    }
    if (claim.kind === "busy") {
      return {
        callId: request.callId,
        success: false,
        output: "这个操作仍在执行中，没有重复写入。请稍后查看结果。",
        actions: []
      };
    }
    if (claim.kind === "collision") {
      return {
        callId: request.callId,
        success: false,
        output: "检测到工具调用 ID 冲突，已停止执行，避免写错数据。",
        actions: []
      };
    }

    try {
      let factCommitted = false;
      const writeContext = tool.name === "append_memory_note" ? { ...this.context, refreshViews: async () => undefined } : this.context;
      const result = await performRecordedToolOperation(writeContext, this.operationLedger, operationId, async scoped => {
        control?.assertCurrent();
        const output = preparedQuery??await tool.execute(request.arguments, scoped, { operationId, source: request.source, userMessage: request.userMessage,
          signal: control?.signal, assertCurrent: control?.assertCurrent,
          ...(request.source === "system" && request.confirmedByUser === true ? { confirmedByUser: true } : {}) });
        if (control?.checkpoint && output.success && !output.actions.length) {
          control.assertCurrent();
          const proof = await control.checkpoint(scoped.store, { callId: request.callId, ...output });
          if (proof) output.jobCheckpoint = structuredClone(proof);
        }
        return output;
      }, tool.safety !== "safe" && tool.name !== "undo_latest_operation", {
        assertCurrent: control?.assertCurrent,
        assertBeforeCommit: control?.assertBeforeCommit,
        userUndoPaths: control?.userUndoPaths,
        undoToolClaim:tool.name==="undo_latest_operation"?claim.record:undefined,
        undoTaskTitle:tool.name==="undo_latest_operation"?undoTaskTitle(request.arguments):undefined,
        undoTaskCreationOnly:tool.name==="undo_latest_operation"&&request.arguments.creationOnly === true,
        onCommitted: tool.safety !== "safe" ? () => { factCommitted = true; } : undefined
      });
      const snapshot = {
        success: result.success,
        output: result.output,
        actions: result.actions,
        undo: result.undo
      };
      const overload = factCommitted ? getTaskOverloadSignal(result) : undefined;
      if (overload) {
        try { this.context.onTaskOverload?.(overload.taskId, overload.reason); } catch { /* The task already committed. */ }
      }
      const returned: ToolCallResult = {
        callId: request.callId,
        ...snapshot,
        ...(tool.safety === "direct-write" && tool.name !== "undo_latest_operation" && result.success && result.undo
          ? { receipt: { operationId, ...(result.tradeEdits ? { tradeEdits: result.tradeEdits } : {}) } } : {})
      };
      const undone=factCommitted&&tool.name==="undo_latest_operation"&&result.success&&!result.actions.length
        ?getRecordedUndoEvidence(result,this.context.store,operationId):undefined;
      if(undone){
        // The transaction privately proves its actual success before optional
        // later reads. A pending WAL tail grants a receipt, never source advance.
        committedToolReceipts.set(returned,this.context.store);
        try{
          const document=await this.context.store.readJson<OperationLedgerDocument>(this.operationLedger.filePath,{version:1,records:[]});
          const own=document.records.find(record=>record.operationId===operationId),original=document.records.find(record=>record.operationId===undone.undoneOperationId);
          const reverse=(files:GuardedFileChange[])=>files.map(file=>({path:file.path,before:file.after,after:file.before,beforeHash:file.afterHash,afterHash:file.beforeHash})).sort((a,b)=>a.path.localeCompare(b.path));
          const actual=undone.files.map(file=>({path:file.path,before:file.before,after:file.after,beforeHash:file.beforeHash,afterHash:file.afterHash})).sort((a,b)=>a.path.localeCompare(b.path));
          const {hasPendingFactOperation}=await import("./dataFoundation/factOperation");
          if(own?.status==="verified"&&own.toolName===tool.name&&own.source===request.source&&own.attempts===claim.record.attempts
            &&own.createdAt===claim.record.createdAt&&own.fingerprint===operationFingerprint(tool.name,request.arguments)
            &&operationFingerprint(tool.name,own.arguments)===own.fingerprint&&own.result?.success===true&&!own.result.actions.length&&!own.result.undo
            &&original?.status==="reverted"&&original.result?.undo?.kind==="restore_guarded_files"
            &&operationFingerprint("files",{files:reverse(original.result.undo.files)})===operationFingerprint("files",{files:actual})
            &&undone.journalCommitted&&!await hasPendingFactOperation(this.context.store)){
            committedContextEvidence.set(returned,{host:this.context.store,evidence:structuredClone({operationId,arguments:request.arguments,source:request.source,files:undone.files})});
          }
        }catch{/* Preserve only the privately committed local receipt. */}
      }
      if (factCommitted && result.success && !result.actions.length
        && result.undo?.kind === "restore_guarded_files") {
        // A failed evidence read must not turn an already committed task into "not saved".
        try {
          const document = await this.context.store.readJson<OperationLedgerDocument>(this.operationLedger.filePath, { version: 1, records: [] });
          const record = document.records.find(item => item.operationId === operationId);
          if (record?.status === "verified" && record.toolName === tool.name && record.source === request.source
            && record.fingerprint === operationFingerprint(tool.name, request.arguments)
            && operationFingerprint(tool.name, record.arguments) === record.fingerprint
            && record.result?.success === true && !record.result.actions.length
            && record.result.undo?.kind === "restore_guarded_files"
            && operationFingerprint("files", { files: record.result.undo.files }) === operationFingerprint("files", { files: result.undo.files })) {
            const entry = { host: this.context.store,
              evidence: structuredClone({ operationId, arguments: request.arguments, source: request.source, files: result.undo.files }) };
            committedContextEvidence.set(returned, entry);
            if (tool.name === "create_task") committedTaskEvidence.set(returned, entry);
          }
        } catch { /* No proof means stop continuation; the committed result remains truthful. */ }
      }
      return deliverRead(returned);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const result = {
        callId: request.callId,
        success: false,
        output: `操作没有完成：${message}`,
        actions: []
      };
      await this.operationLedger.failClaim(claim.record, message, result).catch(() => undefined);
      return result;
    }
    }finally{if(!queryReadTransferred)queryRead?.dispose();}
  }

  async executeAiToolCall(
    toolCall: AiToolCall,
    source: "qwen-omni" | "kimi" | "system",
    userMessage = "",
    control?: ToolExecutionControl
  ): Promise<ToolCallResult> {
    return this.executeToolCall({
      toolName: toolCall.name,
      arguments: toolCall.arguments,
      source,
      callId: ensureToolCallId(toolCall),
      userMessage
    }, control);
  }

  async executeConfirmedJournalSuggestion(action: AgentActionSuggestion): Promise<ToolCallResult | null> {
    if (action.type !== "append_daily_note" && action.type !== "record_done") return null;
    if (!isSafeOperationId(action.id, MAX_CONFIRMATION_ACTION_ID_LENGTH)) return invalidOperationIdResult();
    if (action.type === "record_done") {
      return this.executeLocalOperation("confirm_record_done", { date: action.date, content: action.content.trim() }, async store => {
        if (!action.content.trim()) throw new Error("记录内容不能为空。");
        await store.appendActivity("tasks", action.date, "口述完成（未关联任务）", `- ${action.content.trim()}`);
      }, `confirmed:${action.id}`);
    }
    return this.executeToolCall({
      toolName: "append_journal_entry",
      arguments: { date: action.date, period: "早", heading: "日记", content: action.content.trim() },
      source: "system", callId: `confirmed:${action.id}`, confirmedByUser: true
    });
  }

  async executeConfirmedCaptureSuggestion(action: AgentActionSuggestion): Promise<ToolCallResult | null> {
    const kinds: Partial<Record<AgentActionSuggestion["type"], ClassifiedInput["kind"]>> = {
      record_idea: "idea", record_habit: "habit", record_health: "health", record_trade: "trade", send_to_inbox: "memo"
    };
    const kind = kinds[action.type];
    if (!kind) return null;
    if (!isSafeOperationId(action.id, MAX_CONFIRMATION_ACTION_ID_LENGTH)) return invalidOperationIdResult();
    const input: ClassifiedInput = { kind, confidence: 1, title: action.title, content: action.content.trim(), date: action.date,
      raw: action.content, source: "lifeops-agent", reason: `用户确认：${action.title}` };
    return this.executeLocalOperation(`confirm_${action.type}`, { input }, async store => {
      if (!input.content) throw new Error("记录内容不能为空。");
      await store.recordClassifiedInput(input);
    }, `confirmed:${action.id}`);
  }

  // Called only by first-party UI submissions or the candidate-only recorder.
  // This callback is not exposed in the Provider tool registry.
  async executeLocalOperation(
    name: string, args: Record<string, unknown>, execute: (store: StoreHost) => Promise<unknown>,
    operationId = `local:${name}:${randomUUID()}`,
    options?: import("./dataFoundation/factOperation").FactOperationOptions & Pick<ToolExecutionControl, "checkpoint" | "userUndoPaths">
  ): Promise<ToolCallResult> {
    if (!isSafeRuntimeOperationId(operationId)) return invalidOperationIdResult();
    options?.assertCurrent?.();
    if (options?.checkpoint && !this.context.store.runFactOperation) throw new Error("持久安排须使用受保护的保存宿主。");
    let claim: OperationClaim;
    try {
      claim = await this.operationLedger.claim({ operationId, toolName: name, source: "system",
        trigger: operationTrigger(name, args) ?? "user", arguments: args });
    } catch (error) {
      if (!(error instanceof UndoRecoveryRequiredError)) throw error;
      return { callId: operationId, success: false, output: error.message, actions: [] };
    }
    if (claim.kind === "cached" && claim.record.result) return { callId: operationId, ...claim.record.result };
    if (claim.kind !== "execute") return { callId: operationId, success: false, output: claim.kind === "collision" ? "操作 ID 冲突，已停止保存。" : "这次操作仍在执行，没有重复保存。", actions: [] };
    try {
      const result = await performRecordedToolOperation(this.context, this.operationLedger, operationId, async scoped => {
        options?.assertCurrent?.();
        await execute(scoped.store);
        const result: import("./toolRegistry").ToolExecutionResult = { success: true, output: "已保存并完成读回检查。", actions: [] };
        if (options?.checkpoint) {
          const proof = await options.checkpoint(scoped.store, { callId: operationId, ...result });
          if (proof) result.jobCheckpoint = proof;
        }
        options?.assertCurrent?.();
        return result;
      }, true, options);
      return { callId: operationId, ...result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.operationLedger.failClaim(claim.record, message).catch(() => undefined);
      return { callId: operationId, success: false, output: `保存没有完成：${message}`, actions: [] };
    }
  }

  async undoOperation(operationId: string): Promise<boolean> {
    await undoRecordedOperation(operationId, this.context);
    return true;
  }

  async undoLatestOperation(): Promise<string | null> {
    const record = await this.operationLedger.latestReversible();
    if (!record) return null;
    await undoRecordedOperation(record.operationId, this.context, undefined, record);
    return record.operationId;
  }
}

function invalidOperationIdResult(): ToolCallResult {
  return { callId: "invalid-operation-id", success: false, output: INVALID_OPERATION_ID_MESSAGE, actions: [] };
}

function undoTaskTitle(args: Record<string, unknown>): string | undefined {
  return typeof args.taskTitle === "string" ? args.taskTitle.trim() || undefined : undefined;
}

export function toolResultsToAgentExecution(results: ToolCallResult[]): { replies: string[]; actions: AgentActionSuggestion[] } {
  return {
    replies: results.map((result) => result.output).filter(Boolean),
    actions: results.flatMap((result) => result.actions)
  };
}

async function readQueryMemoryRevision(store: StoreHost, includeCandidates = false): Promise<string> {
  const [{ personalMemoryContextRevision }, { readPersonalMemoryWithSources }] = await Promise.all([
    import("./personalMemoryContext"), import("./personalMemorySources")
  ]);
  const document = await readPersonalMemoryWithSources(store);
  if (includeCandidates) {
    if (store.runFactOperation && await (await import("./dataFoundation/factOperation")).hasPendingFactOperation(store)) throw new Error("理解保存尚未结束，暂不提供候选缓存。");
    return createHash("sha256").update(JSON.stringify({ raw: document[personalMemoryReadSnapshot]?.raw,
      assessments: document.records.map(record => [record.id, record[personalMemorySourceAssessment]]), folders: store.settings.folders, privacy: store.settings.privacy }), "utf8").digest("hex");
  }
  return personalMemoryContextRevision(document.records);
}
