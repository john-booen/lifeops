import {executeStoredQuery} from "./storedQueryRead";
import { saveMemoryNote } from "./memoryNoteWrite";
import { activityNotePath } from "./activityRecords";
import { linkedNoteName } from "./linkedNoteSettings";
import { journalOriginalBlock } from "./features/journal/entry";
import { explicitScheduledTaskTitle, isCopiedTaskTitleReference, isTaskIdentifierReference } from "./taskReference";
import type { AiToolDefinition } from "./ai";
import { assertSafeOperationId, fileRevision, MAX_CONFIRMATION_ACTION_ID_LENGTH, recordRevision } from "./operationIdentity";
import { OperationLedger, type OperationUndoDescriptor, type OperationResultSnapshot, type OperationLedgerRecord } from "./dataFoundation/operationLedger";
import { createdTaskForUndo, rebaseTaskRecordUndo } from "./dataFoundation/taskRecordUndo";
import type { FactOperationOptions, GuardedFileChange } from "./dataFoundation/factOperation";
import { addDays, normalizeJournalDate, todayString } from "./date";
import { isVaultPathExcluded } from "./privacy";
import { taskScheduleLabel, validateTaskSchedule } from "./taskSchedule";
import { createPersonalMemory, findMemorySuppression, personalMemorySourceAssessment, personalMemoryReadSnapshot, reviewPersonalMemoryRecord, upsertPersonalMemoryRecord, type PersonalMemoryKind } from "./personalMemory";
import type { StoreHost } from "./store/settingsSlice";
import type { AgentActionSuggestion, HabitDefinition, HabitInput, LifeOpsTask } from "./types";
import { readVaultQueryWithSources, type VaultQueryDomain, type VaultQueryOperation } from "./vaultQuery";
import type {VaultQueryRead} from "./vaultQueryRead";
import { taskOverloadNotice } from "./features/tasks/capacity";
import { habitMeasurementUnit, validateHabitTarget } from "./features/habits/targets";
import { TASK_PLANNING_TOOLS } from "./features/tasks/planTools";
import { STATS_TOOL } from "./features/stats/tools";
import { SUMMARIES_TOOL } from "./features/summaries/tools";
import { TRADE_RECORD_TOOLS } from "./features/trading/tools";
import { IDEA_TOOLS } from "./features/ideas/tools";
import { LEARNING_TOOLS } from "./features/learning/tools";
import { QUIZ_TOOLS } from "./features/learning/quizTools";
import { READING_TOOL } from "./features/reading/tools";
import { LEARNING_TRACKS, isLearningTrackId } from "./features/learning/model";
import { tradeLabel } from "./features/trading/inputs";
import { PROJECT_TOOLS, assertProjectConfirmationPayload, executeConfirmedProjectChange, prepareProjectTaskResultGuard } from "./projectTools";
import { TRADING_TOOLS, assertTradingConfirmation, executeConfirmedTradingChange, prepareTradingWriteGuard } from "./tradingTools";
import { NOTE_UNDERSTANDING_TOOL, assertNoteUnderstandingCard, executeNoteUnderstanding, prepareNoteUnderstandingWriteGuard,
  prepareVersionedMemoryReview, prepareVersionedMemoryReviewGuard, type MemorySourceWriteGuard } from "./noteUnderstanding";
import { WEEKLY_REVIEW_TOOLS, assertWeeklyReviewCard, assertWeeklyReviewSaved, executeWeeklyReview, prepareWeeklyReviewGuard } from "./weeklyReview";
import { NOTE_UNDERSTANDING_SOURCE_TOOL } from "./noteUnderstandingSource";
import { TASK_PLAN_TOOL, PROJECT_WORK_PLAN_TOOL } from "./taskPlanTools";
import type { TaskPlanReviewAction } from "./taskPlanReviewRegistry";
import type { ProjectJobArguments } from "./projectJobRepository";

export type ToolSafetyLevel = "safe" | "direct-write" | "ui-confirm" | "forbidden";
export type ToolSource = "qwen-omni" | "kimi" | "system";
export type StructuredJsonRequest = (messages: import("./ai").ChatMessage[], options: import("./types").ProviderRequestOptions, source: ToolSource) => Promise<string>;

export interface ToolExecutionContext {
  store: StoreHost;
  refreshViews: () => Promise<void>;
  assertCurrent?: () => void;
  onVaultQueryRead?: (read:VaultQueryRead)=>void;
  requestIdeaPlan?: StructuredJsonRequest;
  requestQuizReview?: StructuredJsonRequest;
  onTaskOverload?: (taskId: string, reason: string) => void;
  prepareTaskPlan?: (tasks: Array<Partial<ProjectJobArguments> & { title: string }>, userMessage: string, proposalId: string, projectId?: string) => Promise<TaskPlanReviewAction>;
  prepareProjectWorkPlan?: (tasks: Array<Partial<ProjectJobArguments>&{title:string}>,userMessage:string,proposalId:string,projectId:string,
    nextStep:{text:string;sourcePath?:string})=>Promise<TaskPlanReviewAction>;
}

export interface ToolExecutionRequest {
  operationId: string;
  source: ToolSource;
  userMessage?: string;
  confirmedByUser?: boolean;
  signal?: AbortSignal;
  assertCurrent?: () => void;
}

export interface ToolExecutionResult {
  success: boolean;
  output: string;
  actions: AgentActionSuggestion[];
  undo?: OperationUndoDescriptor;
  tradeEdits?: OperationResultSnapshot["tradeEdits"];
  jobCheckpoint?: OperationResultSnapshot["jobCheckpoint"];
}
interface UndoExecution {host:StoreHost;operationId:string;claim:OperationLedgerRecord;options:FactOperationOptions;taskTitle?:string;taskCreationOnly?:boolean;}
interface CommittedUndoEvidence {operationId:string;undoneOperationId:string;files:GuardedFileChange[];journalCommitted:boolean;}
const undoExecutions=new WeakMap<ToolExecutionContext,UndoExecution>();
const undoEvidence=new WeakMap<ToolExecutionResult,{host:StoreHost;evidence:CommittedUndoEvidence}>();
const taskOverloadSignals = new WeakMap<ToolExecutionResult, { taskId: string; reason: string }>();
export const getTaskOverloadSignal = (result: ToolExecutionResult) => taskOverloadSignals.get(result);
/** First-party undo result; visible fields, caches and copied results cannot mint it. */
export function getRecordedUndoEvidence(result:ToolExecutionResult,store:StoreHost,operationId:string):CommittedUndoEvidence|undefined{
 const entry=undoEvidence.get(result);return entry?.host===store&&entry.evidence.operationId===operationId?structuredClone(entry.evidence):undefined;
}

export interface LifeOpsToolDefinition extends AiToolDefinition {
  safety: ToolSafetyLevel;
  execute: (
    args: Record<string, unknown>,
    context: ToolExecutionContext,
    request: ToolExecutionRequest
  ) => Promise<ToolExecutionResult>;
  prepareConfirmation?: (
    args: Record<string, unknown>,
    context: ToolExecutionContext,
    request: ToolExecutionRequest
  ) => Promise<ToolExecutionResult>;
}

const memoryFileNames = ["个人画像.md", "当前状态.md", "长期目标.md", "管家规则.md", "交易纪律.md"];

