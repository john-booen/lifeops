import {buildTaskFromInput} from "./vaultApi";
import {taskScheduleLabel} from "./taskSchedule";
import {taskDeadlineLabel} from "./features/tasks/deadlineInput";
import { randomUUID } from "node:crypto";
import { formatDate } from "./date";
import { isSafeOperationId, MAX_CONFIRMATION_ACTION_ID_LENGTH, recordRevision } from "./operationIdentity";
import { createPersonalMemoryContextFilter, personalMemoryContextRevision } from "./personalMemoryContext";
import { readPersonalMemoryWithSources } from "./personalMemorySources";
import { assertProjectTaskBaselineCurrent } from "./projectToolContinuity";
import type { ProjectJobRunner, ProjectJobReview, ProjectJobInspection } from "./projectJobRunner";
import type { ProjectJobArguments } from "./projectJobRepository";
import type { StoreHost } from "./store/settingsSlice";
import { PROJECT_STATE_LABELS } from "./projectContinuity";

export interface TaskPlanReviewAction {
  id: string; type: "task_plan"; title: string; description: string; content: string; date: string; taskPlanToken: string;
}
const actionKeys = ["id", "type", "title", "description", "content", "date", "taskPlanToken"];
function signature(action: TaskPlanReviewAction): string {
  // Runtime replaces the proposal ID; the private capability binds its entire displayed meaning instead.
  const { id: _id, ...payload } = action; return recordRevision(payload);
}
function stale(): never { throw new Error("这张安排卡已失效或已处理，请重新提出并核对；没有重复创建任务。"); }

/** Volatile pre-authorization cards only. Once clicked, Job/Fact/Ledger own durable execution. */
export class TaskPlanReviewRegistry {
  private readonly reviews = new Map<string, { review: ProjectJobReview; signature: string; action: TaskPlanReviewAction; proposalId?: string; inputSignature: string }>();
  constructor(private readonly store: StoreHost, private readonly runner: () => ProjectJobRunner,
    private readonly assertCurrent: () => void = () => {}, private readonly now: () => Date = () => new Date()) {}

  async prepare(tasks: Array<Partial<ProjectJobArguments> & { title: string }>, userMessage: string,
    sourcePaths: readonly string[] = [], proposalId?: string, projectId?: string,
    assertProposalCurrent?: () => void): Promise<TaskPlanReviewAction> {
    return this.prepareCard(tasks,userMessage,sourcePaths,proposalId,projectId,undefined,assertProposalCurrent);
  }
  async prepareWorkPlan(tasks:Array<Partial<ProjectJobArguments>&{title:string}>,userMessage:string,
    sourcePaths:readonly string[],proposalId:string|undefined,projectId:string,nextStep:{text:string;sourcePath?:string},
    assertProposalCurrent?:()=>void):Promise<TaskPlanReviewAction>{
    return this.prepareCard(tasks,userMessage,sourcePaths,proposalId,projectId,nextStep,assertProposalCurrent);
  }
  private async prepareCard(tasks: Array<Partial<ProjectJobArguments> & { title: string }>, userMessage: string,
    sourcePaths: readonly string[], proposalId?: string, projectId?: string, nextStep?: {text:string;sourcePath?:string},
    assertProposalCurrent?:()=>void): Promise<TaskPlanReviewAction> {
    this.assertCurrent(); assertProposalCurrent?.();
    const inputSignature = recordRevision({ tasks, userMessage, sourcePaths, ...(projectId ? { projectId } : {}),
      ...(nextStep?{format:"project-work-plan-v2",nextStep}:{}) });
    const previous = proposalId ? [...this.reviews.values()].find(item => item.proposalId === proposalId) : undefined;
    if (previous) return this.reuse(previous, inputSignature, assertProposalCurrent);
    if (this.reviews.size >= 16) throw new Error("尚有较多未处理的安排卡，请先处理原卡，再提出新安排。");
    const review = nextStep ? await this.runner().prepareWorkPlan(structuredClone(tasks),userMessage,[...sourcePaths],projectId!,structuredClone(nextStep))
      : await this.runner().prepare(structuredClone(tasks), userMessage, [...sourcePaths], undefined, projectId);
    const binding = review.job.projectBinding;
    const content = [binding ? `所属目标：${binding.goalTitle}\n关联项目：${binding.title}\n项目阶段：${PROJECT_STATE_LABELS[binding.state]}\n每项新任务会同时关联此项目；任务仍为待办，项目阶段保持原值。` : "",
      review.job.steps.map((step, index) => step.toolName==="create_task"
        ? `${index + 1}. ${step.arguments.title}\n日期：${step.arguments.date || "未安排日期"}\n时间：${step.arguments.endDate !== undefined || step.arguments.startTime !== undefined || step.arguments.endTime !== undefined || step.arguments.scheduleMode !== undefined ? taskScheduleLabel(buildTaskFromInput(step.arguments,new Date(review.job.createdAt))) || "未设时间" : step.arguments.time || "未设时间"}${step.arguments.dueDate ? "\n"+taskDeadlineLabel({dueDate:step.arguments.dueDate,dueTime:step.arguments.dueTime??""}) : ""}\n分类：${step.arguments.category}${step.arguments.estimateMin!==undefined?"\n预计用时："+step.arguments.estimateMin+"分钟":""}`
        : `${index+1}. 更新项目下一步\n原下一步：${review.nextStepBefore?.text||"未设置"}\n原来源：${review.nextStepBefore?.sourcePath||"本次输入"}\n改为：${step.arguments.text}\n新来源：${step.arguments.sourcePath||"本次输入，不沿用原来源"}\n原回顾与历史保留，当前下一步依据改为以上内容。`).join("\n\n")].filter(Boolean).join("\n\n");
    const action: TaskPlanReviewAction = { id: `task-plan:${randomUUID()}`, type: "task_plan", title: nextStep
      ? `保存 ${tasks.length} 项任务安排，并更新项目下一步` : `保存 ${review.job.steps.length} 项任务安排`,
      description: "核对完整安排后，点击确认才逐项保存；任务仍为待办，中断后可检查并恢复。", content,
      date: formatDate(new Date(review.job.createdAt)), taskPlanToken: randomUUID() };
    const memory = await readPersonalMemoryWithSources(this.store);
    const text = `${action.title}\n${action.description}\n${action.content}`;
    if (createPersonalMemoryContextFilter(memory.records)(text) !== text
      || personalMemoryContextRevision(memory.records) !== review.job.baseline.memoryRevision) {
      throw new Error("安排包含已更正、遗忘或暂不可用的依据，请重新提出当前可确认内容。");
    }
    await assertProjectTaskBaselineCurrent(this.store, review.job.baseline);
    this.assertCurrent(); assertProposalCurrent?.();
    const concurrent = proposalId ? [...this.reviews.values()].find(item => item.proposalId === proposalId) : undefined;
    if (concurrent) return this.reuse(concurrent, inputSignature, assertProposalCurrent);
    if (this.reviews.size >= 16) throw new Error("尚有较多未处理的安排卡，请先处理原卡，再提出新安排。");
    this.reviews.set(action.taskPlanToken, { review, signature: signature(action), action, proposalId, inputSignature });
    return structuredClone(action);
  }
  private async reuse(stored: { review: ProjectJobReview; action: TaskPlanReviewAction; inputSignature: string }, inputSignature: string,
    assertProposalCurrent?:()=>void): Promise<TaskPlanReviewAction> {
    if (stored.inputSignature !== inputSignature || this.now().getTime() >= Date.parse(stored.review.job.deadlineAt)) stale();
    await assertProjectTaskBaselineCurrent(this.store, stored.review.job.baseline); this.assertCurrent(); assertProposalCurrent?.();
    if (this.reviews.get(stored.action.taskPlanToken) !== stored) stale();
    return structuredClone(stored.action);
  }

