import { describe, expect, it, vi } from "vitest";
import { AgentRuntime } from "../src/agentRuntime";
import type { StoreHost } from "../src/store/settingsSlice";
vi.mock("obsidian", () => ({ Notice: class {}, normalizePath: (path: string) => path }));
const direct = ["请撤销刚才的纯虚构知识记录", "请撤销刚才的纯虚构记忆候选", "请撤销刚才的操作", "撤销上一步", "请撤销上一步的操作", "请撤销刚才操作", "请撤销刚才保存的知识记录", "请撤销刚才保存的目标", "请撤销刚才的回顾更正", "请撤销刚才的个人记忆审查", "请你帮我撤销最近一次写入。", "帮我撤销最近一次", "反悔", "我反悔了", "请恢复上一步", "退回上一步", "undo", "please undo the last operation"];
const denied = ["如果没有变化，请撤销刚才的纯虚构知识记录", "请撤销刚才的操作，但只有资料没有变化才执行", "只有确认原文没有变化，才撤销刚才的操作", "若核对通过，撤销上一步", "一旦检查完成就撤销刚才的记录", "除非来源变化，请撤销上一步", "等我检查完成之后，再撤销刚才的操作", "待我确认，再撤销刚才的记录", "核对完以后再撤销上一步", "不要撤销刚才的记录", "请撤销刚才的记录。算了，不要撤销", "是否撤销刚才的记录？", "解释撤销上一步", "他说“撤销上一步”", "请保存到知识笔记：请撤销上一步", "请保存到知识笔记：如果下雨，请撤销上一步", "撤销功能很好", "撤销刚才操作未成功", "刚才的撤销已经完成", "请撤销两次", "请撤销2026-10-08那篇日记",
  "请撤销刚才的操作，确认原文无变化再撤销记录",
  "请撤销刚才的操作；核对通过才执行撤销操作",
  "请撤销刚才两次写入的记录",
  "请撤销最近一次之前的操作",
  "请撤销刚才的操作，再撤销上一步记录",
  "请撤销刚才确认通过才执行的操作",
  "请撤销刚才的操作并撤销上一步记录",
  "请撤销刚才的操作同时保存到知识记录",
  "请撤销刚才2026-10-08的日记",
  "请撤销刚才更早的操作",
  "请撤销刚才第二次写入的记录",
  "请撤销刚才三次写入的记录",
  "请撤销刚才的操作。请保存记录",
  "撤销上一步指的是恢复记录",
  "撤销上一步是系统提供的操作",
  "撤销刚才的记录指的是恢复操作",
  "撤销刚才的操作会恢复原记录",
  "请撤销刚才的操作会恢复原记录"];
function runtimeProbe() {
  const readJson=vi.fn(), writeJson=vi.fn();
  const runtime=new AgentRuntime({store:{settings:{folders:{aiReports:"纯虚构AI"}},path:(...p:string[])=>p.join("/"),readJson,writeJson} as unknown as StoreHost,refreshViews:async()=>undefined});
  const claim=vi.fn(async()=>{throw new Error("Stop before audit or actual undo in this read-only probe");});
  (runtime as unknown as {operationLedger:{claim:typeof claim}}).operationLedger.claim=claim;
  return{runtime,claim,readJson,writeJson};
}
describe("typed undo with an optional actual prior query",()=>{
  it.each(["请查询后撤销上一步", "请先查询再撤销上一步", "请查询后再撤销上一步"])("needs a live host query before executing the explicit sequence: %s",async text=>{
    const p=runtimeProbe(),r=await p.runtime.executeAiToolCall({id:"sequence-without-read",name:"undo_latest_operation",arguments:{requirePriorQuery:true,querySucceeded:true}},"kimi",text);
    expect(r.success).toBe(false);expect(r.output).toContain("本轮查询尚未成功核对");expect(p.claim).not.toHaveBeenCalled();expect(p.readJson).not.toHaveBeenCalled();expect(p.writeJson).not.toHaveBeenCalled();
  });
  it("permits a query-then-undo only after its host callback succeeds",async()=>{
    const p=runtimeProbe(),prior=vi.fn(async()=>{}),current=vi.fn();
    await p.runtime.executeAiToolCall({id:"sequence-owned-read",name:"undo_latest_operation",arguments:{requirePriorQuery:true}},"qwen-omni","请查询后撤销上一步",{assertCurrent:current,assertPriorQuery:prior});
    expect(prior).toHaveBeenCalledOnce();expect(current).toHaveBeenCalled();expect(p.claim).toHaveBeenCalledOnce();expect(p.readJson).not.toHaveBeenCalled();expect(p.writeJson).not.toHaveBeenCalled();
  });
  it.each(["failed-query","stopped-host"])("denies a sequence without an active successful host read: %s",async kind=>{
    const p=runtimeProbe();let stopped=false;
    const r=await p.runtime.executeAiToolCall({id:"sequence-invalid-read",name:"undo_latest_operation",arguments:{requirePriorQuery:true}},"qwen-omni","请查询后撤销上一步",{assertCurrent:()=>{if(stopped)throw Error("Stopped host");},assertPriorQuery:async()=>{if(kind==="failed-query")throw Error("No successful query");stopped=true;}});
    expect(r.success).toBe(false);expect(p.claim).not.toHaveBeenCalled();expect(p.readJson).not.toHaveBeenCalled();expect(p.writeJson).not.toHaveBeenCalled();
  });
  it.each(direct)("keeps a direct single latest undo: %s",async text=>{
    const p=runtimeProbe(),r=await p.runtime.executeAiToolCall({id:"undo-direct",name:"undo_latest_operation",arguments:{}},"kimi",text);
    expect(p.claim).toHaveBeenCalledOnce();expect(r.success).toBe(false);expect(r.actions).toEqual([]);expect(p.readJson).not.toHaveBeenCalled();expect(p.writeJson).not.toHaveBeenCalled();
  });
});