export const AGENT_TOOLS: LifeOpsToolDefinition[] = [
  STATS_TOOL,
  SUMMARIES_TOOL,
  ...TASK_PLANNING_TOOLS,
  ...PROJECT_TOOLS,
  ...TRADING_TOOLS,
  ...TRADE_RECORD_TOOLS,
  ...IDEA_TOOLS,
  ...LEARNING_TOOLS,
  ...QUIZ_TOOLS,
  READING_TOOL,
  NOTE_UNDERSTANDING_TOOL,
  NOTE_UNDERSTANDING_SOURCE_TOOL,
  ...WEEKLY_REVIEW_TOOLS,
  TASK_PLAN_TOOL,
  PROJECT_WORK_PLAN_TOOL,
  {
    name: "append_memory_note",
    description: "用户明确说记住时，用 content 保存原话，可撤销。时间相同、事项不同也要保存。稳定事实、计划或偏好可自动保存。引用、猜测、临时情绪或拒绝保存的内容不记。明确纠正用审查工具。",
    safety: "direct-write",
    parameters: {
      type: "object", additionalProperties: false,
      properties: {
        content: { type: "string" },
        fileName: { type: "string", enum: memoryFileNames, description: "可省略，默认当前状态.md。" },
        explicit: { type: "boolean", description: "本轮用户直接要求记住才填 true，自动保存时省略。" }
      },
      required: ["content"]
    },
    execute: async (args, context, request) => {
      if (args.explicit !== undefined && typeof args.explicit !== "boolean") return toolError("记忆参数无效，未保存。");
      const content = toolArgString(args, "content");
      if (!content) return toolError("记忆内容不能为空。");
      const fileName = toolArgString(args, "fileName") || "当前状态.md";
      if (!isAllowedMemoryFile(fileName)) return toolError("记忆文件名不支持。自动保存时可以只提供内容。");
      return saveMemoryNote(content, fileName, request.operationId, context, true);
    }
  },
  {
    name: "append_knowledge_note",
    description: "把用户明确要求沉淀的知识、洞见或方法写入知识沉淀笔记，并在指定日期的知识记录中留下链接。",
    safety: "direct-write",
    parameters: {
      type: "object",
      properties: {
        content: { type: "string", description: "要沉淀的知识正文。" },
        date: { type: "string", description: "有效日期或相对日期；补记指定日期，省略为今天。" }
      },
      required: ["content"]
    },
    execute: async (args, context) => executeLinkedNoteWrite("knowledge", args, context)
  },
  {
    name: "append_trading_model_note",
    description: "把用户明确要求沉淀的交易规则、复盘结论或模型迭代写入交易模型笔记，并在指定日期的交易学习记录中留下链接。",
    safety: "direct-write",
    parameters: {
      type: "object",
      properties: {
        content: { type: "string", description: "要沉淀的交易模型正文。" },
        date: { type: "string", description: "有效日期或相对日期；补记指定日期，省略为今天。" }
      },
      required: ["content"]
    },
    execute: async (args, context) => executeLinkedNoteWrite("trading", args, context)
  },
  {
    name: "query_vault",
    description: "只读查日记、笔记、交易、健康、记忆、任务和习惯。问整天日记时传日期并省略 period，读全早晚。任务默认列未完成，习惯可查某日或本周。",
    safety: "safe",
    parameters: {
      type: "object",
      properties: {
        domain: { type: "string", enum: ["journal", "note", "trade", "health", "memory", "task", "habit"], description: "task查任务，habit查习惯；其余按资料类型。" },
        operation: { type: "string", enum: ["get", "list", "search"], description: "get读原文，list列信息，search搜词；memory仅有效记忆。" },
        query: { type: "string", description: "search填连续关键词；list筛文件名；日记get用日期、时段或路径。" },
        date: { type: "string", description: "日期或今天/昨天；日记省略取最新，习惯默认今天。" },
        range: { type: "string", enum: ["today", "week"], description: "任务/习惯的今日或本周至指定日期。" },
        period: { type: "string", enum: ["早", "晚"], description: "日记时段。用户问昨晚、晚间时填晚，问晨间时填早；省略且指定日期时返回同日各篇。" },
        path: { type: "string", description: "准确库内Markdown路径，缺失不替代；排除生成/隐私内容，memory不用。" },
        vault: { type: "string", description: "默认全部。local 只搜日用库，或填外部库名。外部来源注明原私人库。" },
        sort: { type: "string", enum: ["newest", "oldest"], description: "日记按日期/早晚，其余按修改时间；默认最新，同日早到晚；记忆按相关性。" },
        limit: { type: "number", description: "list/search默认5最多12；get一篇，同日日记/记忆最多12条。" },
        maxChars: { type: "number", description: "每条最多18000字符；截断非全文，准确路径get可用offset续读。" },
        offset: { type: "integer", minimum: 0, description: "任务/习惯按条分页；准确路径get沿用nextOffset续读。" }
      },
      required: ["domain", "operation"]
    },
    execute: async (args, context) => {
      const domain = toolArgString(args, "domain") as VaultQueryDomain;
      const operation = toolArgString(args, "operation") as VaultQueryOperation;
      if (!(["journal", "note", "trade", "health", "memory", "task", "habit"] as string[]).includes(domain)) return toolError("查询资料时缺少有效 domain。");
      if (!(["get", "list", "search"] as string[]).includes(operation)) return toolError("查询资料时缺少有效 operation。");
      const read = await readVaultQueryWithSources(context.store, {
        domain,
        operation,
        query: toolArgString(args, "query"),
        date: toolArgString(args, "date"),
        ...(args.range === "today" || args.range === "week" ? { range: args.range } : {}),
        period: toolArgString(args, "period") === "早" ? "早" : toolArgString(args, "period") === "晚" ? "晚" : undefined,
        path: toolArgString(args, "path"),
        vault: toolArgString(args, "vault"),
        sort: toolArgString(args, "sort") === "oldest" ? "oldest" : toolArgString(args, "sort") === "newest" ? "newest" : undefined,
        limit: normalizeTargetCount(args.limit || 5),
        maxChars: normalizeMaxChars(args.maxChars, 5000, 18_000),
        ...(args.offset !== undefined ? { offset: args.offset as number } : {})
      });
      let transferred=false;
      try{context.onVaultQueryRead?.(read);transferred=!!context.onVaultQueryRead;return toolReply(read.text);}
      finally{if(!transferred)read.dispose();}
    }
  },
  {
    name: "create_task",
    description: "用户表达未来要做的事时建任务。周末等有多个日期时，问具体哪天或说明采用的日期。改现有任务用 reschedule_task。",
    safety: "direct-write",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "标题保留动作、人名和对象；指代不明先问；要求原样则逐字保留。" },
        date: { type: "string", description: "有效日期；用户说今天/明天等则原样填相对日期；未指定时省略，不编造。" },
        time: { type: "string", description: "单点安排 HH:mm，如下午三点贴标签。结束时刻用 endTime。" },
        startTime: { type: "string", description: "明确计划开始的 HH:mm，未提开始则省略。" },
        endTime: { type: "string", description: "结束或做完的 HH:mm，如三点前交稿填 15:00。" },
        endDate: { type: "string", description: "跨天计划结束日期；同一天可省略。支持明确的相对日期，不推测。" },
        category: { type: "string", description: "任务分类，可省略。" },
        learningTrackId: { type: "string", enum: Object.keys(LEARNING_TRACKS), description: "英语 english；交易 trading；量化 quant；AI ai" },
        estimateMin: { type: "number", exclusiveMinimum: 0, description: "用户提供的估计分钟数。" }
      },
      required: ["title"]
    },
    execute: async (args, context, request) => {
      const proposedTitle = toolArgString(args, "title");
      if (!proposedTitle) return toolError("创建任务缺少标题。");
      const title = explicitScheduledTaskTitle(proposedTitle, request.userMessage);
      if (isCopiedTaskTitleReference(title, request.userMessage)) return toolError("任务标题仍在引用前文，请核对具体标题；这次没有创建任务。");
      const suppliedDate = toolArgString(args, "date");
      const date = suppliedDate ? normalizeJournalDate(suppliedDate) : "";
      if (suppliedDate && !date) return toolError("任务日期无法识别或不存在，请明确有效日期；这次没有创建任务，也没有改成未定日期。");
      const plan: { startTime?: string; endTime?: string; endDate?: string } = {};
      for (const key of ["startTime", "endTime", "endDate"] as const) {
        if (args[key] === undefined) continue;
        if (typeof args[key] !== "string") return toolError("计划日期与时刻须为文字，没有创建任务。");
        const value = (args[key] as string).trim();
        if (key === "endDate") {
          plan.endDate = value ? normalizeJournalDate(value) : "";
          if (value && !plan.endDate) return toolError("计划结束日期无法识别或不存在，没有创建任务。");
        } else plan[key] = value;
      }
      const estimateMin = args.estimateMin;
      const learningTrackId = args.learningTrackId;
      if (learningTrackId !== undefined && !isLearningTrackId(learningTrackId)) return toolError("学习轨道无效，请核对。");
      const specifiedCategory = toolArgString(args, "category");
      if (learningTrackId && specifiedCategory && specifiedCategory !== "learning") return toolError("学习轨道仅用于学习类任务。");
      const category = specifiedCategory || (learningTrackId ? "learning" : "work");
      if (category === "punishment") return toolError("补偿待办由习惯规则生成，请在习惯面板配置。");
      if (estimateMin !== undefined && typeof estimateMin !== "number") return toolError("估计时长须为分钟数。");
      try { validateTaskSchedule({ date, endDate: plan.endDate ?? "", time: "", ...plan, estimateMin }); }
      catch (error) { return toolError(error instanceof Error ? error.message : "计划区间无效，没有创建任务。"); }
      const operationSource = `lifeops-agent-tool:${request.operationId}`;
      const before = (await context.store.readTaskDb()).tasks;
      const existing = before.find((task) => task.source === operationSource);
      if (existing) {
        return toolReply(`任务此前已经写入并通过校验：${existing.title}（任务库 ID：${existing.id}）。`);
      }
      const task = await context.store.createTask({
        title,
        date,
        time: normalizeToolTime(toolArgString(args, "time")),
        ...plan,
        category,
        estimateMin,
        learningTrackId,
        source: operationSource
      });
      const after = (await context.store.readTaskDb()).tasks;
      const verified = after.find((item) => item.id === task.id || item.source === operationSource);
      if (!verified || verified.title !== task.title || verified.status !== "active"
        || verified.estimateMin !== task.estimateMin || verified.learningTrackId !== task.learningTrackId
        || verified.startTime !== task.startTime || verified.endTime !== task.endTime || verified.endDate !== task.endDate) {
        return toolError(`任务写入后校验失败，没有确认任务库中存在：${task.title}。`);
      }
      await context.refreshViews();
      const when = [dateDisplay(verified.date), taskScheduleLabel(verified)].filter(Boolean).join(" ");
      const excluded = context.store.settings.privacy?.excludedVaultPrefixes;
      const allowed = (task: LifeOpsTask) => !task.sourceNotePath || !isVaultPathExcluded(task.sourceNotePath, excluded);
      const load = typeof context.store.taskDbPath === "function" && !isVaultPathExcluded(context.store.taskDbPath(), excluded)
        ? taskOverloadNotice(before.filter(allowed), after.filter(allowed), new Date()) : "";
      const reply = toolReply(
        `已创建任务：${verified.title}${when ? `（${when}）` : ""}。已从任务库读回校验（ID：${verified.id}）。${load}`,
        [],
        { kind: "delete_task", taskId: verified.id }
      );
      if (load) taskOverloadSignals.set(reply, { taskId: verified.id, reason: load });
      return reply;
    }
  },
  {
    name: "reschedule_task",
    description: "把现有未完成任务改到指定日期，保留任务身份和计划时刻。改期直接执行，禁止另建替代任务。",
    safety: "direct-write",
    parameters: { type: "object", additionalProperties: false, properties: {
      taskIdOrTitle: { type: "string" }, date: { type: "string" }
    }, required: ["taskIdOrTitle", "date"] },
    execute: async (args, context) => {
      const reference = toolArgString(args, "taskIdOrTitle"), date = normalizeJournalDate(toolArgString(args, "date"));
      if (!reference || !date) return toolError("请明确要改期的任务和日期。");
      const store = context.store, excluded = store.settings.privacy?.excludedVaultPrefixes;
      if (isVaultPathExcluded(store.taskDbPath(), excluded)) return toolError("任务库已排除，请在面板改期。");
      const resolution = await resolveTaskByReference(store, reference, true);
      if (resolution.kind !== "match") return toolError("没有定位到唯一任务，请核对准确标题或编号。");
      const task = resolution.item;
      if (task.sourceNotePath && isVaultPathExcluded(task.sourceNotePath, excluded)) return toolError("任务来源已排除，请在面板操作。");
      if (task.status !== "active") return toolError("只能改期尚未完成的任务。");
      if (task.date === date) return toolReply(`「${task.title}」已在 ${date}。`);
      const days = (Date.parse(date + "T00:00:00Z") - Date.parse((task.date || todayString()) + "T00:00:00Z")) / 86_400_000;
      if (!Number.isSafeInteger(days)) return toolError("原任务日期无法核对，已保留原安排。");
      await store.postponeTask(task.id, days);
      const verified = await store.getTask(task.id);
      if (verified.date !== date || verified.title !== task.title) return toolError("改期后的记录校验未通过。");
      await context.refreshViews();
      return toolReply(`已把「${task.title}」改到 ${date}。`, [],
        { kind: "restore_task", task: structuredClone(task) as unknown as Record<string, unknown> });
    }
  },
  {
    name: "complete_task",
    description: "标记一个任务为已完成。用户说某件待办办完、搞定、已完成时使用。",
    safety: "direct-write",
    parameters: {
      type: "object",
      properties: {
        taskIdOrTitle: { type: "string", description: "准确ID或唯一标题片段；同名用ID，非进行中任务不重复完成。" },
        note: { type: "string", description: "完成备注，可省略。" }
      },
      required: ["taskIdOrTitle"]
    },
    execute: async (args, context) => {
      const ref = toolArgString(args, "taskIdOrTitle");
      const resolution = await resolveTaskByReference(context.store, ref);
      if (resolution.kind === "not_found") return toolError(`我想标记完成，但没在任务库里定位到：${ref || "未提供任务名"}。`);
      if (resolution.kind === "ambiguous") {
        return toolError(`找到多个可能的任务，暂时没有执行：${resolution.candidates.map((task) => task.title).join("、")}。请再说具体一点。`);
      }
      const task = resolution.item;
      if (task.status !== "active") {
        return toolError(`任务“${task.title}”${task.status === "completed" ? "已完成" : "已放弃"}，这次没有重复完成，也没有改动其它任务。`);
      }
      await context.store.completeTaskAndLog(task.id, todayString(), toolArgString(args, "note"));
      const verified = (await context.store.readTaskDb()).tasks.find((item) => item.id === task.id);
      if (!verified || verified.status !== "completed") {
        return toolError(`任务完成写入后校验失败，没有确认状态已经变为 completed：${task.title}。`);
      }
      await context.refreshViews();
      return toolReply(
        `已标记完成：${verified.title}。已从任务库读回校验。`,
        [],
        { kind: "restore_task", task: structuredClone(task) as unknown as Record<string, unknown> }
      );
    }
  },
  {
    name: "delete_task",
    description: "删除任务。高风险动作，只生成待确认动作，用户确认后再真正删除。",
    safety: "ui-confirm",
    parameters: {
      type: "object",
      properties: {
        taskIdOrTitle: { type: "string", description: "准确ID或唯一标题片段；同名用ID，任何状态均可选。" }
      },
      required: ["taskIdOrTitle"]
    },
    prepareConfirmation: async (args, context) => {
      const ref = toolArgString(args, "taskIdOrTitle");
      const resolution = await resolveTaskByReference(context.store, ref, true);
      if (resolution.kind === "not_found") return toolError(`我想删除任务，但没定位到：${ref || "未提供任务名"}。`);
      if (resolution.kind === "ambiguous") {
        return toolError(`找到多个可能的任务，暂时没有生成删除动作：${resolution.candidates.map((task) => task.title).join("、")}。请再说具体一点。`);
      }
      const task = resolution.item;
      return {
        success: true,
        output: `我找到了要删除的任务：${task.title}。我先放到待确认动作里，你确认后再真正删除。`,
        actions: [deleteTaskToolAction(task)]
      };
    },
    execute: async () => toolError("删除任务必须先由 AgentRuntime 生成确认卡。")
  },
  {
    name: "delete_habit",
    description: "用户明确要求删除习惯时生成确认卡。点击确认才会删除习惯和对应打卡记录。",
    safety: "ui-confirm",
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: "准确习惯 ID 或唯一名称。" } },
      required: ["name"]
    },
    prepareConfirmation: async (args, context) => {
      const name = normalizeToolMatchText(toolArgString(args, "name"));
      if (!name) return toolError("请提供要删除的习惯名称。");
      if (isVaultPathExcluded(context.store.habitDbPath(), context.store.settings.privacy?.excludedVaultPrefixes)) {
        return toolError("习惯记录已排除，请在习惯面板操作。");
      }
      const { habits, checkins } = await context.store.readHabitDb();
      const resolution = resolveBestToolMatch(habits, name, habit => [habit.id, habit.name]);
      if (resolution.kind !== "match") return toolError("请提供唯一的习惯名称或编号，未删除任何习惯。");
      const habit = resolution.item;
      const action: AgentActionSuggestion = {
        id: createAgentToolActionId(), type: "delete_habit", title: "删除习惯",
        description: "确认后会删除该习惯及其打卡记录。", content: `- ${habit.name}`,
        date: todayString(), habitIds: [habit.id],
        expectedTargetRevisions: {
          [`habit:${habit.id}`]: recordRevision(habit),
          [`habit-checkins:${habit.id}`]: recordRevision(checkins.filter(item => item.habitId === habit.id))
        }
      };
      return toolReply(`已生成删除「${habit.name}」的确认卡，点击确认后才会删除。`, [action]);
    },
    execute: async () => toolError("删除习惯需先生成确认卡。")
  },
  {
    name: "create_habit",
    description: "创建新习惯打卡。用户说想养成、建立、添加一个习惯时使用。",
    safety: "direct-write",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "习惯名称。" },
        frequencyUnit: { type: "string", enum: ["day", "week"], description: "day 表示每天，week 表示每周。" },
        targetCount: { type: "number", description: "周期内目标次数。" },
        source: { type: "string", enum: ["trades"], description: "交易笔数习惯用 trades，单位笔，每日整数目标。" },
        startDate: { type: "string", description: "用户指定的开始日期，可用中文相对日期。省略为今天。" },
        target: { type: "object", description: "用户明确给出数值目标时，填写单位和每日或每周数值。", properties: {
          kind: { const: "number" }, unit: { type: "string" }, perDay: { type: "number" }, perWeek: { type: "number" }
        }, required: ["kind", "unit"] }
      },
      required: ["name"]
    },
    execute: async (args, context, request) => {
      const name = toolArgString(args, "name");
      if (!name) return toolError("创建习惯缺少名称。");
      const startDate = habitToolDate(args.startDate);
      if (!startDate) return toolError("习惯开始日期无法识别，请核对。");
      let target: HabitInput["target"];
      try { target = validateHabitTarget(args.target); }
      catch (error) { return toolError(error instanceof Error ? error.message : "习惯目标无法核对。"); }
      const operationSource = `lifeops-agent-tool:${request.operationId}`;
      const existing = (await context.store.readHabitDb()).habits.find((habit) => habit.source === operationSource);
      if (existing) {
        return toolReply(`习惯此前已经写入并通过校验：${existing.name}（习惯库 ID：${existing.id}）。`);
      }
      const habit = await context.store.createHabit({
        name,
        frequencyUnit: normalizeFrequencyUnit(toolArgString(args, "frequencyUnit")),
        frequencyInterval: 1,
        targetCount: normalizeTargetCount(args.targetCount),
        target,
        startDate,
        penaltyThreshold: 3,
        color: "#27ae60",
        source: args.source === "trades" ? "trades" : operationSource
      });
      const verified = (await context.store.readHabitDb()).habits.find((item) => item.id === habit.id || item.source === operationSource);
      if (!verified || verified.name !== habit.name || verified.startDate !== startDate
        || recordRevision([verified.target]) !== recordRevision([habit.target])) {
        return toolError(`习惯写入后校验失败，没有确认习惯库中存在：${habit.name}。`);
      }
      await context.refreshViews();
      return toolReply(
        `已创建习惯：${verified.name}${args.startDate === undefined ? "" : `（${startDate} 开始）`}。已从习惯库读回校验（ID：${verified.id}）。`,
        [],
        { kind: "delete_habit", habitId: verified.id }
      );
    }
  },
  {
    name: "complete_habit",
    description: "记录习惯打卡，默认今天。用户给出日期时传 date，实测量传 value 和原单位 unit。",
    safety: "direct-write",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "习惯名称或名称片段。" },
        date: { type: "string", description: "明确完成的日期，可用中文相对日期。省略为今天。" },
        value: { type: "number", minimum: 0, description: "数值习惯本次实测量，以配置的单位填写。" },
        unit: { type: "string", description: "用户明确给出的单位，可省略。" }
      },
      required: ["name"]
    },
    execute: async (args, context) => {
      const name = toolArgString(args, "name");
      const resolution = await resolveHabitByReference(context.store, name);
      if (resolution.kind === "not_found") return toolError(`我想打卡，但没在习惯库里定位到：${name || "未提供习惯名"}。`);
      if (resolution.kind === "ambiguous") {
        return toolError(`找到多个可能的习惯，暂时没有打卡：${resolution.candidates.map((habit) => habit.name).join("、")}。请再说具体一点。`);
      }
      const habit = resolution.item;
      const value = args.value;
      const configuredUnit = habit.target?.kind === "number" ? habit.target.unit : undefined;
      const suppliedUnit = habitMeasurementUnit(args.unit);
      if (configuredUnit && value === undefined) {
        return toolError(`请提供「${habit.name}」本次实际数值（${configuredUnit}）。`);
      }
      if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0
        || !(configuredUnit || suppliedUnit) || args.unit !== undefined && !suppliedUnit)) {
        return toolError("请提供本次实际量和对应单位。");
      }
      if (configuredUnit && suppliedUnit && suppliedUnit !== configuredUnit) return toolError(`请按${configuredUnit}记录「${habit.name}」。`);
      const before = await context.store.readHabitDb();
      const date = habitToolDate(args.date);
      if (!date) return toolError("打卡日期无法识别。");
      const when = date === todayString() ? "今日" : date;
      if (typeof value === "number") await context.store.recordHabitStatus(habit.id, "done", date, "", value, suppliedUnit);
      else await context.store.recordHabitStatus(habit.id, "done", date);
      const verified = (await context.store.readHabitDb()).checkins.find((item) => (
        item.habitId === habit.id && item.date === date && item.status === "done"
      ));
      const previousValue = before.checkins.find(item => item.habitId === habit.id && item.date === date)?.value ?? 0;
      if (!verified || typeof value === "number" && (verified.valueUnit !== (configuredUnit ?? suppliedUnit)
        || verified.value !== Math.max(0, previousValue) + value)) {
        return toolError(`习惯打卡写入后校验失败，没有确认${when}状态：${habit.name}。`);
      }
      await context.refreshViews();
      return toolReply(
        value !== undefined ? `已记录「${habit.name}」本次 ${value} ${verified.valueUnit}，${when === "今日" ? "今天" : when}累计 ${verified.value} ${verified.valueUnit}。`
          : `已完成${when}打卡：${habit.name}。已从习惯库读回校验。`,
        [],
        { kind: "restore_habit_database", database: structuredClone(before) as unknown as Record<string, unknown> }
      );
    }
  },
  {
    name: "miss_habit",
    description: "标记习惯为未完成，默认今天。用户把疲惫、不想做、请假、今天算了、放弃、暂停等表达和习惯名放在一起时使用。用户指定日期时传 date。",
    safety: "direct-write",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "习惯名称或名称片段。" },
        date: { type: "string", description: "用户明确指定的日期，可用中文相对日期。省略为今天。" },
        reason: { type: "string", description: "未完成原因，可省略。" }
      },
      required: ["name"]
    },
    execute: async (args, context) => {
      const name = toolArgString(args, "name");
      const resolution = await resolveHabitByReference(context.store, name);
      if (resolution.kind === "not_found") return toolError(`我想记录未完成，但没在习惯库里定位到：${name || "未提供习惯名"}。`);
      if (resolution.kind === "ambiguous") {
        return toolError(`找到多个可能的习惯，暂时没有修改：${resolution.candidates.map((habit) => habit.name).join("、")}。请再说具体一点。`);
      }
      const habit = resolution.item;
      const before = await context.store.readHabitDb();
      const date = habitToolDate(args.date);
      if (!date) return toolError("未完成日期无法识别。");
      const when = date === todayString() ? "今日" : date;
      await context.store.recordHabitStatus(habit.id, "missed", date, toolArgString(args, "reason"));
      const verified = (await context.store.readHabitDb()).checkins.find((item) => (
        item.habitId === habit.id && item.date === date && item.status === "missed"
      ));
      if (!verified) {
        return toolError(`习惯状态写入后校验失败，没有确认${when}未完成：${habit.name}。`);
      }
      await context.refreshViews();
      return toolReply(
        `已记录${when}未完成：${habit.name}。已从习惯库读回校验。`,
        [],
        { kind: "restore_habit_database", database: structuredClone(before) as unknown as Record<string, unknown> }
      );
    }
  },
  {
    name: "append_journal_entry",
    description: "把用户明确要求保存的内容写入指定日期的早间或晚间日记。文件不存在时创建，存在时追加到指定章节。只在用户明确要求记录、写入或保存日记时使用。",
    safety: "direct-write",
    parameters: {
      type: "object",
      properties: {
        content: { type: "string", description: "要写入日记的正文。应保留用户原意，可做简洁整理，但不能编造。" },
        date: { type: "string", description: "有效日期或相对日期；省略为今天，补记必须指定日期。" },
        period: { type: "string", enum: ["早", "晚"], description: "写入早间还是晚间日记。" },
        heading: { type: "string", description: "二级标题名称，默认“日记”。" }
      },
      required: ["content", "period"]
    },
    execute: async (args, context, request) => {
      const content = toolArgString(args, "content");
      if (!content) return toolError("写日记缺少正文。");
      const suppliedDate = toolArgString(args, "date");
      const date = suppliedDate ? normalizeJournalDate(suppliedDate) : todayString();
      if (!date) return toolError("日记日期无法识别或不存在，请明确有效日期；这次没有写入日记。");
      const period = normalizeJournalPeriod(toolArgString(args, "period"));
      if (!period) return toolError("写日记需要明确是早间还是晚间。");
      const heading = normalizeHeading(toolArgString(args, "heading")) || "日记";
      const path = context.store.dailyNotePath(date, period);
      assertSafeOperationId(request.operationId);
      const marker = `<!-- lifeops-operation:${request.operationId} -->`;
      const before = await context.store.readPath(path);
      const existed = typeof context.store.getFile === "function"
        ? Boolean(context.store.getFile(path))
        : before.length > 0;
      if (before.includes(marker)) {
        return toolReply(`这条日记此前已经写入并通过校验：${path} · ${heading}。`);
      }

      const original = period === "晚" && request.userMessage?.trim() ? request.userMessage : undefined;
      await context.store.appendDaily(date, heading, `${content}\n${marker}`, period, original);
      const verified = await context.store.readPath(path);
      if (!verified.includes(marker) || !verified.includes(content)
        || original !== undefined && !verified.includes(journalOriginalBlock(original))) {
        return toolError(`日记写入后校验失败，没有在 ${path} 读回刚才的内容。`);
      }
      await context.refreshViews();
      return toolReply(
        `已写入并读回校验：${path} · ${heading}。`,
        [],
        { kind: "restore_file", path, content: before, existed }
      );
    }
  },
  {
    name: "list_personal_memory_candidates",
    description: "列出等待用户确认的个人记忆候选及其 ID、类型、置信度和来源。用户问“你准备记住什么”“有哪些待确认记忆”时使用。",
    safety: "safe",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "number", description: "最多返回多少条，默认 10。" }
      }
    },
    execute: async (args, context) => {
      if(!context.store.runFactOperation)return toolReply(await personalMemoryCandidatesText(args,context));
      return executeStoredQuery("list_personal_memory_candidates",args,context);
    }
  },
  {
    name: "review_personal_memory",
    description: "确认、纠正或遗忘一条个人记忆。任何决定都先生成确认卡，用户确认后才修改个人记忆。",
    safety: "ui-confirm",
    parameters: {
      type: "object",
      properties: {
        memoryId: { type: "string", description: "准确的个人记忆 ID，沿用读取结果的原字符，不修剪或猜测其它记录。" },
        decision: { type: "string", enum: ["confirm", "correct", "forget"], description: "确认、纠正或遗忘。" },
        correctedContent: { type: "string", description: "decision=correct 时的正确内容。" }
      },
      required: ["memoryId", "decision"]
    },
    prepareConfirmation: async (args, context, request) => {
      const memoryId = args.memoryId;
      const decision = toolArgString(args, "decision");
      if (typeof memoryId !== "string" || !memoryId.trim()) return toolError("记忆审查需要有效的原文 memoryId。");
      if (!["confirm", "correct", "forget"].includes(decision)) {
        return toolError("记忆审查 decision 必须是 confirm、correct 或 forget。");
      }
      const record = (await context.store.readPersonalMemories()).records.find((item) => item.id === memoryId);
      if (!record || record.status === "forgotten") return toolError("没有找到这个准确编号的可审查个人记忆，请重新读取记忆后再选择。");
      const correctedContent = toolArgString(args, "correctedContent");
      if (decision === "correct" && !correctedContent) {
        return toolError("纠正记忆时需要提供 correctedContent。");
      }
      const action = memoryReviewAction(record.id, record.content, decision as "confirm" | "correct" | "forget", correctedContent, recordRevision(record));
      action.id = `proposal:${request.operationId}:0`;
      return {
        success: true,
        output: `已生成个人记忆${decision==="confirm"?"":memoryDecisionLabel(decision)}确认卡，确认前不会修改。`,
        actions: [await prepareVersionedMemoryReview(action, record, context)]
      };
    },
    execute: async () => toolError("个人记忆审查必须先由 AgentRuntime 生成确认卡。")
  },
  {
    name: "undo_latest_operation",
    description: "明确撤销写入才用。删除须确认。单说撤销用 {}。点名用 taskTitle，只撤创建用 creationOnly。撤记忆用 memoryOnly，先查再撤用 requirePriorQuery。",
    safety: "direct-write",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        taskTitle: { type: "string", description: "用户点名撤销创建某个任务时，填任务准确标题。" },
        creationOnly: { type: "boolean", description: "用户只撤销刚创建的任务时为 true。" },
        memoryOnly: { type: "boolean", description: "用户明确要撤销刚存的记忆时为 true。" },
        requirePriorQuery: { type: "boolean", description: "仅本轮明确要求先查资料再撤销时传 true。单说撤销、撤销刚才那个一律省略。" }
      }
    },
    execute: async (args, context) => {
      if ((args.taskTitle !== undefined && (typeof args.taskTitle !== "string" || !args.taskTitle.trim()))
        || (args.creationOnly !== undefined && typeof args.creationOnly !== "boolean")
        || (args.memoryOnly !== undefined && typeof args.memoryOnly !== "boolean")
        || (args.memoryOnly === true && (args.taskTitle !== undefined || args.creationOnly === true))
        || (args.requirePriorQuery !== undefined && typeof args.requirePriorQuery !== "boolean")) return toolError("撤销参数无效，原记录已保留。");
      const ledger = new OperationLedger(context.store);
      const record = await ledger.latestReversible(args.memoryOnly === true);
      if (!record) return toolError(args.memoryOnly === true ? "没有找到刚才保存的记忆。" : "没找到能确定的刚才那一项，请说具体要撤哪一条。");
      const execution = undoExecutions.get(context), title = execution?.taskTitle;
      const isTaskCreation = record.toolName === "create_task" || record.toolName === "local_createTask";
      const task = isTaskCreation && typeof context.store.taskDbPath === "function" ? createdTaskForUndo(record, context.store.taskDbPath()) : undefined;
      if ((title !== undefined || execution?.taskCreationOnly) && !isTaskCreation
        || title !== undefined && (task?.title ?? record.arguments.title) !== title) {
        return toolError("最近一次可撤销操作不是创建你指定的任务，未撤销其它记录。");
      }
      const result = toolReply(undoReceiptText(record, task));
      await undoRecordedOperation(record.operationId, context, result, record);
      return result;
    }
  },
];

