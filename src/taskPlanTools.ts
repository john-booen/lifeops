import type { LifeOpsToolDefinition } from "./toolRegistry";
import { normalizeJournalDate } from "./date";
import type { ProjectJobArguments } from "./projectJobRepository";
import type { StoreHost } from "./store/settingsSlice";

async function assertDraftCapacity(store: StoreHost, tasks: Array<Partial<ProjectJobArguments>>): Promise<void> {
  const [{ readContextTasks }, { taskCapacity, taskDraftRoom }] = await Promise.all([
    import("./contextData"), import("./features/tasks/capacity")
  ]);
  const data = await readContextTasks(store);
  if (!data.available || data.filtered) throw Error("任务记录不完整，暂时无法核对每天的安排量。");
  const { typicalCount } = taskCapacity(data.tasks, new Date());
  const added = new Map<string, number>();
  for (const task of tasks) {
    const date = normalizeJournalDate(task.date ?? "");
    if (!date) throw Error("按节奏安排时，每项任务都需要明确日期。");
    added.set(date, (added.get(date) ?? 0) + 1);
  }
  for (const [date, count] of added) {
    const { existing, remaining } = taskDraftRoom(data.tasks, date, typicalCount);
    if (count > remaining) throw Error(`${date} 已有 ${existing.length} 项，按常态可再安排 ${remaining} 项。请缩减草案后再确认。`);
  }
}

export const TASK_PLAN_TOOL: LifeOpsToolDefinition = {
  name: "propose_task_plan", safety: "ui-confirm",
  description: "提出多步安排确认卡，点击才保存。用户请你安排明天时先查 plan_today(draftTomorrow=true)，直接生成确认卡供其审阅，无需先口头确认。",
  parameters: { type: "object", additionalProperties: false, properties: { capacityAware: { type: "boolean" },
    projectId: { type: "string", description: "可省略；整份安排所属已有项目的精确ID，先query_projects取得。" }, tasks: { type: "array", minItems: 1, maxItems: 8,
    items: { type: "object", additionalProperties: false, properties: {
      title: { type: "string", description: "具体任务名称；用户给出名称时逐字保留。" },
      date: { type: "string", description: "YYYY-MM-DD、今天或明天；预览时固定为实际日期。" },
      time: { type: "string", pattern: "^(?:(?:[01]\\d|2[0-3]):[0-5]\\d)?$", description: "单个开始时间 HH:mm，可省略。" }, category: { type: "string", description: "任务分类，可省略。" }
    }, required: ["title"] } } }, required: ["tasks"] },
  prepareConfirmation: async (args, context, request) => {
    try {
      if (Object.keys(args).some(key => !["tasks", "projectId", "capacityAware"].includes(key))
        || args.capacityAware !== undefined && typeof args.capacityAware !== "boolean"
        || args.projectId !== undefined && typeof args.projectId !== "string"
        || !Array.isArray(args.tasks) || !args.tasks.length || args.tasks.length > 8) throw Error("请提供一至八项具体任务安排及可选已有项目。");
      if (!context.prepareTaskPlan || !request.userMessage?.trim()) throw Error("请在当前对话提出安排，并使用可见确认卡核对。");
      const tasks = args.tasks.map(value => {
        if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("每项安排须有具体任务名称。");
        const item = value as Record<string, unknown>;
        if (Object.keys(item).some(key => !["title", "date", "time", "category"].includes(key)) || typeof item.title !== "string"
          || !item.title.trim() || Object.values(item).some(value => typeof value !== "string")) throw Error("安排包含未支持的字段，请重新提出具体任务。");
        return structuredClone(item) as Partial<ProjectJobArguments> & { title: string };
      });
      if (args.capacityAware === true) await assertDraftCapacity(context.store, tasks);
      const action = await context.prepareTaskPlan(tasks, request.userMessage, request.operationId, typeof args.projectId === "string" ? args.projectId : undefined);
      return { success: true, output: "完整安排已生成确认卡；尚未保存任何任务，请核对后点击确认。", actions: [action] };
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
      const tasks=args.tasks.map(value=>{
        if(!value||typeof value!=="object"||Array.isArray(value))throw Error("每项任务须有具体名称。");
        const item=value as Record<string,unknown>;
        if(Object.keys(item).some(key=>!["title","date","time","category"].includes(key))||typeof item.title!=="string"||!item.title.trim()
          ||Object.values(item).some(v=>typeof v!=="string"))throw Error("任务包含未支持字段，未生成安排。");
        return structuredClone(item) as Partial<ProjectJobArguments>&{title:string};
      });
      const action=await context.prepareProjectWorkPlan(tasks,request.userMessage,request.operationId,args.projectId,
        {text:next.text,...(typeof next.sourcePath==="string"?{sourcePath:next.sourcePath}:{})});
      return{success:true,output:"关联任务与项目下一步已生成完整确认卡；尚未保存，请核对后点击确认。",actions:[action]};
    }catch(error){return{success:false,output:error instanceof Error?error.message:"项目安排未生成，原记录保留。",actions:[]};}
  },
  execute:async()=>({success:false,output:"项目安排只能经可见卡片确认，模型不能直接执行。",actions:[]})
};
