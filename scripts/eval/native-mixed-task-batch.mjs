import assert from "node:assert/strict";
import { join } from "node:path";

export async function nativeMixedTaskBatch(page, root, result) {
  await mixedTaskBatchScenario(page,root,result,false);
  await mixedTaskBatchScenario(page,root,result,true);
}

async function mixedTaskBatchScenario(page,root,result,readPlan) {
  const baseline = await page.evaluate(async readPlan => {
    const p = app.plugins.getPlugin("lifeops-assistant"), tasks = (await p.store.readTaskDb()).tasks;
    const date = new Date(Date.now() + 86400000).toLocaleDateString("sv-SE");
    const rows = [];
    for (let i = 0; i < 2; i++) rows.push(await p.store.createTask({ title: "虚构混批旧纸样" + i, date, startTime: "09:00", endTime: "09:30" }));
    globalThis.__mixedBatchNative = { tasks, rows, ai: p.settings.ai, privacy: p.settings.privacy,
      instance: p.ai.agentTurnStream, prototype: Object.getPrototypeOf(p.ai).agentTurnStream, calls: 0 };
    p.settings.ai = { ...p.settings.ai, provider: "custom", endpoint: "https://fiction.invalid/chat", apiKey: "fictional-mixed-batch-key",
      model: "synthetic", fallbackProvider: "off", dataDisclosureAccepted: true };
    p.settings.privacy = { ...p.settings.privacy, plaintextCredentialStorageAccepted: true };
    const mock = async () => {
      const turn=++globalThis.__mixedBatchNative.calls;
      if(readPlan&&turn===1)return{content:'',toolCalls:[{id:'fictional-mixed-read',name:'list_tasks',arguments:{query:'虚构混批旧纸样',answerMode:'continue'}},
        {id:'fictional-mixed-capacity',name:'plan_today',arguments:{draftTomorrow:true}}]};
      if(turn===(readPlan?2:1))return{content:'',toolCalls:[{id:'fictional-mixed-batch-new',name:readPlan?'propose_task_plan':'schedule_task_batch',arguments:readPlan
        ?{tasks:Array.from({length:5},(_,i)=>({title:'虚构混批新增纸袋'+i,date,startTime:'10:00',endTime:'10:20',dueDate:date,dueTime:'18:00'}))}
        :{date,tasks:Array.from({length:5},(_,i)=>({title:'虚构混批新增纸袋'+i,estimateMin:20}))}}]};
      return{content:'确认卡已准备，尚未保存。',toolCalls:[]};
    };
    p.ai.agentTurnStream = mock; Object.getPrototypeOf(p.ai).agentTurnStream = mock;
    const view = app.workspace.getLeavesOfType("lifeops-assistant-view")[0].view;
    view.agentMessages = []; view.pendingAgentActions = []; view.agentMode = "text"; await view.navigateSteward("chat");
    const ledgerPath=p.store.path(p.settings.folders.aiReports,'Operations','operation-ledger.json');
    globalThis.__mixedBatchNative.mutations=async()=>JSON.parse(await p.store.readPath(ledgerPath)||'{"records":[]}').records.filter(r=>['create_task','update_tasks','confirm_task_batch'].includes(r.toolName)).sort((a,b)=>a.operationId.localeCompare(b.operationId));
    return { tasks, rows,mutations:await globalThis.__mixedBatchNative.mutations() };
  },readPlan);
  const input = page.locator("textarea.lifeops-agent-input").last();
  await input.fill('把「虚构混批旧纸样0」改为「虚构混批新纸样甲」，把「虚构混批旧纸样1」改为「虚构混批新纸样乙」。保留原安排，再把五项新的纸袋任务排好明天并一起保存。');
  await input.press("Enter");
  await page.waitForFunction(() => { const v = app.workspace.getLeavesOfType("lifeops-assistant-view")[0].view; return !v.agentBusy && v.pendingAgentActions.length === 1; });
  const preview = await page.evaluate(async () => {
    const p = app.plugins.getPlugin("lifeops-assistant"), v = app.workspace.getLeavesOfType("lifeops-assistant-view")[0].view;
    globalThis.__mixedBatchNative.card=v.pendingAgentActions[0];
    return { tasks: (await p.store.readTaskDb()).tasks, batch: v.pendingAgentActions[0].toolBatch, calls: globalThis.__mixedBatchNative.calls,mutations:await globalThis.__mixedBatchNative.mutations() };
  });
  assert.deepEqual(preview.tasks, [...baseline.tasks, ...baseline.rows]);
  assert.equal(preview.batch.filter(call => call.name === "create_task").length, 5);
  assert(preview.batch.find(call => call.name === "update_tasks").arguments.updates.every(row => /^[a-f0-9]{64}$/.test(row.expectedRevision)));
  assert.deepEqual(preview.mutations,baseline.mutations);
  result.checks[readPlan?'mixedReadPlanKeepsAllSevenBeforeAnyWrite':'mixedBatchPreviewKeepsBothEditsAndFiveCreatesBeforeAnyWrite'] = true;
  await input.fill("确定"); await input.press("Enter");
  await page.waitForFunction(() => !app.workspace.getLeavesOfType("lifeops-assistant-view")[0].view.agentBusy);
  const saved = await page.evaluate(async () => ({ tasks: (await app.plugins.getPlugin("lifeops-assistant").store.readTaskDb()).tasks,
    pending: app.workspace.getLeavesOfType("lifeops-assistant-view")[0].view.pendingAgentActions.length, calls: globalThis.__mixedBatchNative.calls }));
  assert.equal(saved.pending, 0); assert.equal(saved.calls, preview.calls); assert.equal(saved.tasks.length, baseline.tasks.length + 7);
  for (const [i, row] of baseline.rows.entries()) assert.deepEqual({ ...saved.tasks.find(task => task.id === row.id), updatedAt: row.updatedAt },
    { ...row, title: i ? "虚构混批新纸样乙" : "虚构混批新纸样甲" });
  result.checks[readPlan?'mixedReadPlanBareConfirmationSavesAllSeven':'mixedBatchBareConfirmationSavesAllSevenWithoutAnotherModelRound'] = true;
  const replayed=await page.evaluate(async()=>{const p=app.plugins.getPlugin('lifeops-assistant');await p.executeAgentAction(globalThis.__mixedBatchNative.card);return(await p.store.readTaskDb()).tasks;});
  assert.deepEqual(replayed,saved.tasks);
  if(readPlan)result.checks.mixedReadPlanReplayDoesNotDuplicate = true;
  await page.screenshot({ path: join(root,readPlan?'mixed-read-plan-seven-saved.png':"mixed-batch-seven-saved.png") });
  const restored = await page.evaluate(async () => {
    const p = app.plugins.getPlugin("lifeops-assistant"), runtime = p.createAgentRuntime(), old = globalThis.__mixedBatchNative;
    await runtime.undoLatestOperation();
    const restored = (await p.store.readTaskDb()).tasks;
    for (const row of old.rows) await p.store.deleteTask(row.id);
    p.settings.ai = old.ai; p.settings.privacy = old.privacy; p.ai.agentTurnStream = old.instance; Object.getPrototypeOf(p.ai).agentTurnStream = old.prototype;
    const view = app.workspace.getLeavesOfType("lifeops-assistant-view")[0].view; view.agentMessages = []; view.pendingAgentActions = [];
    return { restored, final: (await p.store.readTaskDb()).tasks };
  });
  assert.deepEqual(restored.restored, [...baseline.tasks, ...baseline.rows]); assert.deepEqual(restored.final, baseline.tasks);
  result.checks[readPlan?'mixedReadPlanSingleUndoRestoresOriginalRecords':'mixedBatchUndoRestoresOriginalRecords'] = true;
}
