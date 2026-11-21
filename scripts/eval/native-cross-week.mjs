/** Native UI uses a synthetic model; separate live evaluation checks model understanding. */
import assert from "node:assert/strict";
import {join} from "node:path";

export async function crossWeekUi(page,root,result) {
  assert.equal(process.env.GITHUB_ACTIONS,"true");assert.equal(process.env.RUNNER_OS,"macOS");
  const observed=await page.evaluate(async()=>{
    const p=app.plugins.getPlugin("lifeops-assistant"),original="虚构纸样归档只能安排周三09:30。",corrected="虚构纸样归档只能安排周三19:30，25分钟。";
    const before=await p.store.readPath(p.store.taskDbPath()),path=p.store.path(p.settings.folders.ideas,"虚构归档原文.md");
    await p.store.writeFile(path,original);
    const row=await p.store.upsertPersonalMemory({kind:"user_rule",content:original,sourceRefs:[{sourceId:"fictional-native-cross-week",path,capturedAt:new Date().toISOString()}]});
    await p.store.reviewPersonalMemory(row.id,{decision:"confirm"});
    for(const [date,text] of [["2026-10-28","虚构纸样归档：连续25分钟完成12张，零碎间隙4张。"],["2026-11-04","虚构纸样归档：连续25分钟完成11张，零碎间隙3张。"],["2026-11-05","虚构今天只整理读书卡片。"]])await p.store.appendDaily(date,"日记",text,"晚",text);
    const memory=(await p.store.readPersonalMemories()).records.find(item=>item.id===row.id);
    const cards=await p.prepareStewardMemoryReview(memory,{decision:"correct",content:corrected});
    if(cards.length!==1)throw Error("Native fixture correction card missing");await p.executeAgentAction(cards[0]);
    const context=await p.store.buildPersonalMemoryContext();
    if(context.includes(original)||context.includes("confidence:"))throw Error("Old wording or ranking score entered conversation evidence");
    p.settings.ai={...p.settings.ai,provider:"custom",endpoint:"https://fiction.invalid/chat",apiKey:"fictional-key",model:"synthetic",fallbackProvider:"off",dataDisclosureAccepted:true};
    p.settings.privacy={...p.settings.privacy,plaintextCredentialStorageAccepted:true};
    let evidence,calls=0;
    const mock=async messages=>{
      calls++;
      const output=messages.filter(message=>message.role==="tool").map(message=>{try{return JSON.parse(message.content);}catch{return null;}}).find(item=>item?.originalEvidence);
      if(!output)return{content:"",toolCalls:[{id:"fictional-cross-week-read",name:"get_summaries",arguments:{level:"week",range:{from:"2026-10-26",to:"2026-11-08"},includeOriginals:true,query:"纸样 归档"}}]};
      evidence=output.originalEvidence;
      if(!messages[0].content.includes(corrected))throw Error("Corrected availability missing from live context");
      return{content:evidence.notes.map(note=>note.date+" · "+note.path+"\n"+note.text).join("\n\n")+"\n下一步：按当前记忆周三19:30连续25分钟。仅两次样本，未创建任务；未命中不代表没有日记。",toolCalls:[]};
    };
    p.ai.agentTurnStream=mock;Object.getPrototypeOf(p.ai).agentTurnStream=mock;
    await p.activateView(true);const view=app.workspace.getLeavesOfType("lifeops-assistant-view")[0].view;await view.navigateSteward("chat");
    view.setAgentInput("回顾10月26日到11月8日的虚构纸样归档，请给两日期来源及按新时段的建议，不创建任务。");await view.sendAgentMessage();
    return{reply:view.agentReply,evidence,calls,before,after:await p.store.readPath(p.store.taskDbPath()),receipts:view.agentMessages.at(-1).receipts??[]};
  });
  assert.equal(observed.calls,2);assert.equal(observed.before,observed.after);assert.deepEqual(observed.receipts,[]);
  assert.deepEqual(observed.evidence.notes.map(note=>note.date),["2026-10-28","2026-11-04"]);
  assert(observed.evidence.unmatchedDates.includes("2026-11-05"));assert(!observed.evidence.missingDates.includes("2026-11-05"));
  for(const expected of ["2026-10-28","2026-11-04","19:30"])assert(observed.reply.includes(expected));
  assert(!observed.reply.includes("09:30"));assert(!observed.reply.includes("confidence:"));
  await page.screenshot({path:join(root,"cross-week-evidence.png")});result.checks.crossWeekUiUsesDatedOriginalsAndCorrectedMemory=true;
}
