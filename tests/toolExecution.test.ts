import { describe, expect, it, vi } from "vitest";
import type { StoreHost } from "../src/store/settingsSlice";
import { executeUndoDescriptor, getLifeOpsTool } from "../src/toolRegistry";
import type { HabitDefinition, LifeOpsTask } from "../src/types";

function task(id: string, title: string): LifeOpsTask {
  return {
    id,
    title,
    status: "active",
    priority: "medium",
    quadrant: "important-not-urgent",
    category: "AI建议",
    project: "默认",
    date: "2026-07-27",
    endDate: "2026-07-27",
    time: "",
    dueDate: "2026-07-27",
    dueTime: "",
    repeatUnit: "none",
    repeatInterval: 1,
    repeatUntil: "",
    parentTaskId: "",
    note: "",
    source: "test",
    sourceNotePath: "",
    createdAt: "",
    updatedAt: "",
    completedAt: "",
    completionLog: [],
    sortOrder: 0
  };
}

function habit(id: string, name: string): HabitDefinition {
  return {
    id,
    name,
    frequencyUnit: "day",
    frequencyInterval: 1,
    targetCount: 1,
    startDate: "2026-07-01",
    penaltyThreshold: 3,
    color: "#27ae60",
    createdAt: "2026-07-01T00:00:00.000Z"
  };
}

describe("tool execution target resolution", () => {
  it.each(["complete_habit","miss_habit"])("refuses a shared partial habit reference despite different name lengths: %s",async name=>{
    const recordHabitStatus=vi.fn();const store={getHabitDefinitions:async()=>[habit("short","纯虚构散步20261007"),habit("long","纯虚构散步20261007进阶")],recordHabitStatus} as unknown as StoreHost;
    const result=await getLifeOpsTool(name)!.execute({name:"纯虚构散步"},{store,refreshViews:async()=>{}},{operationId:"fiction-ambiguous-unequal",source:"kimi"});
    expect(result.success).toBe(false);expect(result.output).toContain("多个可能的习惯");expect(recordHabitStatus).not.toHaveBeenCalled();
  });
  it.each(["complete_task","delete_task"])("refuses a shared partial task reference despite different title lengths: %s",async name=>{
    const completeTaskAndLog=vi.fn(),read=async()=>({tasks:[task("short","纯虚构报告"),task("long","纯虚构报告附录校对")]});const store={getTaskDashboard:read,readTaskDb:read,completeTaskAndLog} as unknown as StoreHost;
    const tool=getLifeOpsTool(name)!;const result=await(name==="delete_task"?tool.prepareConfirmation!:tool.execute)({taskIdOrTitle:"纯虚构报"},{store,refreshViews:async()=>{}},{operationId:"fiction-ambiguous-task",source:"kimi"});
    expect(result.success).toBe(false);expect(result.output).toContain("多个可能的任务");expect(result.actions).toEqual([]);expect(completeTaskAndLog).not.toHaveBeenCalled();
  });
  it.each(["英语","长".repeat(120)+"甲"])("preserves a unique short reference or a genuinely exact long name: %s",async ref=>{
    const selected=ref==="英语"?habit("english","学习英语"):habit("exact-long",ref);const definitions=ref==="英语"?[selected]:[selected,habit("other-long",ref+"追加候选")];let recorded=false;
    const store={getHabitDefinitions:async()=>definitions,readHabitDb:async()=>({habits:definitions,checkins:recorded?[{habitId:selected.id,date:new Date().toLocaleDateString("sv-SE"),status:"done"}]:[]}),recordHabitStatus:async(id:string)=>{expect(id).toBe(selected.id);recorded=true;}} as unknown as StoreHost;
    const result=await getLifeOpsTool("complete_habit")!.execute({name:ref},{store,refreshViews:async()=>{}},{operationId:"fiction-exact-or-unique",source:"kimi"});expect(result.success,result.output).toBe(true);expect(recorded).toBe(true);
  });
  it("restores every file in a multi-file undo descriptor", async () => {
    const files = new Map<string, string>([
      ["知识/Cici 知识沉淀.md", "changed knowledge"],
      ["日记/2026-08-15晚.md", "created daily link"]
    ]);
    const store = {
      getFile: (path: string) => files.has(path) ? { path } : null,
      writeFile: async (path: string, content: string) => {
        files.set(path, content);
      },
      deleteFile: async (path: string) => {
        files.delete(path);
      }
    } as unknown as StoreHost;
    let refreshCount = 0;

    await executeUndoDescriptor({
      kind: "restore_files",
      files: [
        { path: "知识/Cici 知识沉淀.md", content: "original knowledge", existed: true },
        { path: "日记/2026-08-15晚.md", content: "", existed: false }
      ]
    }, {
      store,
      refreshViews: async () => {
        refreshCount += 1;
      }
    });

    expect(files.get("知识/Cici 知识沉淀.md")).toBe("original knowledge");
    expect(files.has("日记/2026-08-15晚.md")).toBe(false);
    expect(refreshCount).toBe(1);
  });

  it("does not complete a task when two candidates are equally plausible", async () => {
    let completed = false;
    const store = {
      getTaskDashboard: async () => ({
        tasks: [
          task("task-li", "给李总发材料"),
          task("task-wang", "给王总发材料")
        ]
      }),
      completeTaskAndLog: async () => {
        completed = true;
      }
    } as unknown as StoreHost;
    const tool = getLifeOpsTool("complete_task");

    const result = await tool?.execute({ taskIdOrTitle: "发材料" }, {
      store,
      refreshViews: async () => undefined
    }, {
      operationId: "ambiguous-task",
      source: "kimi"
    });

    expect(result?.success).toBe(false);
    expect(result?.output).toContain("多个可能的任务");
    expect(completed).toBe(false);
  });

  it("does not check in a habit when two candidates are equally plausible", async () => {
    let recorded = false;
    const store = {
      getHabitDefinitions: async () => [
        habit("habit-en-book", "英语读书"),
        habit("habit-en-video", "英语视频")
      ],
      recordHabitStatus: async () => {
        recorded = true;
      }
    } as unknown as StoreHost;
    const tool = getLifeOpsTool("complete_habit");

    const result = await tool?.execute({ name: "英语" }, {
      store,
      refreshViews: async () => undefined
    }, {
      operationId: "ambiguous-habit",
      source: "qwen-omni"
    });

    expect(result?.success).toBe(false);
    expect(result?.output).toContain("多个可能的习惯");
    expect(recorded).toBe(false);
  });
});
