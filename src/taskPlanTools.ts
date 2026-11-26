import { TASK_PLAN_FIELDS } from './features/tasks/scheduleUpdate';
import { TASK_DEADLINE_PROPERTIES } from './features/tasks/deadlineInput';
import type { LifeOpsToolDefinition } from "./toolRegistry";
import { normalizeJournalDate } from "./date";
import type { ProjectJobArguments } from "./projectJobRepository";
import type { StoreHost } from "./store/settingsSlice";
import { isTaskWindow } from "./taskSchedule";

export async function draftCapacityNotice(store: StoreHost, tasks: Array<Partial<ProjectJobArguments>>): Promise<string> {
  const [{ readContextTasks }, { taskCapacity, taskDraftRoom }] = await Promise.all([
    import("./contextData"), import("./features/tasks/capacity")
  ]);
  const data = await readContextTasks(store);
  if (!data.available || data.filtered) return "任务记录不完整，无法完整核对负荷；保留整份草案，不因资料不足限制数量。";
  const { typicalCount } = taskCapacity(data.tasks, new Date());
  const added = new Map<string, number>();
  for (const task of tasks) {
    const date = normalizeJournalDate(task.date ?? "");
    if (!date && (task.dueDate !== undefined || task.dueTime !== undefined)) continue;
    if (!date) throw Error("按节奏安排时，每项任务都需要明确日期。");
    if (isTaskWindow({date,endDate:task.endDate?normalizeJournalDate(task.endDate):"",startTime:task.startTime,endTime:task.endTime,scheduleMode:task.scheduleMode})) continue;
    added.set(date, (added.get(date) ?? 0) + 1);
  }
  const notices: string[] = [];
  for (const [date, count] of added) {
    const { existing, remaining } = taskDraftRoom(data.tasks, date, typicalCount);
    if (typicalCount !== null && count > remaining) notices.push(`${date}已有${existing.length}项，本次另安排${count}项，高于近期常态；这只是负荷提醒，不阻止保存。`);
  }
  return notices.join(" ");
}

/** Shared validation for the original plan card and a mixed task-only card. */
export function taskPlanDraft(args: Record<string, unknown>): Array<Partial<ProjectJobArguments> & {title:string}> {
  const unknown = Object.keys(args).filter(key => !["tasks", "projectId", "capacityAware"].includes(key));
  if (unknown.length) throw Error(`propose_task_plan 不接受字段 ${unknown.join("、")}；顶层只保留 tasks、可选 projectId 和 capacityAware。每项任务使用 title、可选 date、time、category、计划区间和独立必须截止字段。`);
  if (args.capacityAware !== undefined && typeof args.capacityAware !== "boolean"
    || args.projectId !== undefined && typeof args.projectId !== "string"
    || !Array.isArray(args.tasks) || !args.tasks.length || args.tasks.length > 8) throw Error("请提供一至八项具体任务安排及可选已有项目。");
  return args.tasks.map(value => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("每项安排须有具体任务名称。");
    const item = value as Record<string, unknown>;
    const unsupported = Object.keys(item).filter(key => !["title", "category", "estimateMin", ...TASK_PLAN_FIELDS].includes(key));
    if (unsupported.length) throw Error('安排包含未支持的字段：'+unsupported.join('、')+'。请按工具字段定义修正，保留任务与已明确日期/时刻，不保存。');
    if(item.estimateMin!==undefined&&(typeof item.estimateMin!=='number'||!Number.isFinite(item.estimateMin)||item.estimateMin<=0))throw Error('预计用时须为大于零的分钟数，本批尚未保存。');
    const wrongType = Object.keys(item).filter(key => key!=='estimateMin'&&typeof item[key] !== 'string');
    if (wrongType.length) throw Error('安排字段须为文字：'+wrongType.join('、')+'；未填写的可选字段请省略，不使用null或数字。尚未保存。');
    if (typeof item.title !== 'string' || !item.title.trim()) throw Error('每项安排须有具体任务名称。');
    const task = structuredClone(item) as Partial<ProjectJobArguments> & {title:string};
    if (task.date) {
      const date = normalizeJournalDate(task.date);
      if (!date) throw Error("草案包含无法识别的日期，请先核对。");
      task.date = date;
    }
    return task;
  });
}