export function getLifeOpsTool(name: string): LifeOpsToolDefinition | undefined {
  return AGENT_TOOLS.find((tool) => tool.name === name);
}

export function agentToolsForChat({ compact = false }: { compact?: boolean } = {}): AiToolDefinition[] {
  return AGENT_TOOLS.map(({ name, description, parameters }) => ({
    name,
    description,
    parameters: compact ? JSON.parse(JSON.stringify(parameters, (key, value: unknown) =>
      key === "description" && typeof value === "string" ? undefined : value)) as Record<string, unknown> : parameters
  }));
}

export function agentToolsForRealtime(): Array<Record<string, unknown>> {
  return AGENT_TOOLS.filter(tool => !["propose_task_plan","propose_trading_research_change","query_trading_research","propose_note_understanding","inspect_note_understanding_source","inspect_weekly_review_sources","propose_weekly_review"].includes(tool.name)).map((tool) => ({
    type: "function",
    name: tool.name,
    description: `${tool.description} 安全等级：${tool.safety}。`,
    parameters: tool.parameters
  }));
}

export async function runConfirmedToolAction(action: AgentActionSuggestion, context: ToolExecutionContext, assertBeforeCommit?: () => Promise<void>): Promise<boolean> {
  // The claim and the write must use the exact approval at entry, even while
  // an awaited Ledger read yields to later changes of the caller's object.
  action=structuredClone(action);context.assertCurrent?.();
  if (action.type === "weekly_review") { action = structuredClone(action); assertWeeklyReviewCard(action, context.store); }
  if (action.type === "note_understanding" || action.type === "review_memory" && action.memorySourceDependenciesHash) {
    action = structuredClone(action); assertNoteUnderstandingCard(action, context.store);
  }
  if(action.type === "trading_change") { action=structuredClone(action);assertTradingConfirmation(action,context.store); }
  if (action.type === "project_change") {
    action = structuredClone(action);
    assertProjectConfirmationPayload(action);
  }
  if (!["delete_task", "delete_habit", "delete_trade", "review_memory", "update_memory", "project_change", "trading_change", "note_understanding", "weekly_review"].includes(action.type)) return false;

  assertSafeOperationId(action.id, MAX_CONFIRMATION_ACTION_ID_LENGTH);
  const projectPrivacyRevision = action.type === "project_change"
    ? recordRevision(context.store.settings.privacy?.excludedVaultPrefixes ?? []) : undefined;
  const ledger = new OperationLedger(context.store);
  const operationId = `confirmed:${action.id}`;
  const claim = await ledger.claim({
    operationId,
    toolName: `confirm_${action.type}`,
    source: "system",
    arguments: confirmedActionArguments(action)
  });
  if (claim.kind === "cached") {
    if (context.store.runFactOperation && ["trading_change", "note_understanding", "weekly_review", "review_memory"].includes(action.type) && await (await import("./dataFoundation/factOperation")).hasPendingFactOperation(context.store)) throw new Error("保存尚未结束，请等待或检查并恢复未完成操作；未重复确认成功。");
    if (claim.record.status === "reverted") throw new Error("这次确认操作已经撤销，不会自动重新执行。");
    if (claim.record.status !== "verified" || claim.record.result?.success !== true) {
      throw new Error("这次确认操作没有成功回执，已停止确认，请重新核对。");
    }
    if (action.type === "note_understanding") {
      // A saved duplicate is not a new approval, but its source must still be
      // current before acknowledging this particular old card as successful.
      const { assertPersonalMemoryDependencies } = await import("./personalMemorySources");
      const payload = action.noteUnderstanding!;
      await assertPersonalMemoryDependencies(createPersonalMemory({ kind: "episode", content: "核对旧卡来源", sourceRefs: [{ sourceId: "old-card", path: payload.path,
        capturedAt: new Date().toISOString(), contentHash: payload.contentHash, extractionVersion: payload.extractionVersion }] }), context.store);
    }
    if (action.type === "weekly_review") {
      await assertWeeklyReviewSaved(action, context);
    }
    if (action.type === "review_memory" && action.memorySourceDependenciesHash) await (await prepareVersionedMemoryReviewGuard(action, context))();
    context.assertCurrent?.();
    return true;
  }
  if (claim.kind === "busy") throw new Error("这个确认操作仍在执行，没有重复写入");
  if (claim.kind === "collision") throw new Error("确认操作 ID 冲突，已停止执行");

  try {
    let resultGuard: import("./projectTools").ProjectTaskResultGuard | undefined;
    let tradingGuard: import("./tradingTools").TradingWriteGuard | undefined;
    let memoryGuard: MemorySourceWriteGuard | undefined;
    await performRecordedToolOperation(context, ledger, operationId, async scoped => {
      if(action.type === "trading_change") tradingGuard=await prepareTradingWriteGuard(action,context);
      if (action.type === "note_understanding") memoryGuard = await prepareNoteUnderstandingWriteGuard(action, context);
      if (action.type === "weekly_review") memoryGuard = await prepareWeeklyReviewGuard(action, context);
      if (action.type === "review_memory" && action.memorySourceDependenciesHash) memoryGuard = await prepareVersionedMemoryReviewGuard(action, context);
      if (action.type === "project_change") resultGuard = await prepareProjectTaskResultGuard(context.store, action.projectCommand!, operationId);
      const result = await executeConfirmedToolAction(action, scoped);
      return { success: true, output: result.output, actions: [], undo: result.undo };
    }, true, action.type === "note_understanding" || action.type === "weekly_review" || action.type === "review_memory" && action.memorySourceDependenciesHash
      ? { assertCurrent: () => { context.assertCurrent?.(); memoryGuard?.assertPolicy(); }, assertBeforeCommit: async () => { await memoryGuard?.(); } }
      : action.type === "trading_change" ? { assertCurrent:()=>{context.assertCurrent?.();tradingGuard?.assertPolicy();},assertBeforeCommit:async()=>{await tradingGuard?.();} } : projectPrivacyRevision ? { assertCurrent: () => {
      resultGuard?.assertPolicy();
      // A guarded Store has a cloned settings snapshot. Check the live policy
      // at commit too, so a newly excluded source cannot authorize an old card.
      if (recordRevision(context.store.settings.privacy?.excludedVaultPrefixes ?? []) !== projectPrivacyRevision) {
        throw new Error("保存期间隐私排除范围发生变化，已停止并恢复本次项目变更；请重新核对。");
      }
    }, assertBeforeCommit: action.projectCommand?.kind === "record_task_result" ? async () => { await resultGuard?.(); } : undefined } : { assertBeforeCommit });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ledger.fail(operationId, message).catch(() => undefined);
    throw error;
  }
}

