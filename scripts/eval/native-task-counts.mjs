import assert from "node:assert/strict";
import { join } from "node:path";

/** Native UI and original query executors; only model selection is synthetic. */
export async function nativeTaskCounts(page, root, result) {
  const fixture = await page.evaluate(async () => {
    const p = app.plugins.getPlugin("lifeops-assistant"), day = offset => new Date(Date.now() + offset * 86400000).toLocaleDateString("sv-SE");
    const rows = [];
    for (const data of [
      { title: "虚构原生数量过期纸袋", date: day(-2) },
      { title: "虚构原生数量今日纸袋", date: day(0), dueDate: day(0) },
      { title: "虚构原生数量期间纸袋", date: day(-1), endDate: day(2) }
    ]) rows.push(await p.store.createTask(data));
    return { ids: rows.map(row => row.id) };
  });
  await page.waitForFunction(() => {
    const p = app.plugins.getPlugin("lifeops-assistant"), s = globalThis[Symbol.for("lifeops.fact-operation-state.v1")];
    return !p.sourceChangeTimers?.size && !p.dataFoundationBootstrap && !s?.locks?.has(app.vault) && !s?.activeWrites?.has(app.vault);
  });
  try {
    const observed = await page.evaluate(async () => {
      const p = app.plugins.getPlugin("lifeops-assistant"), prototype = Object.getPrototypeOf(p.ai);
      const saved = { instance: p.ai.agentTurnStream, prototype: prototype.agentTurnStream, fetch: globalThis.fetch };
      const view = app.workspace.getLeavesOfType("lifeops-assistant-view")[0].view;
      const before = await p.store.readPath(p.store.taskDbPath()); let calls = 0, selections = 0, checks = 0, fetches = 0;
      try {
        globalThis.fetch = async () => { fetches++; throw Error("Fictional native count forbids transport"); };
        const mock = async (_messages, _onText, options) => {
          calls++;
          if(options?.tools?.length===1&&options.tools[0].name==='verify_read_completion'){
            if(++checks>2)throw Error('Pure native reads may have only one completion verification each');
            if(await p.store.readPath(p.store.taskDbPath())!==before)throw Error('Read completion verification changed tasks');
            return{content:'',toolCalls:[{id:'fictional-count-completion-'+checks,name:'verify_read_completion',arguments:{disposition:'complete'}}]};
          }
          if (++selections > 2) throw Error("Factual numbers must not require another interpretation");
          return { content: "", toolCalls: [
            ...(selections === 2 ? [{ id: "fictional-overview", name: "get_stats", arguments: { domain: "tasks", range: "last_week", directReply: "task_summary" } }] : []),
            { id: "fictional-overdue-count", name: "list_tasks", arguments: { answerMode: "counts", dueStatus: "overdue", query: "虚构原生数量" } }
          ] };
        };
        p.ai.agentTurnStream = mock; prototype.agentTurnStream = mock;
        view.agentMessages = []; view.pendingAgentActions = []; view.agentMode = "text"; await view.navigateSteward("chat");
        view.setAgentInput("数一下虚构原生数量相关目前有几项逾期，只报数量，不修改。");
        await view.sendAgentMessage();
        const first = view.agentReply, firstCalls = calls, firstChecks = checks;
        view.setAgentInput("再查上周任务完成概况和虚构原生数量的当前逾期数，只报登记数字，不修改。");
        await view.sendAgentMessage();
        return { first, second: view.agentReply, firstCalls, firstChecks, calls, selections, checks, fetches,
          unchanged: await p.store.readPath(p.store.taskDbPath()) === before,
          receipts: view.agentMessages.flatMap(message => message.receipts ?? []), pending: view.pendingAgentActions.length };
      } finally {
        p.ai.agentTurnStream = saved.instance; prototype.agentTurnStream = saved.prototype; globalThis.fetch = saved.fetch;
        view.agentMessages = []; view.pendingAgentActions = [];
      }
    });
    assert.equal(observed.firstCalls, 2); assert.equal(observed.calls, 4); assert.equal(observed.selections,2);
    assert.equal(observed.firstChecks,1);assert.equal(observed.checks,2);assert.equal(observed.fetches, 0);
    assert(observed.unchanged); assert.deepEqual(observed.receipts, []); assert.equal(observed.pending, 0);
    for (const reply of [observed.first, observed.second]) {
      assert(reply.includes("已逾期 1 项"), reply);
      for (const unwanted of ["虚构原生数量", "今天到期", "今天硬截止", "需要我"]) assert(!reply.includes(unwanted), reply);
    }
    assert(observed.second.includes("任务完成登记")); assert(observed.second.includes("不是该区间结束时"));
    result.checks.nativeOverdueCountOmitsUnrequestedTitles = true;
    result.checks.nativeWeekOverviewAndCurrentCountPreserveBothScopes = true;
    result.checks.nativeReadCompletionKeepsPureCountsReadOnly = true;
    await page.screenshot({ path: join(root, "task-counts.png") });
  } finally { await page.evaluate(async ids => { const p = app.plugins.getPlugin("lifeops-assistant"); for (const id of ids) await p.store.deleteTask(id); }, fixture.ids); }
  await nativeReadBeforeBatch(page,root,result);
}

