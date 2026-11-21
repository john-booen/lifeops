import { AgentRuntime } from "../../src/agentRuntime";
import { runConfirmedToolAction } from "../../src/toolRegistry";
import type { StoreHost } from "../../src/store/settingsSlice";
import { readSummaryScope,renderSummary,summaryPath } from "../../src/features/summaries/notes";
import { summaryPeriod } from "../../src/features/summaries/periods";

/** Fictional fixture only; correction uses the real proposal/confirmation path. */
export async function prepareCorrectedCrossWeekFixture(store: StoreHost): Promise<void> {
  const original="我只在周三上午09:30有空做虚构纸样归档，适合安排25分钟。";
  const corrected="我只在周三晚上19:30有空做虚构纸样归档，适合安排25分钟。";
  const path=store.path(store.settings.folders.ideas,"虚构纸样归档偏好.md");await store.writeFile(path,original);
  const memory=await store.upsertPersonalMemory({kind:"user_rule",content:original,sourceRefs:[{sourceId:"fictional-cross-week-preference",path,capturedAt:new Date().toISOString()}]});
  await store.reviewPersonalMemory(memory.id,{decision:"confirm"});
  const scope=await readSummaryScope(store);
  for(const row of [
    {day:"2026-10-28",text:"10月28日虚构纸样归档：一段连续25分钟完成蓝纸样12张；一次零碎间隙只完成4张。"},
    {day:"2026-11-04",text:"11月4日虚构纸样归档：一段连续25分钟完成黄纸样11张；一次零碎间隙只完成3张。"}
  ]){
    const period=summaryPeriod("week",row.day);
    await store.appendDaily(row.day,"日记",row.text,"晚",row.text);
    await store.writeFile(summaryPath(store,period),renderSummary(period,period.to,scope.hash,
      {tasksCompleted:null,taskCompletionPercent:null,energy:null,tradePnlCny:null,tradePnlUsd:null},2,true,"model",row.text+"上午归档更好。"));
  }
  const context={store,refreshViews:async()=>{}},runtime=new AgentRuntime(context);
  const proposal=await runtime.executeAiToolCall({id:"fictional-cross-week-correction",name:"review_personal_memory",
    arguments:{memoryId:memory.id,decision:"correct",correctedContent:corrected}},"kimi");
  if(!proposal.success||proposal.actions.length!==1)throw Error("虚构跨周记忆更正确认未生成。");
  await runConfirmedToolAction(proposal.actions[0],context);
}