/** First-party commit options; never included in model arguments or serialized jobs. */
export interface RecordedToolOperationOptions extends FactOperationOptions {
  /** Host-only target snapshots checked against the captured before images
   * while the Fact transaction still owns commit and before Ledger verification. */
  /** WAL still protects every file; user undo may exclude internal control metadata. */
  userUndoPaths?: readonly string[];
  /** Actual Runtime claim for the nested undo transaction; never model input. */
  undoToolClaim?: OperationLedgerRecord;
  /** Parsed actual user text; never accepted from model arguments. */
  undoTaskTitle?: string;
  /** A deictic creation reference still cannot undo a different operation kind. */
  undoTaskCreationOnly?: boolean;
}

export async function performRecordedToolOperation(
  context: ToolExecutionContext,
  ledger: OperationLedger,
  operationId: string,
  execute: (context: ToolExecutionContext) => Promise<ToolExecutionResult>,
  useFactBoundary = true,
  options?: RecordedToolOperationOptions
): Promise<ToolExecutionResult> {
  assertSafeOperationId(operationId);
  const assertCurrent=()=>{context.assertCurrent?.();options?.assertCurrent?.();};
  const operationContext={...context,assertCurrent};
  if(options?.undoToolClaim)undoExecutions.set(operationContext,{host:context.store,operationId,claim:structuredClone(options.undoToolClaim),options:{...options,assertCurrent},taskTitle:options.undoTaskTitle,taskCreationOnly:options.undoTaskCreationOnly});
  // The production Store always provides this capability. Lightweight library
  // adapters keep their existing contract and are not a supported plugin Vault.
  if (useFactBoundary && context.store.runFactOperation) {
    const result = await context.store.runFactOperation({ operationId }, async store => {
      const result = await execute({ ...operationContext, store, refreshViews: async () => undefined });
      if (!result.success) throw new Error(result.output);
      return result;
    }, async (result, undo) => {
      result.undo = options?.userUndoPaths && undo?.kind === "restore_guarded_files"
        ? { kind: "restore_guarded_files", files: undo.files.filter(file => options.userUndoPaths!.includes(file.path)) }
        : undo;
      if (result.undo?.kind === "restore_guarded_files" && !result.undo.files.length) result.undo = undefined;
      await ledger.verify(operationId, result);
    }, {...options,assertCurrent});
    await context.refreshViews().catch(() => undefined);
    return result;
  }
  assertCurrent();
  const result = await execute(operationContext);
  if(getRecordedUndoEvidence(result,context.store,operationId))return result;
  if (result.success) await ledger.verify(operationId, result);
  else await ledger.fail(operationId, result.output, result);
  return result;
}