async function nativeReadBeforeBatch(page,root,result){
  const titles=Array.from({length:5},(_,i)=>'虚构原生接续整批纸夹'+(i+1));
  await page.waitForFunction(()=>{const p=app.plugins.getPlugin('lifeops-assistant'),s=globalThis[Symbol.for('lifeops.fact-operation-state.v1')];return!p.sourceChangeTimers?.size&&!p.dataFoundationBootstrap&&!s?.locks?.has(app.vault)&&!s?.activeWrites?.has(app.vault);});
  try{
    const observed=await page.evaluate(async titles=>{
      const p=app.plugins.getPlugin('lifeops-assistant'),prototype=Object.getPrototypeOf(p.ai),view=app.workspace.getLeavesOfType('lifeops-assistant-view')[0].view;
      const saved={instance:p.ai.agentTurnStream,prototype:prototype.agentTurnStream,fetch:globalThis.fetch};
      const before=await p.store.readPath(p.store.taskDbPath()),original=JSON.parse(before).tasks;
      const date=new Date(Date.now()+86400000).toLocaleDateString('sv-SE');let calls=0,fetches=0,checkedBeforeWrite=false;
      try{
        globalThis.fetch=async()=>{fetches++;throw Error('Fictional native read-before-batch forbids transport');};
        const mock=async(_messages,_onText,options)=>{
          calls++;
          if(calls===1)return{content:'',toolCalls:[{id:'fictional-pre-batch-read',name:'list_tasks',arguments:{date,answerMode:'facts'}}]};
          if(calls===2){
            if(options?.tools?.length!==1||options.tools[0].name!=='verify_read_completion')throw Error('Missing native full-request completion check');
            checkedBeforeWrite=await p.store.readPath(p.store.taskDbPath())===before;if(!checkedBeforeWrite)throw Error('Read phase saved before completion check');
            return{content:'',toolCalls:[{id:'fictional-continue-batch',name:'verify_read_completion',arguments:{disposition:'continue'}}]};
          }
          if(calls===3){
            if(!options?.tools?.some(t=>t.name==='schedule_task_batch'))throw Error('Original batch tool unavailable after read');
            return{content:'',toolCalls:[{id:'fictional-whole-new-batch',name:'schedule_task_batch',arguments:{date,availableStart:'09:00',availableEnd:'16:00',tasks:titles.map(title=>({title,estimateMin:15}))}}]};
          }
          throw Error('Unexpected extra model request in native whole batch');
        };
        p.ai.agentTurnStream=mock;prototype.agentTurnStream=mock;
        view.agentMessages=[];view.pendingAgentActions=[];view.agentMode='text';await view.navigateSteward('chat');
        view.setAgentInput('先查明天原有安排，再把'+titles.join('、')+'这五项一次排好并创建，明天9点到16点有空，每项15分钟，不要逐项问。');
        await view.sendAgentMessage();
        const after=JSON.parse(await p.store.readPath(p.store.taskDbPath())).tasks;
        return{reply:view.agentReply,calls,fetches,checkedBeforeWrite,date,pending:view.pendingAgentActions.length,
          receipts:view.agentMessages.flatMap(m=>m.receipts??[]),created:after.filter(t=>titles.includes(t.title)),
          originalUnchanged:JSON.stringify(after.filter(t=>original.some(old=>old.id===t.id)))===JSON.stringify(original)};
      }finally{p.ai.agentTurnStream=saved.instance;prototype.agentTurnStream=saved.prototype;globalThis.fetch=saved.fetch;view.agentMessages=[];view.pendingAgentActions=[];}
    },titles);
    assert.equal(observed.calls,3);assert.equal(observed.fetches,0);assert(observed.checkedBeforeWrite);assert(observed.originalUnchanged);
    assert.equal(observed.pending,0);assert.equal(observed.receipts.length,5);assert.equal(observed.created.length,5);
    assert.deepEqual(observed.created.map(t=>t.title),titles);assert(observed.created.every(t=>t.date===observed.date&&t.startTime>='09:00'&&t.endTime<='16:00'));
    for(const title of titles)assert(observed.reply.includes(title),observed.reply);
    result.checks.nativeReadCannotFinishRequestedBatch=true;
    await page.screenshot({path:join(root,'task-read-before-batch.png')});
  }finally{await page.evaluate(async titles=>{const p=app.plugins.getPlugin('lifeops-assistant'),db=await p.store.readTaskDb({readOnly:true});for(const t of db.tasks.filter(t=>titles.includes(t.title)))await p.store.deleteTask(t.id);},titles);}
}