export const TASK_PLAN_TOOL: LifeOpsToolDefinition = {
  name: "propose_task_plan", safety: "ui-confirm",
  description: "用户要求先看草案或确认卡时，提出完整多步安排，点击一次保存全部。明确要求直接排程并保存多项新任务用 schedule_task_batch。历史常态量仅作提醒，不限制任务数量。",
  parameters: { type: "object", additionalProperties: false, properties: { capacityAware: { type: "boolean" },
    projectId: { type: "string", description: "可省略；整份安排所属已有项目的精确ID，先query_projects取得。" }, tasks: { type: "array", minItems: 1, maxItems: 8,
    items: { type: "object", additionalProperties: false, properties: {
      title: { type: "string", description: "具体任务名称；用户给出名称时逐字保留。" },
      estimateMin:{type:'number',exclusiveMinimum:0,description:'用户明确提供的预计分钟数；与安排区间、独立必须截止分别保留。'},
      date: { type: "string", description: "明确日期或中文相对日期，生成预览时固定到具体日期。" },
      time: { type: "string", pattern: "^(?:(?:[01]\\d|2[0-3]):[0-5]\\d)?$", description: "单个开始时间 HH:mm，可省略。" }, category: { type: "string", description: "任务分类，可省略。" }, endDate:{type:"string",description:"跨天或期间计划完成日期，和必须截止独立。"}, startTime:{type:"string",description:"明确的计划开始HH:mm，不猜测。"}, endTime:{type:"string",description:"计划结束或希望做完HH:mm；不是必须截止。"}, scheduleMode:{type:"string",enum:["fixed","window"],description:"window为期间分次完成，fixed为固定安排。"}, ...TASK_DEADLINE_PROPERTIES
    }, required: ["title"] } } }, required: ["tasks"] },
  prepareConfirmation: async (args, context, request) => {
    try {
      const tasks = taskPlanDraft(args);
      if (!context.prepareTaskPlan || !request.userMessage?.trim()) throw Error("请在当前对话提出安排，并使用可见确认卡核对。");
      const notice = args.capacityAware === true ? await draftCapacityNotice(context.store, tasks) : "";
      const action = await context.prepareTaskPlan(tasks, request.userMessage, request.operationId, typeof args.projectId === "string" ? args.projectId : undefined);
      return { success: true, output: "完整安排已生成确认卡；尚未保存任何任务，请核对后点击确认。" + notice, actions: [action] };
    } catch (error) { return { success: false, output: error instanceof Error ? error.message : "安排卡未生成，原记录保留。", actions: [] }; }
  },
  execute: async () => ({ success: false, output: "任务安排必须由可见卡片确认；模型不能直接执行这份计划。", actions: [] })
};

/** The model can propose only this bounded combination; execution stays in a host-only versioned Job. */
export const PROJECT_WORK_PLAN_TOOL: LifeOpsToolDefinition = {
  name:"propose_project_work_plan",safety:"ui-confirm",
  description:"提出已有项目的1至7项任务及下一步确认卡，点击逐项保存，中断可恢复。先查准确projectId；原样保留标题和下一步，不推断完成或沿用旧来源。",
  parameters:{type:"object",additionalProperties:false,properties:{
    projectId:{type:"string",description:"query_projects返回的精确已有项目ID，不猜测或另建项目。"},
    tasks:{...(TASK_PLAN_TOOL.parameters.properties as Record<string,Record<string,unknown>>).tasks,maxItems:7},
    nextStep:{type:"object",additionalProperties:false,description:"仅text及可选sourcePath；无来源时省略，不填source或null。",properties:{text:{type:"string",description:"用户明确给出的下一步原文；不加上已经完成或未经确认的推断。"},sourcePath:{type:"string",description:"已核对可读的笔记路径；本次输入则省略，不填null或source。"}},required:["text"]}
  },required:["projectId","tasks","nextStep"]},
  prepareConfirmation:async(args,context,request)=>{
    try{
      if(Object.keys(args).some(key=>!["projectId","tasks","nextStep"].includes(key))||typeof args.projectId!=="string"||!args.projectId.trim()
        ||!Array.isArray(args.tasks)||args.tasks.length<1||args.tasks.length>7||!args.nextStep||typeof args.nextStep!=="object"||Array.isArray(args.nextStep)
        ||!context.prepareProjectWorkPlan||!request.userMessage?.trim())throw Error("请核对已有项目、一至七项任务和明确下一步。");
      const next=args.nextStep as Record<string,unknown>;
      if(Object.keys(next).some(key=>!["text","sourcePath"].includes(key))||typeof next.text!=="string"||!next.text.trim()
        ||next.sourcePath!==undefined&&typeof next.sourcePath!=="string")throw Error("请提供下一步原文和可选已核对来源。");
      const tasks=taskPlanDraft({tasks:args.tasks});
      const action=await context.prepareProjectWorkPlan(tasks,request.userMessage,request.operationId,args.projectId,
        {text:next.text,...(typeof next.sourcePath==="string"?{sourcePath:next.sourcePath}:{})});
      return{success:true,output:"关联任务与项目下一步已生成完整确认卡；尚未保存，请核对后点击确认。",actions:[action]};
    }catch(error){return{success:false,output:error instanceof Error?error.message:"项目安排未生成，原记录保留。",actions:[]};}
  },
  execute:async()=>({success:false,output:"项目安排只能经可见卡片确认，模型不能直接执行。",actions:[]})
};