export async function undoRecordedOperation(operationId: string, context: ToolExecutionContext, toolResult?:ToolExecutionResult,
  expectedLatest?: OperationLedgerRecord): Promise<void> {
  assertSafeOperationId(operationId);
  const ledger = new OperationLedger(context.store);
  if (context.store.runFactOperation) {
    const { fileRevision, preflightFactOperationChanges } = await import("./dataFoundation/factOperation");
    const { serializeJsonData } = await import("./dataFoundation/jsonDataGuard");
    const execution=toolResult?undoExecutions.get(context):undefined;
    if(toolResult&&(!execution||execution.host!==context.store||execution.claim.operationId!==execution.operationId||execution.claim.toolName!=="undo_latest_operation"))throw Error("撤销工具缺少当前执行凭据，未继续修改。");
    let files:GuardedFileChange[]=[];
    await context.store.runFactOperation({ operationId: `undo:${operationId}`, auditId: operationId, auditStatus: "reverted",
      ...(execution?{undoToolOperationId:execution.operationId}:{}) }, async store => {
      if (expectedLatest) {
        const latest = await new OperationLedger(store).latestReversible(execution?.claim.arguments.memoryOnly === true);
        if (latest?.operationId !== operationId || recordRevision(latest) !== recordRevision(expectedLatest)) {
          throw new Error("最近操作在撤销前发生变化，未撤销其它记录。");
        }
      }
      await new OperationLedger(store).revert(operationId, async (descriptor, plannedLedger) => {
        if (descriptor.kind === "restore_guarded_files") {
          const rebased = await rebaseTaskRecordUndo(store, descriptor);
          if (rebased) descriptor = { kind: "restore_guarded_files", files: rebased };
          const ledgerFile = store.getFile(ledger.filePath);
          const before = ledgerFile ? await store.app.vault.read(ledgerFile) : null;
          const after = serializeJsonData(plannedLedger, { compact: true });
          const changes = descriptor.files.map(file => ({ path: file.path, before: file.after, after: file.before,
            beforeHash: file.afterHash, afterHash: file.beforeHash }));
          if (changes.some(file => file.path === ledger.filePath)) throw new Error("撤销描述包含内部历史记录，未开始修改。");
          await preflightFactOperationChanges(store, [...changes,
            { path: ledger.filePath, before, after, beforeHash: fileRevision(before), afterHash: fileRevision(after) }]);
        }
        await executeUndoDescriptor(descriptor, { ...context, store, refreshViews: async () => undefined });
      },
        execution&&toolResult?{claim:execution.claim,result:toolResult}:undefined);
    }, async(_result,undo)=>{
      if(undo?.kind==="restore_guarded_files")files=undo.files.filter(file=>file.path!==ledger.filePath).map(file=>structuredClone(file));
    },{assertCurrent:context.assertCurrent,assertBeforeCommit:execution?.options.assertBeforeCommit,onCommitted:commit=>{
      if(execution&&toolResult&&files.length){undoEvidence.set(toolResult,{host:execution.host,evidence:{operationId:execution.operationId,undoneOperationId:operationId,files:structuredClone(files),journalCommitted:commit?.journalCommitted===true}});execution.options.onCommitted?.(commit);}
    }});
    await context.refreshViews().catch(() => undefined);
    return;
  }
  await ledger.revert(operationId, descriptor => executeUndoDescriptor(descriptor, context));
}

