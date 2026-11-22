/** Native UI uses a synthetic model; separate live evaluation checks model understanding. */
import assert from "node:assert/strict";
import {join} from "node:path";

export async function crossWeekUi(page,root,result) {
  assert.equal(process.env.GITHUB_ACTIONS,"true");assert.equal(process.env.RUNNER_OS,"macOS");
  const prepared=await page.evaluate(async()=>{
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
    return {before,corrected};
  });
  // The zero-latency synthetic model must not race the native app's pending
  // source-refresh work after creating/correcting these fictional records.
  await page.waitForFunction(()=>{
    const p=app.plugins.getPlugin("lifeops-assistant"),state=globalThis[Symbol.for("lifeops.fact-operation-state.v1")];
    return !p.sourceChangeTimers?.size&&!p.dataFoundationBootstrap&&!state?.locks?.has(app.vault)&&!state?.activeWrites?.has(app.vault);
  });
  const observed=await page.evaluate(async prepared=>{
    const p=app.plugins.getPlugin("lifeops-assistant"),{before,corrected}=prepared;
    p.settings.ai={...p.settings.ai,provider:"custom",endpoint:"https://fiction.invalid/chat",apiKey:"fictional-key",model:"synthetic",fallbackProvider:"off",dataDisclosureAccepted:true};
    p.settings.privacy={...p.settings.privacy,plaintextCredentialStorageAccepted:true};
    let evidence,calls=0,textOnly=false;const toolOutputs=[];
    const mock=async(messages,onText,options)=>{
      calls++;
      textOnly=options?.toolChoice==="none"&&!messages.some(message=>message.role==="tool"||message.tool_calls?.length);
      const tools=textOnly?messages.filter(message=>message.role==="user"&&message.content.startsWith("已核对的工具读回资料"))
        .map(message=>({content:JSON.parse(message.content.slice(message.content.indexOf("\n")+1)).result})):messages.filter(message=>message.role==="tool");
      toolOutputs.push(...tools.map(message=>message.content));
      const output=tools.map(message=>{try{return JSON.parse(message.content);}catch{return null;}}).find(item=>item?.originalEvidence);
      if(!output)return{content:"",toolCalls:[{id:"fictional-cross-week-read",name:"get_summaries",arguments:{level:"week",range:{from:"2026-10-26",to:"2026-11-08"},includeOriginals:true,query:"纸样 归档 虚纸 裁剪 纸样归档"}}]};
      evidence=output.originalEvidence;
      if(!messages[0].content.includes(corrected))throw Error("Corrected availability missing from live context");
      if(!textOnly){const content="虚构未核对草稿：没打卡意味着记录方式有问题。";onText?.(content);return{content,toolCalls:[]};}
      if(options?.tools?.length||options?.reasoningEffort!=="low"||messages.some(message=>message.content.includes("虚构未核对草稿")))throw Error("Unverified draft or unbounded reasoning entered final historical answer");
      return{content:evidence.notes.map(note=>note.date+" · "+note.path+"\n"+note.text).join("\n\n")+"\n"+evidence.coverageSummary+"\n下一步：按当前记忆周三19:30连续25分钟。仅两次样本，未创建任务；未命中不代表没有日记。",toolCalls:[]};
    };
    p.ai.agentTurnStream=mock;Object.getPrototypeOf(p.ai).agentTurnStream=mock;
    await p.activateView(true);const view=app.workspace.getLeavesOfType("lifeops-assistant-view")[0].view;await view.navigateSteward("chat");
    view.setAgentInput("回顾10月26日到11月8日的虚构纸样归档，请给两日期来源及按新时段的建议，不创建任务。");await view.sendAgentMessage();
    return{reply:view.agentReply,evidence,calls,textOnly,toolOutputs,before,after:await p.store.readPath(p.store.taskDbPath()),receipts:view.agentMessages.at(-1).receipts??[]};
  },prepared);
  assert(observed.evidence,"Native cross-week query lacked evidence: "+JSON.stringify(observed.toolOutputs).slice(0,2000));
  assert.equal(observed.calls,3);assert.equal(observed.before,observed.after);assert.deepEqual(observed.receipts,[]);
  assert(observed.textOnly);assert(!observed.reply.includes("虚构未核对草稿"));result.checks.crossWeekFinalAnalysisUsesEvidenceWithoutDraftOrTools=true;
  assert.deepEqual(observed.evidence.notes.map(note=>note.date),["2026-10-28","2026-11-04"]);
  assert.equal(observed.evidence.query,"纸样 归档 纸样归档");
  const counts=observed.evidence.counts;
  assert.equal(counts.requestedDays,14);assert.equal(counts.scopeDays,14);assert.equal(counts.matchedDays,2);assert.equal(counts.returnedNotes,2);
  assert(counts.unmatchedDays>=1);assert.equal(counts.withJournalDays+counts.missingDays,14);
  assert(observed.reply.includes("本次覆盖14天"));result.checks.crossWeekCoverageCountsDatesInsteadOfNotes=true;
  assert(observed.evidence.unmatchedDates.includes("2026-11-05"));assert(!observed.evidence.missingDates.includes("2026-11-05"));
  for(const expected of ["2026-10-28","2026-11-04","19:30"])assert(observed.reply.includes(expected));
  assert(!observed.reply.includes("09:30"));assert(!observed.reply.includes("confidence:"));
  await page.screenshot({path:join(root,"cross-week-evidence.png")});result.checks.crossWeekUiUsesDatedOriginalsAndCorrectedMemory=true;
}
