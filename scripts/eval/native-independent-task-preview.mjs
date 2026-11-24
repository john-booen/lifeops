import assert from'node:assert/strict';import{join}from'node:path';
export async function nativeIndependentTaskPreview(page,root,result){
 const first=await page.evaluate(async()=>{
  const p=app.plugins.getPlugin('lifeops-assistant'),view=app.workspace.getLeavesOfType('lifeops-assistant-view')[0].view;
  const held=globalThis.__nativeIndependentTaskPreview={before:(await p.store.readTaskDb()).tasks,calls:0,receipts:[],factory:p.createAgentRuntime,instance:p.ai.agentTurnStream,prototype:Object.getPrototypeOf(p.ai).agentTurnStream};
  held.task=await p.store.createTask({title:'虚构指代确认原任务',date:'2026-11-25',startTime:'09:00',endTime:'10:00',note:'虚构原备注保留'});
  const mock=async()=>{if(++held.calls!==1)throw Error('Independent preview called model again');return{content:'',toolCalls:[{id:'fictional-independent-task-preview',name:'update_tasks',arguments:{updates:[{taskIdOrTitle:held.task.id,title:'虚构指代确认新任务'}]}}]};};
  p.ai.agentTurnStream=mock;Object.getPrototypeOf(p.ai).agentTurnStream=mock;p.createAgentRuntime=function(...args){const runtime=held.factory.apply(this,args),execute=runtime.executeToolCall.bind(runtime);runtime.executeToolCall=async(...values)=>{const output=await execute(...values);if(output.receipt)held.receipts.push(output.receipt);return output;};return runtime;};
  view.agentMode='text';view.agentMessages=[];view.pendingAgentActions=[];await view.navigateSteward('chat');const raw=await p.store.readPath(p.store.taskDbPath());
  view.setAgentInput('刚才那条，标题改成「虚构指代确认新任务」，先给确认卡。');await view.sendAgentMessage();
  return{noWrite:raw===await p.store.readPath(p.store.taskDbPath()),pending:view.pendingAgentActions.length,card:view.pendingAgentActions[0],receipts:held.receipts,calls:held.calls};
 });
 try{
  assert(first.noWrite);assert.equal(first.pending,1);assert.deepEqual(first.receipts,[]);assert.equal(first.calls,1);assert.equal(first.card.type,'tool_batch');
  const updates=first.card.toolBatch.flatMap(call=>call.arguments.updates??[]);assert.equal(updates.length,1);assert.equal(typeof updates[0].expectedRevision,'string');
  const toggle=page.getByRole('button',{name:'查看待确认动作',exact:true});if(await toggle.getAttribute('aria-expanded')!=='true')await toggle.click();const preview=page.getByRole('textbox',{name:'确认后执行的修改',exact:true});await preview.waitFor();const text=await preview.inputValue();assert(text.includes('虚构指代确认原任务')&&text.includes('虚构指代确认新任务'));await preview.scrollIntoViewIfNeeded();await page.screenshot({path:join(root,'independent-task-preview.png')});
  const saved=await page.evaluate(async()=>{const p=app.plugins.getPlugin('lifeops-assistant'),view=app.workspace.getLeavesOfType('lifeops-assistant-view')[0].view,held=globalThis.__nativeIndependentTaskPreview;view.setAgentInput('确定');await view.sendAgentMessage();const row=await p.store.getTask(held.task.id),answer={before:held.task,row,calls:held.calls,pending:view.pendingAgentActions.length,receipts:held.receipts};p.createAgentRuntime=held.factory;for(const receipt of [...held.receipts].reverse())await p.createAgentRuntime().undoOperation(receipt.operationId);held.undone=true;return answer;});
  assert.equal(saved.calls,1);assert.equal(saved.pending,0);assert.equal(saved.receipts.flatMap(row=>row.taskEdits??[]).length,1);const{title,updatedAt,...rest}=saved.row,{title:oldTitle,updatedAt:oldUpdated,...before}=saved.before;assert.equal(title,'虚构指代确认新任务');assert.deepEqual(rest,before);
  result.checks.explicitPreviewWithoutTitlePairDefersSave=true;result.checks.singleTaskPreviewBareConfirmationPreservesOriginalFields=true;result.checks.independentTaskPreviewNeedsNoSecondModelTurn=true;result.independentTaskPreview={modelCalls:1,originalTaskPreservedBeforeApproval:true,actualEdits:1,approvalAdditionalModelCalls:0};
 }finally{
  const clean=await page.evaluate(async()=>{const held=globalThis.__nativeIndependentTaskPreview,p=app.plugins.getPlugin('lifeops-assistant');p.createAgentRuntime=held.factory;p.ai.agentTurnStream=held.instance;Object.getPrototypeOf(p.ai).agentTurnStream=held.prototype;if(!held.undone)for(const receipt of [...held.receipts].reverse())await p.createAgentRuntime().undoOperation(receipt.operationId);await p.store.deleteTask(held.task.id);delete globalThis.__nativeIndependentTaskPreview;return{before:held.before,after:(await p.store.readTaskDb()).tasks};});assert.deepEqual(clean.after,clean.before);
 }
}