export async function executeUndoDescriptor(
  descriptor: OperationUndoDescriptor,
  context: ToolExecutionContext
): Promise<void> {
  if (context.store.runFactOperation && descriptor.kind !== "restore_guarded_files") {
    throw new Error("这条旧操作没有保存版本信息，无法安全撤销。请使用备份恢复或重新核对修改。");
  }
  if (descriptor.kind === "restore_guarded_files") {
    const { restoreGuardedFiles } = await import("./dataFoundation/factOperation");
    await restoreGuardedFiles(context.store, descriptor.files);
  } else if (descriptor.kind === "delete_task") {
    await context.store.deleteTask(descriptor.taskId);
  } else if (descriptor.kind === "restore_task") {
    const task = descriptor.task as unknown as LifeOpsTask;
    const database = await context.store.readTaskDb();
    const tasks = [...database.tasks.filter((item) => item.id !== task.id), task];
    await context.store.writeTaskDb({ ...database, tasks });
    await context.store.writeTaskMirror(tasks);
  } else if (descriptor.kind === "restore_task_database") {
    const database = descriptor.database as unknown as Awaited<ReturnType<StoreHost["readTaskDb"]>>;
    const current = await context.store.readTaskDb();
    const restored = { ...current, ...database };
    await context.store.writeTaskDb(restored);
    await context.store.writeTaskMirror(restored.tasks);
  } else if (descriptor.kind === "delete_habit") {
    await context.store.deleteHabit(descriptor.habitId);
  } else if (descriptor.kind === "restore_habit_database") {
    const database = descriptor.database as unknown as Awaited<ReturnType<StoreHost["readHabitDb"]>>;
    await context.store.writeHabitDb(database);
    await context.store.writeHabitMirror(database.habits, database.checkins);
  } else if (descriptor.kind === "restore_personal_memory_document") {
    const current = await context.store.readPersonalMemories();
    await context.store.writePersonalMemories(
      { ...current, ...descriptor.document } as Awaited<ReturnType<StoreHost["readPersonalMemories"]>>
    );
    await context.store.writePersonalMemoryReview();
  } else if (descriptor.kind === "restore_file") {
    await restoreFileSnapshot(descriptor, context);
  } else if (descriptor.kind === "restore_files") {
    for (const file of descriptor.files) {
      await restoreFileSnapshot(file, context);
    }
  }
  await context.refreshViews();
}

async function restoreFileSnapshot(
  snapshot: { path: string; content: string; existed: boolean },
  context: ToolExecutionContext
): Promise<void> {
  if (snapshot.existed) {
    await context.store.writeFile(snapshot.path, snapshot.content);
  } else if (context.store.getFile(snapshot.path)) {
    await context.store.deleteFile(snapshot.path);
  }
}

async function rollbackLegacyToolWrite(context: ToolExecutionContext, error: unknown, restore: () => Promise<void>): Promise<never> {
  if (!context.store.runFactOperation) {
    try { await restore(); }
    catch (rollbackError) { throw new AggregateError([error, rollbackError], "写入失败，回退未通过校验。请检查相关记录。"); }
  }
  throw error;
}

async function executeLinkedNoteWrite(
  kind: "knowledge" | "trading",
  args: Record<string, unknown>,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const content = toolArgString(args, "content");
  if (!content) {
    return toolError(kind === "knowledge" ? "知识库内容不能为空。" : "交易模型内容不能为空。");
  }
  const suppliedDate = toolArgString(args, "date");
  const date = suppliedDate ? normalizeJournalDate(suppliedDate) : todayString();
  if (!date) return toolError("记录日期无法识别或不存在，请明确有效日期；这次没有写入笔记或日期记录。");
  const name = linkedNoteName(context.store.settings, kind);
  const config = kind === "knowledge"
    ? {
      notePath: context.store.path(context.store.settings.folders.ideas, name),
      dailyHeading: "灵感",
      successOutput: "已写入知识库和当日知识记录，并完成读回校验。"
    }
    : {
      notePath: context.store.path(context.store.settings.folders.tradingModels, name),
      dailyHeading: "交易",
      successOutput: "已写入交易模型和当日交易学习记录，并完成读回校验。"
    };
  const dailyPath = activityNotePath(context.store, kind === "knowledge" ? "ideas" : "tradingModels", date);
  const snapshots = await Promise.all([
    captureFileSnapshot(config.notePath, context),
    captureFileSnapshot(dailyPath, context)
  ]);
  const dailyLink = `[[${config.notePath.slice(0, -3)}|${name.slice(0, -3)}]]`;

  try {
    if (kind === "knowledge") {
      await context.store.appendKnowledgeNote(content, date);
    } else {
      await context.store.appendTradingModelNote(content, date);
    }
    const [savedNote, savedDaily] = await Promise.all([
      context.store.readPath(config.notePath),
      context.store.readPath(dailyPath)
    ]);
    if (!savedNote.includes(content) || !savedDaily.includes(dailyLink)) {
      throw new Error(`${config.dailyHeading}写入后读回校验失败。`);
    }
  } catch (error) {
    await rollbackLegacyToolWrite(context, error, () => executeUndoDescriptor({ kind: "restore_files", files: snapshots }, context));
  }

  await context.refreshViews();
  return toolReply(config.successOutput, [], { kind: "restore_files", files: snapshots });
}

async function captureFileSnapshot(
  path: string,
  context: ToolExecutionContext
): Promise<{ path: string; content: string; existed: boolean }> {
  const content = await context.store.readPath(path);
  return {
    path,
    content,
    existed: Boolean(context.store.getFile(path)) || content.length > 0
  };
}

