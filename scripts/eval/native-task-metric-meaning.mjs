import assert from "node:assert/strict";

export async function nativeTaskMetricMeaning(page,result) {
  const observed=await page.evaluate(async()=>{
    const p=app.plugins.getPlugin("lifeops-assistant"),view=app.workspace.getLeavesOfType("lifeops-assistant-view")[0].view;
    const prototype=Object.getPrototypeOf(p.ai),saved={ai:p.settings.ai,privacy:p.settings.privacy,
      instance:p.ai.agentTurnStream,prototype:prototype.agentTurnStream,fetch:globalThis.fetch};
    let fixtureTaskId,calls=0,selections=0,completionChecks=0,fetchCalls=0;
    try{
      const task=await p.store.createTask({title:"虚构指标跨日样本",date:"2021-01-03",estimateMin:30,startTime:"09:00",endTime:"09:30"});
      fixtureTaskId=task.id;
      await p.store.updateTask(task.id,row=>({...row,status:"completed",createdAt:"2021-01-03T08:00:00+08:00",completedAt:"2021-01-04T17:00:00+08:00"}));
      const facts=JSON.stringify((await p.store.readTaskDb()).tasks);
      const deadline=Date.now()+15000;
      while(p.sourceChangeTimers?.size||p.dataFoundationBootstrap){
        if(Date.now()>=deadline)throw Error("Native metric fixture did not settle");
        await new Promise(resolve=>setTimeout(resolve,50));
      }
      p.settings.ai={...p.settings.ai,provider:"custom",endpoint:"https://fictional.invalid",apiKey:"fictional-native-key",model:"synthetic-metric",fallbackProvider:"off",dataDisclosureAccepted:true};
      p.settings.privacy={...p.settings.privacy,plaintextCredentialStorageAccepted:true};
      globalThis.fetch=async()=>{fetchCalls++;throw Error("Native metric fixture forbids transport");};
      const mock=async(_messages,_onText,options)=>{
        calls++;
        if(options?.tools?.length===1&&options.tools[0].name==='verify_read_completion'){
          if(++completionChecks!==1)throw Error('Metric meaning allows only one completion check');
          if(JSON.stringify((await p.store.readTaskDb({readOnly:true})).tasks)!==facts)throw Error('Metric completion check changed tasks');
          return{content:'',toolCalls:[{id:'native-metric-completion',name:'verify_read_completion',arguments:{disposition:'complete'}}]};
        }
        if(++selections!==1)throw Error("Metric meaning must not request a generated explanation after local statistics");
        return{content:"",toolCalls:[{id:"native-metric-meaning",name:"get_stats",arguments:{domain:"tasks",range:{from:"2021-01-01",to:"2021-01-07"},directReply:"task_meaning"}},
          {id:"native-metric-day",name:"get_stats",arguments:{domain:"tasks",range:{from:"2021-01-01",to:"2021-01-07"},groupBy:"day"}}]};
      };
      p.ai.agentTurnStream=mock;prototype.agentTurnStream=mock;
      view.agentMessages=[];view.pendingAgentActions=[];view.agentMode="text";await view.navigateSteward("chat");
      view.setAgentInput("解释2021年1月1日至1月7日的任务计划完成率和平均完成间隔，只查记录。");await view.sendAgentMessage();
      return{reply:view.agentReply,calls,selections,completionChecks,fetchCalls,unchanged:JSON.stringify((await p.store.readTaskDb()).tasks)===facts,
        actions:view.pendingAgentActions.length,receipts:view.agentMessages.at(-1)?.receipts??[]};
    }finally{
      p.settings.ai=saved.ai;p.settings.privacy=saved.privacy;p.ai.agentTurnStream=saved.instance;prototype.agentTurnStream=saved.prototype;globalThis.fetch=saved.fetch;
      if(fixtureTaskId)await p.store.deleteTask(fixtureTaskId);view.agentMessages=[];view.pendingAgentActions=[];
    }
  });
  assert.equal(observed.calls,2);assert.equal(observed.selections,1);assert.equal(observed.completionChecks,1);
  assert.equal(observed.fetchCalls,0);assert(observed.unchanged);
  assert.equal(observed.actions,0);assert.deepEqual(observed.receipts,[]);
  for(const text of["1980 分钟","计划完成率 100%","不是实测工作工时","不能据此断言拖延或临时需求挤占","隔天完成不等于周或月计划外"])assert(observed.reply.includes(text),text);
  result.checks.nativeTaskMetricMeaningIsLocalAndKeepsTaskFacts=true;
  await page.waitForFunction(()=>{const p=app.plugins.getPlugin("lifeops-assistant"),s=globalThis[Symbol.for("lifeops.fact-operation-state.v1")];return!p.sourceChangeTimers?.size&&!p.dataFoundationBootstrap&&!s?.locks?.has(app.vault)&&!s?.activeWrites?.has(app.vault);});
}
