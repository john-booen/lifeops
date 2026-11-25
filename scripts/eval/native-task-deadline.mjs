import assert from 'node:assert/strict';
import {join} from 'node:path';
import {writeFile} from 'node:fs/promises';

/** Called only by the remote native harness, with fictional providers and files. */
export async function nativeTaskDeadline(page,root,result){
  const created=await page.evaluate(async()=>{
    const p=app.plugins.getPlugin('lifeops-assistant'),view=app.workspace.getLeavesOfType('lifeops-assistant-view')[0].view;
    const day=offset=>{const d=new Date();d.setDate(d.getDate()+offset);return d.toLocaleDateString('sv-SE');};
    const held=globalThis.__nativeTaskDeadline={before:(await p.store.readTaskDb()).tasks,receipts:[],factory:p.createAgentRuntime,instance:p.ai.agentTurnStream,prototype:Object.getPrototypeOf(p.ai).agentTurnStream,calls:0,phase:'create',phaseCalls:0,date:day(0),endDate:day(7),dueDate:day(8)};
    const mock=async()=>{
      held.calls++;held.phaseCalls++;
      if(held.phase==='create'){
        if(held.phaseCalls>2)throw Error('Unexpected extra native deadline creation model turn');
        return held.phaseCalls===1?{content:'',toolCalls:[{id:'fictional-native-deadline-create',name:'create_task',arguments:{title:'虚构原生期间与截止',date:held.date,endDate:held.endDate,scheduleMode:'window',dueDate:held.dueDate,dueTime:'17:30'}}]}:{content:'虚构：已保存期间与独立截止。',toolCalls:[]};
      }
      if(held.phaseCalls!==1)throw Error('Native deadline preview called the model again');
      return{content:'',toolCalls:[{id:'fictional-native-deadline-update',name:'update_tasks',arguments:{updates:[{taskIdOrTitle:held.task.id,dueTime:'18:00'}]}}]};
    };
    p.ai.agentTurnStream=mock;Object.getPrototypeOf(p.ai).agentTurnStream=mock;
    p.createAgentRuntime=function(...args){const runtime=held.factory.apply(this,args),execute=runtime.executeToolCall.bind(runtime);runtime.executeToolCall=async(...values)=>{const output=await execute(...values);if(output.receipt)held.receipts.push(output.receipt);return output;};return runtime;};
    view.agentMode='text';view.agentMessages=[];view.pendingAgentActions=[];await view.navigateSteward('chat');
    view.setAgentInput(`直接创建虚构原生期间与截止，${held.date}至${held.endDate}分次完成；另有必须截止${held.dueDate}17:30，不安排每天固定时段。`);await view.sendAgentMessage();
    held.task=(await p.store.readTaskDb()).tasks.find(row=>row.title==='虚构原生期间与截止');
    return{task:held.task,date:held.date,endDate:held.endDate,dueDate:held.dueDate,reply:view.agentReply};
  });
  try{
    assert(created.task);assert.equal(created.task.scheduleMode,'window');assert.equal(created.task.date,created.date);assert.equal(created.task.endDate,created.endDate);assert.equal(created.task.dueDate,created.dueDate);assert.equal(created.task.dueTime,'17:30');assert(!created.task.startTime&&!created.task.endTime&&!created.task.time);
    const preview=await page.evaluate(async()=>{
      const p=app.plugins.getPlugin('lifeops-assistant'),view=app.workspace.getLeavesOfType('lifeops-assistant-view')[0].view,held=globalThis.__nativeTaskDeadline;
      held.phase='preview';held.phaseCalls=0;const before=await p.store.readPath(p.store.taskDbPath());
      view.setAgentInput('刚才那条的必须截止时刻改为18:00，日期和期间不变，先给确认卡。');await view.sendAgentMessage();
      return{unchanged:before===await p.store.readPath(p.store.taskDbPath()),pending:view.pendingAgentActions.length,calls:held.calls};
    });
    assert(preview.unchanged);assert.equal(preview.pending,1);
    const toggle=page.getByRole('button',{name:'查看待确认动作',exact:true});if(await toggle.getAttribute('aria-expanded')!=='true')await toggle.click();
    const card=page.getByRole('textbox',{name:'确认后执行的修改',exact:true});await card.waitFor();const text=await card.inputValue();assert(text.includes('17:30')&&text.includes('18:00')&&text.includes(created.dueDate));await card.scrollIntoViewIfNeeded();await page.screenshot({path:join(root,'task-independent-deadline-card.png')});
    const confirmed=await page.evaluate(async()=>{
      const p=app.plugins.getPlugin('lifeops-assistant'),view=app.workspace.getLeavesOfType('lifeops-assistant-view')[0].view,held=globalThis.__nativeTaskDeadline;
      view.setAgentInput('确定');await view.sendAgentMessage();return{task:await p.store.getTask(held.task.id),calls:held.calls,pending:view.pendingAgentActions.length};
    });
    assert.equal(confirmed.calls,preview.calls);assert.equal(confirmed.pending,0);assert.equal(confirmed.task.dueTime,'18:00');
    const {dueTime,updatedAt,...rest}=confirmed.task,{dueTime:oldTime,updatedAt:oldUpdated,...before}=created.task;assert.deepEqual(rest,before);
    await writeFile(join(root,'task-independent-deadline.json'),JSON.stringify({created,preview,card:text,confirmed},null,2));
    result.checks.nativeChatSavesIndependentDeadlineWithPeriod=true;result.checks.nativeDeadlinePreviewAndBareConfirmation=true;
  }finally{
    const cleanup=await page.evaluate(async()=>{const p=app.plugins.getPlugin('lifeops-assistant'),held=globalThis.__nativeTaskDeadline;p.createAgentRuntime=held.factory;p.ai.agentTurnStream=held.instance;Object.getPrototypeOf(p.ai).agentTurnStream=held.prototype;for(const receipt of [...held.receipts].reverse())await p.createAgentRuntime().undoOperation(receipt.operationId);delete globalThis.__nativeTaskDeadline;return{before:held.before,after:(await p.store.readTaskDb()).tasks};});
    assert.deepEqual(cleanup.after,cleanup.before);result.checks.nativeDeadlineUndoRestoresOriginalTasks=true;
  }
}