async function executeConfirmedToolAction(
  action: AgentActionSuggestion,
  context: ToolExecutionContext
): Promise<{ output: string; undo?: OperationUndoDescriptor }> {
  if (action.type === "project_change") return executeConfirmedProjectChange(action, context);
  if (action.type === "trading_change") return executeConfirmedTradingChange(action, context);
  if (action.type === "note_understanding") return executeNoteUnderstanding(action, context);
  if (action.type === "weekly_review") return executeWeeklyReview(action, context);
  if (action.type === "delete_trade") {
    const id = action.tradeId;
    if (!id) throw new Error("没有定位到要删除的交易。");
    const { deleteTrade } = await import("./features/trading/persistence");
    const trade = await deleteTrade(context.store, id, action.expectedTargetRevisions?.[id] ?? "");
    return { output: `已删除 ${tradeLabel(trade)}。` };
  }
  if (action.type === "update_memory") {
    const fileName = action.memoryFile?.trim() || "当前状态.md";
    if (!isAllowedMemoryFile(fileName)) throw new Error("不支持这个个人记忆文件");
    return saveMemoryNote(action.content.trim(), fileName, `confirmed:${action.id}`, context);
  }

  if (action.type === "delete_task") {
    const taskIds = action.taskIds ?? [];
    if (taskIds.length === 0) throw new Error("没有定位到要删除的任务");
    const before = await context.store.readTaskDb();
    const existingIds = new Set(before.tasks.map((task) => task.id));
    if (taskIds.some((taskId) => !existingIds.has(taskId))) throw new Error("待删除任务已经变化，请重新确认");
    assertConfirmationTargets(action, context, "task", before.tasks.filter(task => taskIds.includes(task.id)));
    const next = { ...before, tasks: before.tasks.filter((task) => !taskIds.includes(task.id)) };
    try {
      await context.store.writeTaskDb(next);
      await context.store.writeTaskMirror(next.tasks);
      const after = await context.store.readTaskDb();
      if (taskIds.some((taskId) => after.tasks.some((task) => task.id === taskId))) {
        throw new Error("任务删除后校验失败");
      }
    } catch (error) {
      await rollbackLegacyToolWrite(context, error, async () => {
        await context.store.writeTaskDb(before);
        await context.store.writeTaskMirror(before.tasks);
      });
    }
    await context.refreshViews();
    return {
      output: `已删除 ${taskIds.length} 个任务，并通过读回校验。`,
      undo: {
        kind: "restore_task_database",
        database: structuredClone(before) as unknown as Record<string, unknown>
      }
    };
  }

  if (action.type === "delete_habit") {
    const habitIds = action.habitIds ?? [];
    if (habitIds.length === 0) throw new Error("没有定位到要删除的习惯");
    const before = await context.store.readHabitDb();
    const existingIds = new Set(before.habits.map((habit) => habit.id));
    if (habitIds.some((habitId) => !existingIds.has(habitId))) throw new Error("待删除习惯已经变化，请重新确认");
    assertConfirmationTargets(action, context, "habit", before.habits.filter(habit => habitIds.includes(habit.id)));
    for(const id of habitIds){
      const expected=action.expectedTargetRevisions?.[`habit-checkins:${id}`];
      if((!expected&&context.store.runFactOperation)||(expected&&expected!==recordRevision(before.checkins.filter(checkin=>checkin.habitId===id))))throw Error("习惯打卡在确认卡生成后变化，或旧卡缺少打卡依据。请重新核对，习惯和打卡均已保留。");
    }
    const next = {
      ...before,
      habits: before.habits.filter((habit) => !habitIds.includes(habit.id)),
      checkins: before.checkins.filter((checkin) => !habitIds.includes(checkin.habitId))
    };
    try {
      await context.store.writeHabitDb(next);
      await context.store.writeHabitMirror(next.habits, next.checkins);
      const after = await context.store.readHabitDb();
      if (habitIds.some((habitId) => after.habits.some((habit) => habit.id === habitId))) {
        throw new Error("习惯删除后校验失败");
      }
    } catch (error) {
      await rollbackLegacyToolWrite(context, error, async () => {
        await context.store.writeHabitDb(before);
        await context.store.writeHabitMirror(before.habits, before.checkins);
      });
    }
    await context.refreshViews();
    return {
      output: `已删除 ${habitIds.length} 个习惯，并通过读回校验。`,
      undo: {
        kind: "restore_habit_database",
        database: structuredClone(before) as unknown as Record<string, unknown>
      }
    };
  }

  if (!action.memoryId || !action.memoryDecision) throw new Error("个人记忆审查信息不完整");
  const before = await context.store.readPersonalMemories();
  const target = before.records.find(record => record.id === action.memoryId);
  if (!target) throw new Error("待审查记忆已经变化，请重新确认");
  if (action.memoryDecision !== "forget" && target.sourceBinding && action.memorySourceDependenciesHash !== target.sourceBinding.dependenciesHash) throw new Error("旧确认卡缺少固定来源版本，请重新核对理解候选。");
  assertConfirmationTargets(action, context, "memory", [target]);
  const sourceRef = {
    sourceId: `confirmed:${action.id}`,
    path: context.store.path(context.store.settings.folders.aiReports, "Operations", "operation-ledger.json"),
    capturedAt: new Date().toISOString()
  };
  const review = action.memoryDecision === "correct"
    ? { decision: "correct" as const, content: action.correctedMemoryContent?.trim() || action.content.trim(), sourceRef }
    : { decision: action.memoryDecision, sourceRef };
  if (review.decision === "correct" && !review.content) throw new Error("纠正后的记忆内容不能为空");
  try {
    const result = await context.store.reviewPersonalMemory(action.memoryId, review);
    if (action.memoryDecision !== "forget" && !result) throw new Error("个人记忆审查后未读回结果");
    const after = await context.store.readPersonalMemories();
    const saved = after.records.find((record) => record.id === action.memoryId);
    const forgetVerified = context.store.runFactOperation ? saved?.status === "forgotten" && Boolean(saved.suppression) : !saved || saved.status === "forgotten";
    if (action.memoryDecision === "forget" ? !forgetVerified : !saved || saved.status !== "active") throw new Error("个人记忆审查后校验失败");
    await context.store.writePersonalMemoryReview();
  } catch (error) {
    await rollbackLegacyToolWrite(context, error, async () => {
      await context.store.writePersonalMemories(before);
      await context.store.writePersonalMemoryReview();
    });
  }
  await context.refreshViews();
  return {
    output: `已完成个人记忆${memoryDecisionLabel(action.memoryDecision)}，并通过读回校验。`,
    undo: {
      kind: "restore_personal_memory_document",
      document: structuredClone(before) as unknown as Record<string, unknown>
    }
  };
}

function confirmedActionArguments(action: AgentActionSuggestion): Record<string, unknown> {
  return {
    type: action.type,
    expectedTargetRevisions: action.expectedTargetRevisions ?? {},
    taskIds: action.taskIds ?? [],
    habitIds: action.habitIds ?? [],
    ...(action.type === "delete_trade" ? { tradeId: action.tradeId } : {}),
    memoryId: action.memoryId ?? "",
    memoryFile: action.memoryFile ?? "",
    memoryDecision: action.memoryDecision ?? "",
    correctedMemoryContent: action.correctedMemoryContent ?? "",
    memoryReviewedContent: action.memoryReviewedContent,
    memorySourceDependenciesHash: action.memorySourceDependenciesHash,
    ...(action.type === "note_understanding" ? { noteUnderstanding: action.noteUnderstanding, noteUnderstandingRevision: action.noteUnderstandingRevision } : {}),
    ...(action.type === "weekly_review" ? { weeklyReview: action.weeklyReview, weeklyReviewPath: action.weeklyReviewPath } : {}),
    content: action.content,
    date: action.date,
    ...(action.type === "project_change" ? {
      projectCommand: action.projectCommand,
      projectRevision: action.projectRevision,
      projectContextRevision: action.projectContextRevision,
      projectReviewHash: action.projectReviewHash
    } : {})
    ,...(action.type === "trading_change" ? {tradingCommand:action.tradingCommand,tradingRevision:action.tradingRevision,tradingContextRevision:action.tradingContextRevision,tradingReviewHash:action.tradingReviewHash} : {})
  };
}

function assertConfirmationTargets(action: AgentActionSuggestion, context: ToolExecutionContext, kind: string, records: Array<{ id: string }>): void {
  for (const record of records) {
    const expected = action.expectedTargetRevisions?.[`${kind}:${record.id}`];
    if ((!expected && context.store.runFactOperation) || (expected && expected !== recordRevision(record))) {
      throw new Error("确认卡对应的记录已经变化，或旧卡缺少版本信息。请重新生成确认卡，原内容已保留。");
    }
  }
}

export function toolReply(
  output: string,
  actions: AgentActionSuggestion[] = [],
  undo?: OperationUndoDescriptor
): ToolExecutionResult {
  return { success: true, output, actions, undo };
}

export function toolError(output: string): ToolExecutionResult {
  return { success: false, output, actions: [] };
}

function undoReceiptText(record: OperationLedgerRecord, task?: LifeOpsTask): string {
  const args = record.arguments;
  if (record.toolName === "create_task" || record.toolName === "local_createTask") {
    const title = task?.title ?? toolArgString(args, "title");
    const date = task?.date ?? toolArgString(args, "date");
    const time = task ? taskScheduleLabel(task) : toolArgString(args, "time");
    const when = [date ? dateDisplay(date) : "", time].filter(Boolean).join(" ");
    return `已撤销创建任务${title ? `「${title}」` : ""}${when ? `（${when}）` : ""}。`;
  }
  const label: Record<string, string> = {
    complete_task: "完成待办", local_completeTask: "完成待办", reschedule_task: "待办改期",
    create_habit: "创建习惯", local_createHabit: "创建习惯", complete_habit: "习惯打卡",
    local_recordHabit: "习惯打卡", local_recordHabitStatus: "习惯打卡",
    append_journal_entry: "日记记录", append_knowledge_note: "知识记录", append_trading_model_note: "交易模型记录",
    record_trade: "交易记录", local_record_trade: "交易记录", append_memory_note: "个人记忆保存",
    observe_personal_memory_candidate: "个人记忆候选保存", confirm_review_memory: "个人记忆审查"
  };
  const name = toolArgString(args, "name") || toolArgString(args, "taskIdOrTitle");
  return `已撤销这次${label[record.toolName] ?? "资料修改"}${name && !name.startsWith("task-") ? `「${name}」` : ""}。`;
}