  /** Delivery does not consume a card; recheck after any reply/filter awaits before showing it. */
  async assertDeliverable(action: TaskPlanReviewAction, assertDeliveryCurrent?: () => void): Promise<void> {
    this.assertCurrent(); assertDeliveryCurrent?.();
    const submitted = structuredClone(action);
    if (Object.keys(submitted).some(key => !actionKeys.includes(key)) || submitted.type !== "task_plan"
      || !isSafeOperationId(submitted.id, MAX_CONFIRMATION_ACTION_ID_LENGTH)) stale();
    const stored = this.reviews.get(submitted.taskPlanToken);
    if (!stored || stored.signature !== signature(submitted) || this.now().getTime() >= Date.parse(stored.review.job.deadlineAt)) stale();
    await assertProjectTaskBaselineCurrent(this.store, stored.review.job.baseline);
    this.assertCurrent(); assertDeliveryCurrent?.();
    if (this.reviews.get(submitted.taskPlanToken) !== stored || this.now().getTime() >= Date.parse(stored.review.job.deadlineAt)) stale();
  }

  start(action: TaskPlanReviewAction, signal?: AbortSignal): Promise<ProjectJobInspection> {
    this.assertCurrent();
    const submitted = structuredClone(action);
    if (Object.keys(submitted).some(key => !actionKeys.includes(key)) || submitted.type !== "task_plan"
      || !isSafeOperationId(submitted.id, MAX_CONFIRMATION_ACTION_ID_LENGTH)) stale();
    const stored = this.reviews.get(submitted.taskPlanToken);
    if (!stored || stored.signature !== signature(submitted)) stale();
    if (this.now().getTime() >= Date.parse(stored.review.job.deadlineAt)) {
      this.reviews.delete(submitted.taskPlanToken); stale();
    }
    // Consume synchronously before any async authorization; concurrent/replayed clicks cannot start again.
    this.reviews.delete(submitted.taskPlanToken);
    return this.runner().startConfirmed(stored.review, signal);
  }

  dismiss(action: TaskPlanReviewAction): void {
    const stored = this.reviews.get(action.taskPlanToken);
    if (stored?.signature === signature(action)) this.reviews.delete(action.taskPlanToken);
  }
  clear(): void { this.reviews.clear(); }
}
