import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { App } from 'obsidian';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/defaults';
import type { StoreHost } from '../src/store/settingsSlice';
vi.mock('obsidian',()=>({App:class{},Plugin:class{},TFile:class{},TFolder:class{},Modal:class{open(){}},Notice:class{},ItemView:class{},PluginSettingTab:class{},Setting:class{},Platform:{isDesktopApp:true},setIcon:vi.fn(),normalizePath:(p:string)=>p.replace(/\\/g,'/').replace(/\/{2,}/g,'/'),requestUrl:()=>{throw Error('Network forbidden');}}));
const { LifeOpsStore } = await import('../src/store');
const { DiskVault } = await import('./helpers/diskVault');
const { AgentRuntime } = await import('../src/agentRuntime');
const { ProjectJobRunner } = await import('../src/projectJobRunner');
const { ProjectJobRepository, validateProjectJobDocument } = await import('../src/projectJobRepository');
const { runConfirmedToolAction } = await import('../src/toolRegistry');
const { OperationLedger } = await import('../src/dataFoundation/operationLedger');
const { projectDocumentPath } = await import('../src/dataFoundation/projectPersistence');
const { TaskPlanReviewRegistry } = await import('../src/taskPlanReviewRegistry');
const { getLifeOpsTool, agentToolsForChat, agentToolsForRealtime } = await import('../src/toolRegistry');
const { default:LifeOpsPlugin } = await import('../src/main');
const { verifyProjectNextStepFiles } = await import('../src/projectToolContinuity');
const { PROJECT_SNAPSHOT_FIELDS, continuityHash } = await import('../src/projectContinuity');
const { fileRevision } = await import('../src/dataFoundation/factOperation');
let root:string,vault:InstanceType<typeof DiskVault>,store:StoreHost,runtime:InstanceType<typeof AgentRuntime>,runner:InstanceType<typeof ProjectJobRunner>,projectId:string,oldPath:string,newPath:string;
const tasks = () => [{title:'纯虚构混合任务甲',date:'明天',time:'09:30',category:'虚构学习'},{title:'纯虚构混合任务乙',date:'明天',time:'10:00',category:'虚构学习'}];
const next = () => ({text:'核对纯虚构银杏原文，不代表已经完成',sourcePath:newPath});
const clock=()=>new Date('2026-10-05T03:00:00.000Z');
function reopen(){store=new LifeOpsStore({vault}as unknown as App,structuredClone(DEFAULT_SETTINGS))as unknown as StoreHost;runtime=new AgentRuntime({store,refreshViews:async()=>{}});runner=new ProjectJobRunner(store,runtime,clock);}
let serial=0;
async function seed(command:any){const r=await runtime.executeAiToolCall({id:'work-plan-fixture-'+(++serial),name:'propose_project_change',arguments:{command}},'kimi','全虚构夹具');expect(r.success,r.output).toBe(true);await runConfirmedToolAction(r.actions[0],{store,refreshViews:async()=>{}});}
async function prepare(){return (runner as any).prepareWorkPlan(tasks(),'先保存两项虚构关联任务，再将项目下一步改为核对原文，先给我完整卡',[store.taskMirrorPath()],projectId,next());}
beforeEach(async()=>{root=await mkdtemp(join(tmpdir(),'lifeops-work-plan-'));vault=new DiskVault(root);reopen();await store.initializeVault();oldPath=store.path(store.settings.folders.ideas,'纯虚构旧下一步来源.md');newPath=store.path(store.settings.folders.ideas,'纯虚构新下一步来源.md');await vault.seed(oldPath,'纯虚构旧来源，必须持续保护');await vault.seed(newPath,'纯虚构新来源');await seed({kind:'save_goal',input:{title:'纯虚构混合目标'}});await seed({kind:'save_project',input:{title:'纯虚构混合项目',goalId:(await store.getProjectSnapshot()).document.goals[0].id,state:'started',nextStep:'纯虚构原下一步',nextStepSourcePath:oldPath,commitments:'纯虚构原承诺'}});projectId=(await store.getProjectSnapshot()).document.projects[0].id;});
afterEach(async()=>{vi.restoreAllMocks();await rm(root,{recursive:true,force:true});});
it('previews a separate versioned mixed authorization, then saves tasks and next step with accurate distinct evidence',async()=>{
 const initial=await store.getProjectSnapshot(),writes=vault.writes.length,review=await prepare();expect(vault.writes.length).toBe(writes);expect(review.version).toBe(2);expect(review.job.steps.map((s:any)=>s.toolName)).toEqual(['create_task','create_task','set_project_next_step']);expect(validateProjectJobDocument({version:2,job:review.job})).toBe(true);expect(validateProjectJobDocument({version:1,job:review.job})).toBe(false);
 const result=await runner.startConfirmed(review),job=result.snapshot.document.job!;expect(result.snapshot.document.version).toBe(2);expect(job.status).toBe('completed');expect(job.nextStep).toBe(3);const current=await store.getProjectSnapshot(),p=current.document.projects[0];expect(current.tasks.map(t=>t.title)).toEqual(tasks().map(t=>t.title));expect(p.taskIds).toEqual(current.tasks.map(t=>t.id));expect(p).toMatchObject({state:'started',commitments:'纯虚构原承诺',nextStep:next().text,nextStepSourcePath:newPath,nextStepEntryId:''});expect(current.document.goals).toEqual(initial.document.goals);
 const last=job.effects[2];expect(Object.hasOwn(last,'taskId')).toBe(false);expect(last.beforeTaskJsonHash).toBe(last.afterTaskJsonHash);expect(last.beforeTaskMirrorHash).toBe(last.afterTaskMirrorHash);const audit=await store.readJson<any>(new OperationLedger(store).filePath,{records:[]}),record=audit.records.find((r:any)=>r.operationId===job.steps[2].operationId);expect(record.toolName).toBe('set_project_next_step');expect(record.result.undo.files.map((f:any)=>f.path)).toEqual([projectDocumentPath(store)]);expect(result.message).toContain('下一步');expect(result.message).toContain('任务本身仍未完成');
 const raw=result.snapshot.raw;reopen();const inspection=await runner.inspect();expect(inspection.snapshot.raw).toBe(raw);expect(inspection.message).toContain('下一步');const nw=vault.writes.length;await runner.resume(await new ProjectJobRepository(store).load());expect(vault.writes.length).toBe(nw);
});
it('protects both old and new next-step sources after the source graph switches, including historical task receipts',async()=>{
 const result=await runner.startConfirmed(await prepare());expect(result.snapshot.document.job?.baseline.sourcePaths).toEqual(expect.arrayContaining([oldPath,newPath,store.taskMirrorPath()]));expect((await runner.inspect()).message).toContain('全部保存');const raw=await vault.bytes(projectDocumentPath(store));await vault.seed(oldPath,'纯虚构后来改动旧来源');expect((await runner.inspect()).canResume).toBe(false);expect(await vault.bytes(projectDocumentPath(store))).toBe(raw);
});
it('never promotes a version-one extension or silently converts a current version-one plan to new authority',async()=>{
 const legacy=await runner.prepare(tasks(),'纯虚构旧任务授权',[],undefined,projectId);const repo=new ProjectJobRepository(store);const queued=await repo.updateMetadata(await repo.load(),structuredClone(legacy.job));const doc=JSON.parse(queued.raw!);doc.job.steps[0].nextStep=next();expect(validateProjectJobDocument(doc)).toBe(true);doc.version=2;expect(validateProjectJobDocument(doc)).toBe(false);const old=await vault.bytes(queued.path);await expect((repo as any).updateMetadata(queued,structuredClone(legacy.job),undefined,2)).rejects.toThrow();expect(await vault.bytes(queued.path)).toBe(old);
});
it('stops after a committed task without changing the original next step or dispatching later actions',async()=>{
 const signal=new AbortController();runtime=new AgentRuntime({store,refreshViews:async()=>signal.abort()});runner=new ProjectJobRunner(store,runtime,clock);
 const result=await runner.startConfirmed(await prepare(),signal.signal);expect(result.snapshot.document.job?.status).toBe('cancelled');expect(result.snapshot.document.job?.nextStep).toBe(1);
 const current=await store.getProjectSnapshot();expect(current.tasks).toHaveLength(1);expect(current.document.projects[0]).toMatchObject({nextStep:'纯虚构原下一步',nextStepSourcePath:oldPath});
 const audit=await store.readJson<any>(new OperationLedger(store).filePath,{records:[]});expect(audit.records.some((r:any)=>r.toolName==='set_project_next_step')).toBe(false);
});
it('reopens a failed last action and updates only the next step without duplicating the committed tasks',async()=>{
 const original=runtime.executeLocalOperation.bind(runtime),spy=vi.spyOn(runtime,'executeLocalOperation').mockImplementation(async(name,...rest)=>{
   if(name==='set_project_next_step')throw Error('纯虚构最后动作暂不可保存');return original(name,...rest);
 });
 await expect(runner.startConfirmed(await prepare())).rejects.toThrow();expect((await store.getProjectSnapshot()).tasks).toHaveLength(2);
 expect((await new ProjectJobRepository(store).load()).document.job?.nextStep).toBe(2);spy.mockRestore();reopen();
 const result=await runner.resume(await new ProjectJobRepository(store).load());expect(result.snapshot.document.job?.status).toBe('completed');expect((await store.getProjectSnapshot()).tasks).toHaveLength(2);
 expect((await store.getProjectSnapshot()).document.projects[0].nextStep).toBe(next().text);
});
it('rolls back only the last Project update when Task facts change at its final commit guard and preserves the external Task edit',async()=>{
 const original=OperationLedger.prototype.verify;let external='',beforeProject='';
 vi.spyOn(OperationLedger.prototype,'verify').mockImplementation(async function(this:InstanceType<typeof OperationLedger>,...args){
   const record=await original.apply(this,args);
   if(record.toolName==='set_project_next_step'){
     beforeProject=(record.result!.undo as any).files[0].before;
     external=(await vault.bytes(store.taskDbPath()))+'\n ';await vault.seed(store.taskDbPath(),external);
   }
   return record;
 });
 await expect(runner.startConfirmed(await prepare())).rejects.toThrow();expect(await vault.bytes(store.taskDbPath())).toBe(external);expect(await vault.bytes(projectDocumentPath(store))).toBe(beforeProject);
 expect((await store.readTaskDb({readOnly:true})).tasks).toHaveLength(2);expect((await new ProjectJobRepository(store).load()).document.job?.effects).toHaveLength(2);
});
it.each(['state','task_links','extension','other_goal'])('refuses an audited next-step delta that also changes %s, even with recomputed receipt hashes',async cause=>{
 const saved=await runner.startConfirmed(await prepare()),job=saved.snapshot.document.job!,step=job.steps.at(-1)!;if(step.toolName!=='set_project_next_step')throw Error('Expected last project action');
 const audit=await store.readJson<any>(new OperationLedger(store).filePath,{records:[]}),record=audit.records.find((r:any)=>r.operationId===step.operationId),files=structuredClone(record.result.undo.files),doc=JSON.parse(files[0].after),p=doc.projects[0];
 if(cause==='state')p.state='agreed';if(cause==='task_links')p.taskIds=p.taskIds.slice(1);if(cause==='extension')p.future='未授权新扩展';if(cause==='other_goal')doc.goals[0].future='未授权新目标字段';
 const change=p.changes.at(-1);change.fields=Object.fromEntries(PROJECT_SNAPSHOT_FIELDS.map(key=>[key,p[key]]));change.receipt.contentHash=continuityHash(change.fields);files[0].after=JSON.stringify(doc,null,2)+'\n';files[0].afterHash=fileRevision(files[0].after);
 await expect(verifyProjectNextStepFiles(store,files,step.operationId,step.arguments,job.projectBinding!)).rejects.toThrow();
});
it('uses a readonly production chat card, binds its old and new next-step meaning, and exposes Realtime proposal but no direct execution tool',async()=>{
 const registry=new TaskPlanReviewRegistry(store,()=>runner,()=>{},clock),plugin:any=Object.assign(Object.create(LifeOpsPlugin.prototype),{app:store.app,store,settings:store.settings,refreshViews:vi.fn(async()=>{}),projectJobRunner:runner,taskPlanReviews:registry,unloaded:false,lifecycleGeneration:0}),writes=vault.writes.length;
 const result=await plugin.executeToolCalls([{id:'fictional-work-plan-model',name:'propose_project_work_plan',arguments:{projectId,tasks:tasks(),nextStep:next()}}],'先给我完整卡核对纯虚构关联任务与下一步',undefined,undefined,undefined,[store.taskMirrorPath()]);
 expect(result.results[0].success,result.results[0].output).toBe(true);expect(vault.writes.length).toBe(writes);expect(result.actions[0].content).toContain('原下一步：纯虚构原下一步');expect(result.actions[0].content).toContain(next().text);expect(result.actions[0].content).not.toContain(projectId);
 expect(()=>registry.start({...result.actions[0],content:result.actions[0].content+'伪造下一步'})).toThrow();expect(vault.writes.length).toBe(writes);
 expect(getLifeOpsTool('set_project_next_step')).toBeUndefined();expect(agentToolsForChat().some(t=>t.name==='propose_project_work_plan')).toBe(true);expect(agentToolsForRealtime().some(t=>t.name==='propose_project_work_plan')).toBe(true);
 await plugin.executeAgentAction(result.actions[0]);expect((await store.getProjectSnapshot()).document.projects[0].nextStep).toBe(next().text);
});
it('keeps historical Task artifacts accurate when the final next-step source becomes the Task mirror',async()=>{
 await seed({kind:'create_task',projectId,input:{title:'纯虚构既有原任务'}});await seed({kind:'add_entry',projectId,entryKind:'output',text:'纯虚构原看板产物',path:store.taskMirrorPath()});
 const initial=await store.getProjectSnapshot(),entry=initial.document.projects[0].entries[0];expect(initial.artifacts[entry.id]).toBe('unchanged');
 await runner.startConfirmed(await runner.prepareWorkPlan(tasks(),'纯虚构改下一步来源为看板',[],projectId,{text:next().text,sourcePath:store.taskMirrorPath()}));
 reopen();expect((await runner.inspect()).message).toContain('全部保存');const current=await store.getProjectSnapshot();expect(current.artifacts[entry.id]).toBe('changed');expect(current.document.projects[0].entries[0]).toEqual(entry);
});
it('archives version-two bytes after completion and starts a fresh legacy task plan without reinterpreting its archive',async()=>{
 const saved=await runner.startConfirmed(await prepare()),raw=saved.snapshot.raw;await runner.archive(saved.snapshot);const empty=await new ProjectJobRepository(store).load();expect(empty.document).toMatchObject({version:2,job:null});
 const nextReview=await runner.prepare([{title:'纯虚构下一份普通任务'}],'请保存下一份普通任务');await runner.startConfirmed(nextReview);expect((await new ProjectJobRepository(store).load()).document.version).toBe(1);
 const archive=store.path(store.settings.folders.aiReports,'Jobs','Archive',saved.snapshot.document.job!.id+'.json');expect(await vault.bytes(archive)).toBe(raw);
});