function toolArgString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function normalizeToolTime(value: string): string {
  const time = value.trim();
  if (!time) return "";
  const colon = time.match(/^(\d{1,2})[:：](\d{2})$/);
  if (colon) return `${colon[1].padStart(2, "0")}:${colon[2]}`;
  const hour = time.match(/(\d{1,2})\s*点(半|(\d{1,2})分?)?/);
  if (!hour) return "";
  const minute = hour[2] === "半" ? "30" : (hour[3] ?? "0").padStart(2, "0");
  return `${hour[1].padStart(2, "0")}:${minute}`;
}

function normalizeFrequencyUnit(value: string): HabitInput["frequencyUnit"] {
  return value === "week" || /周|星期|week/i.test(value) ? "week" : "day";
}

function normalizeTargetCount(value: unknown): number {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : 1;
  return Number.isFinite(numeric) ? Math.max(1, Math.round(numeric)) : 1;
}

function normalizeMaxChars(value: unknown, fallback: number, max: number): number {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : fallback;
  return Number.isFinite(numeric) ? Math.max(120, Math.min(max, Math.round(numeric))) : fallback;
}

function dateDisplay(date: string): string {
  if (date === todayString()) return "今天";
  if (date === addDays(todayString(), 1)) return "明天";
  if (date === addDays(todayString(), 2)) return "后天";
  return date;
}

function habitToolDate(value: unknown): string {
  return value === undefined ? todayString() : typeof value === "string" ? normalizeJournalDate(value) : "";
}

type ReferenceResolution<T> =
  | { kind: "match"; item: T }
  | { kind: "ambiguous"; candidates: T[] }
  | { kind: "not_found" };

async function resolveTaskByReference(store: StoreHost, ref: string, readOnly = false): Promise<ReferenceResolution<LifeOpsTask>> {
  const reference = ref.trim();
  if (!reference) return { kind: "not_found" };
  const database = readOnly ? await store.readTaskDb({ readOnly: true }) : await store.getTaskDashboard();
  // Bind identity before checking whether the requested operation is eligible.
  // A completed or missing old ID must never fall through to another task's ID.
  const exactId = database.tasks.find(task => task.id === reference);
  if (exactId) return { kind: "match", item: exactId };
  if (isTaskIdentifierReference(reference)) {
    return { kind: "not_found" };
  }
  const value = normalizeToolMatchText(reference);
  if (!value) return { kind: "not_found" };
  return resolveBestToolMatch(database.tasks, value, task => [task.title]);
}

async function resolveHabitByReference(store: StoreHost, ref: string): Promise<ReferenceResolution<HabitDefinition>> {
  const value = normalizeToolMatchText(ref);
  if (!value) return { kind: "not_found" };
  const habits = await store.getHabitDefinitions();
  return resolveBestToolMatch(habits, value, (habit) => [habit.id, habit.name]);
}

function deleteTaskToolAction(task: LifeOpsTask): AgentActionSuggestion {
  return {
    id: createAgentToolActionId(),
    type: "delete_task",
    title: "删除任务",
    description: "确认后会从 LifeOps 任务库中真正删除这个任务。",
    content: `- ${task.title}`,
    date: todayString(),
    taskIds: [task.id],
    expectedTargetRevisions: { [`task:${task.id}`]: recordRevision(task) }
  };
}

function memoryAppendAction(content: string, fileName: string): AgentActionSuggestion {
  return {
    id: createAgentToolActionId(),
    type: "update_memory",
    title: "写入个人记忆",
    description: "确认后才会把下面的内容追加到个人记忆；确认前不会修改 Vault。",
    content,
    date: todayString(),
    memoryFile: fileName
  };
}

function isAllowedMemoryFile(fileName: string): boolean {
  return memoryFileNames.includes(fileName);
}

function memoryReviewAction(
  memoryId: string,
  currentContent: string,
  decision: "confirm" | "correct" | "forget",
  correctedContent: string,
  revision: string
): AgentActionSuggestion {
  const nextContent = decision === "correct" ? correctedContent : currentContent;
  return {
    id: createAgentToolActionId(),
    type: "review_memory",
    title: `个人记忆${memoryDecisionLabel(decision)}`,
    description: decision === "forget"
      ? "确认后停止将这条内容作为个人记忆使用，并阻止旧资料自动重建它；原日记和历史备份不会删除。"
      : decision === "correct"
        ? "确认后会保留旧版本并改成下面的正确内容。"
        : "确认后这条候选记忆会成为已确认记忆。",
    content: nextContent,
    date: todayString(),
    memoryId,
    expectedTargetRevisions: { [`memory:${memoryId}`]: revision },
    memoryDecision: decision,
    correctedMemoryContent: decision === "correct" ? correctedContent : undefined
  };
}

function memoryDecisionLabel(decision: string): string {
  if (decision === "correct") return "纠正";
  if (decision === "forget") return "遗忘";
  return "确认";
}

function createAgentToolActionId(): string {
  return `agent-action-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function resolveBestToolMatch<T>(items: T[], ref: string, values: (item: T) => string[]): ReferenceResolution<T> {
  const prepared = items.map(item => ({ item, values: values(item).map(normalizeToolMatchText).filter(Boolean) }));
  const exact = prepared.filter(candidate => candidate.values.includes(ref));
  if (exact.length) return exact.length === 1
    ? { kind: "match", item: exact[0].item }
    : { kind: "ambiguous", candidates: exact.slice(0, 5).map(candidate => candidate.item) };
  // A shared fragment is not more specific because one stored name is longer.
  // Keep unique fragments compatible, but require a choice among all matches.
  const contained = prepared.filter(candidate => candidate.values.some(value => value.includes(ref) || ref.includes(value)));
  if (contained.length > 1) return { kind: "ambiguous", candidates: contained.slice(0, 5).map(candidate => candidate.item) };
  const matches: Array<{ item: T; score: number }> = [];
  for (const item of items) {
    const score = Math.max(...values(item).map((value) => toolMatchScore(ref, normalizeToolMatchText(value))));
    if (score > 0) matches.push({ item, score });
  }
  matches.sort((left, right) => right.score - left.score);
  const best = matches[0];
  if (!best || best.score < 3) return { kind: "not_found" };
  const close = matches.filter((match) => best.score - match.score <= 1);
  if (close.length > 1) {
    return { kind: "ambiguous", candidates: close.slice(0, 5).map((match) => match.item) };
  }
  return { kind: "match", item: best.item };
}

function toolMatchScore(ref: string, target: string): number {
  if (!ref || !target) return 0;
  if (ref === target) return 100;
  if (target.includes(ref) || ref.includes(target)) return Math.max(ref.length, target.length);
  return longestCommonSubstringLength(ref, target);
}

function normalizeToolMatchText(text: string): string {
  return text.replace(/\s+/g, "").replace(/[，,。.!！?？:：;；、"'“”‘’]/g, "").trim();
}

function normalizeJournalPeriod(value: string): "早" | "晚" | null {
  if (value === "早" || /早间|早上|早晨/.test(value)) return "早";
  if (value === "晚" || /晚间|晚上|今晚/.test(value)) return "晚";
  return null;
}

function normalizeHeading(value: string): string {
  return value.replace(/^#+\s*/, "").split(/\r?\n/)[0].trim().slice(0, 40);
}

function longestCommonSubstringLength(a: string, b: string): number {
  let best = 0;
  for (let i = 0; i < a.length; i += 1) {
    for (let j = i + 1; j <= a.length; j += 1) {
      const fragment = a.slice(i, j);
      if (fragment.length > best && b.includes(fragment)) best = fragment.length;
    }
  }
  return best;
}

function truncate(value: string, maxChars: number): string {
  const text = value.trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars).trim()}...`;
}

export async function personalMemoryCandidatesText(args:Record<string,unknown>,context:ToolExecutionContext,record?:import("./sourceReferences").ContextSourceRecorder):Promise<string>{
      const limit = Math.max(1, Math.min(30, normalizeTargetCount(args.limit || 10)));
      if (context.store.runFactOperation && await (await import("./dataFoundation/factOperation")).hasPendingFactOperation(context.store)) throw new Error("理解保存尚未结束，请等待或先检查并恢复未完成操作。");
      const document = context.store.runFactOperation
        ? await (await import("./personalMemorySources")).readPersonalMemoryWithSources(context.store) : await context.store.readPersonalMemories();
      if (!context.store.runFactOperation && document.records.some(record => record.sourceBinding)) throw new Error("固定来源理解需在完整Vault宿主中核对，未提供未经核验内容。");
      const { isVaultPathExcluded } = await import("./privacy");
      const candidates = document.records
        .filter((record) => record.status === "candidate")
        .filter(record => !record.sourceRefs.some(ref => isVaultPathExcluded(ref.path, context.store.settings.privacy?.excludedVaultPrefixes)))
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, limit);
      if (candidates.length === 0) return "当前没有待确认的个人记忆候选。";
      const output = [
        `当前有 ${candidates.length} 条待确认记忆：`,
        ...candidates.map((record) => [
          `- ${record.content}`,
          `  - id: ${record.id}`,
          `  - kind: ${record.kind}`,
          `  - confidence: ${record.confidence.toFixed(2)}`,
          `  - 原文状态：${record[personalMemorySourceAssessment]?.reason ?? "待核对"}`,
          `  - sources: ${record.sourceRefs.map((source) => source.path).join("、") || "无"}`
        ].join("\n"))
      ].join("\n");
      const raw = document[personalMemoryReadSnapshot]?.raw;
      if (typeof raw === "string") record?.(context.store.personalMemoryPath(), output, fileRevision(raw));
      return output;
}
