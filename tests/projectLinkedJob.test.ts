import { mkdtemp, rm } from 'node:fs/promises';import { tmpdir } from 'node:os';import { join } from 'node:path';import type { App } from 'obsidian';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';import { DEFAULT_SETTINGS } from '../src/defaults';import type { StoreHost } from '../src/store/settingsSlice';
vi.mock('obsidian',()=>({App:class{},Plugin:class{},TFile:class{},TFolder:class{},Modal:class{open(){}},Notice:class{},ItemView:class{},PluginSettingTab:class{},Setting:class{},Platform:{isDesktopApp:true},setIcon:vi.fn(),normalizePath:(p:string)=>p.replace(/\\/g,'/').replace(/\/{2,}/g,'/'),requestUrl:()=>{throw Error('Network forbidden');}}));
const {LifeOpsStore}=await import('../src/store'),{DiskVault}=await import('./helpers/diskVault'),{AgentRuntime}=await import('../src/agentRuntime');
const {ProjectJobRunner}=await import('../src/projectJobRunner'),{ProjectJobRepository,projectJobPath,projectJobPlanHash,validateProjectJobDocument}=await import('../src/projectJobRepository');
const {OperationLedger}=await import('../src/dataFoundation/operationLedger'),{projectDocumentPath}=await import('../src/dataFoundation/projectPersistence');
const {getLifeOpsTool,runConfirmedToolAction}=await import('../src/toolRegistry'),{TaskPlanReviewRegistry}=await import('../src/taskPlanReviewRegistry');
const {verifyProjectLinkedTaskFiles}=await import('../src/projectToolContinuity'),{fileRevision}=await import('../src/dataFoundation/factOperation');
const {continuityHash,PROJECT_SNAPSHOT_FIELDS}=await import('../src/projectContinuity');const {recordRevision}=await import('../src/operationIdentity');const {default:LifeOpsPlugin}=await import('../src/main');
let root:string,vault:InstanceType<typeof DiskVault>,store:StoreHost,runtime:InstanceType<typeof AgentRuntime>,runner:InstanceType<typeof ProjectJobRunner>,projectId:string,source:string;
let serial=0;const clock=()=>new Date('2026-10-05T03:00:00.000Z');const tasks=()=>[{title:'纯虚构关联安排甲',date:'明天'},{title:'纯虚构关联安排乙',time:'09:30'}];
const context=()=>({store,refreshViews:async()=>{}});function reopen(){store=new LifeOpsStore({vault}as unknown as App,structuredClone(DEFAULT_SETTINGS))as unknown as StoreHost;runtime=new AgentRuntime(context());runner=new ProjectJobRunner(store,runtime,clock);}
async function save(command:any){const proposal=await runtime.executeAiToolCall({id:'linked-fixture-'+(++serial),name:'propose_project_change',arguments:{command}},'kimi','纯虚构夹具');expect(proposal.success,proposal.output).toBe(true);await runConfirmedToolAction(proposal.actions[0],context());}
async function prepare(){return runner.prepare(tasks(),'请安排两项纯虚构任务',[source],undefined,projectId);}
const job=()=>new ProjectJobRepository(store).load();const project=async()=> (await store.getProjectSnapshot()).document.projects.find(p=>p.id===projectId)!;
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return{promise,resolve}};
beforeEach(async()=>{root=await mkdtemp(join(tmpdir(),'lifeops-linked-job-'));vault=new DiskVault(root);reopen();await store.initializeVault();source=store.path(store.settings.folders.ideas,'纯虚构关联来源.md');await vault.seed(source,'纯虚构来源一');await save({kind:'save_goal',input:{title:'纯虚构关联目标'}});const goalId=(await store.getProjectSnapshot()).document.goals[0].id;await save({kind:'save_project',input:{title:'纯虚构关联项目',goalId,state:'started',commitments:'保留原承诺',blockers:'仍缺对照',nextStep:'原下一步'}});projectId=(await store.getProjectSnapshot()).document.projects[0].id;await save({kind:'create_task',projectId,input:{title:'纯虚构原任务'}});const raw=JSON.parse(await vault.bytes(projectDocumentPath(store)));raw.future={preserve:true};raw.projects[0].future='保留项目扩展';await vault.seed(projectDocumentPath(store),JSON.stringify(raw,null,2)+'\n');});
afterEach(async()=>{vi.restoreAllMocks();await rm(root,{recursive:true,force:true});});
it('previews readonly and commits each Task, project link and Job together, then verifies older step contexts after reopen',async()=>{const initial=await store.getProjectSnapshot(),before=vault.writes.length,review=await prepare();expect(vault.writes.length).toBe(before);expect(review.job.projectBinding).toMatchObject({projectId,title:'纯虚构关联项目',state:'started'});expect(validateProjectJobDocument({version:1,job:review.job})).toBe(true);const result=await runner.startConfirmed(review);expect(result.snapshot.document.job?.status).toBe('completed');const s=await store.getProjectSnapshot();expect(s.tasks).toHaveLength(3);expect(s.tasks[0]).toEqual(initial.tasks[0]);expect(s.document.projects[0].taskIds).toEqual(s.tasks.map(t=>t.id));expect(s.document.projects[0]).toMatchObject({state:'started',nextStep:'原下一步',commitments:'保留原承诺',blockers:'仍缺对照',future:'保留项目扩展'});expect((s.document as any).future).toEqual({preserve:true});const audit=await store.readJson<any>(new OperationLedger(store).filePath,{version:1,records:[]});for(const step of result.snapshot.document.job!.steps){const record=audit.records.find((r:any)=>r.operationId===step.operationId)!;expect(record.result!.undo).toMatchObject({kind:'restore_guarded_files'});expect((record.result!.undo as any).files).toHaveLength(3);expect(record.result!.jobCheckpoint?.planHash).toBe(review.job.planHash);}const raw=await vault.bytes(projectDocumentPath(store));reopen();expect((await runner.inspect()).message).toContain('全部保存');const nw=vault.writes.length;await runner.resume(await job());expect(vault.writes.length).toBe(nw);expect(await vault.bytes(projectDocumentPath(store))).toBe(raw);});
it('keeps unbound legacy plans without any new field and with the previous plan hash layout',async()=>{const review=await runner.prepare(tasks(),'旧无关联安排',[source]);expect(Object.hasOwn(review.job,'projectBinding')).toBe(false);const j=review.job;const legacy=recordRevision({id:j.id,userMessage:j.userMessage,authorization:j.authorization,createdAt:j.createdAt,deadlineAt:j.deadlineAt,steps:j.steps.map(s=>({toolName:s.toolName,operationId:s.operationId,arguments:s.arguments,fingerprint:s.fingerprint})),baseline:Object.fromEntries(['contextRevision','memoryRevision','protectedRevision','settingsRevision','taskJsonHash','taskMirrorHash','sourcePaths'].map(k=>[k,j.baseline[k]]))});expect(projectJobPlanHash(j as any)).toBe(legacy);await runner.startConfirmed(review);expect((await project()).taskIds).toHaveLength(1);expect((await runner.inspect()).message).toContain('全部保存');});
it.each(['missing','terminal','goal_source_excluded','task_db_excluded'])('refuses unavailable project selection %s without a plan or Task write',async cause=>{if(cause==='terminal')await save({kind:'save_project',id:projectId,input:{state:'completed',stateNote:'纯虚构结束依据'}});if(cause==='goal_source_excluded'){const path=store.path(store.settings.folders.goals,'纯虚构来源.md');await vault.seed(path,'纯虚构来源');await save({kind:'save_goal',id:(await store.getProjectSnapshot()).document.goals[0].id,input:{sourcePath:path}});store.settings.privacy={excludedVaultPrefixes:[path]};}if(cause==='task_db_excluded')store.settings.privacy={excludedVaultPrefixes:[store.taskDbPath()]};const before=vault.writes.length;await expect(runner.prepare(tasks(),'纯虚构绑定',[],undefined,cause==='missing'?'project-'+('a'.repeat(24)):projectId)).rejects.toThrow();expect(vault.writes.length).toBe(before);expect((await job()).document.job).toBeNull();});
it('rejects a project change after preview and retains the new project original bytes',async()=>{const review=await prepare();await save({kind:'save_project',id:projectId,input:{blockers:'纯虚构后来新阻塞'}});const raw=await vault.bytes(projectDocumentPath(store)),before=vault.writes.length;await expect(runner.startConfirmed(review)).rejects.toThrow();expect(await vault.bytes(projectDocumentPath(store))).toBe(raw);expect(vault.writes.length).toBe(before);});
it('rolls back a cancelled Task before association and leaves no orphan task or project link',async()=>{const review=await prepare(),raw=await vault.bytes(projectDocumentPath(store)),json=await vault.bytes(store.taskDbPath()),mirror=await vault.bytes(store.taskMirrorPath()),entered=deferred(),release=deferred(),request=new AbortController(),tool=getLifeOpsTool('create_task')!,original=tool.execute;vi.spyOn(tool,'execute').mockImplementation(async(...args)=>{const r=await original(...args);entered.resolve();await release.promise;return r;});const pending=runner.startConfirmed(review,request.signal);await entered.promise;request.abort();release.resolve();expect((await pending).snapshot.document.job?.status).toBe('cancelled');expect(await vault.bytes(projectDocumentPath(store))).toBe(raw);expect(await vault.bytes(store.taskDbPath())).toBe(json);expect(await vault.bytes(store.taskMirrorPath())).toBe(mirror);expect((await job()).document.job?.status).toBe('cancelled');});
it('preserves one actually committed association when cancelling after commit and stops remaining tasks',async()=>{const entered=deferred(),release=deferred();runtime=new AgentRuntime({store,refreshViews:async()=>{entered.resolve();await release.promise;}});runner=new ProjectJobRunner(store,runtime,clock);const pending=runner.startConfirmed(await prepare());await entered.promise;const stopping=runner.cancel(await job());release.resolve();await pending;await stopping;const j=(await job()).document.job!;expect(j.status).toBe('cancelled');expect(j.nextStep).toBe(1);expect((await store.readTaskDb()).tasks).toHaveLength(2);expect((await project()).taskIds).toEqual((await store.readTaskDb()).tasks.map(t=>t.id));});
it('reopens a failed second step and appends only the missing task and association',async()=>{const tool=getLifeOpsTool('create_task')!,original=tool.execute;let calls=0;const spy=vi.spyOn(tool,'execute').mockImplementation(async(...args)=>{if(++calls===2)throw Error('纯虚构第二项暂不可保存');return original(...args);});await expect(runner.startConfirmed(await prepare())).rejects.toThrow();expect((await job()).document.job?.nextStep).toBe(1);expect((await project()).taskIds).toHaveLength(2);spy.mockRestore();reopen();expect((await runner.inspect()).canResume).toBe(true);await runner.resume(await job());expect((await store.readTaskDb()).tasks).toHaveLength(3);expect((await project()).taskIds).toEqual((await store.readTaskDb()).tasks.map(t=>t.id));expect((await runner.inspect()).message).toContain('全部保存');});
it('rolls back the linked pair when source changes at the last commit guard and preserves the external source',async()=>{const raw=await vault.bytes(projectDocumentPath(store)),json=await vault.bytes(store.taskDbPath()),original=OperationLedger.prototype.verify;vi.spyOn(OperationLedger.prototype,'verify').mockImplementation(async function(this:InstanceType<typeof OperationLedger>,...args){const record=await original.apply(this,args);if(args[0].startsWith('job:')&&args[0].includes(':step:'))await vault.seed(source,'纯虚构外部新来源');return record;});await expect(runner.startConfirmed(await prepare())).rejects.toThrow();expect(await vault.bytes(projectDocumentPath(store))).toBe(raw);expect(await vault.bytes(store.taskDbPath())).toBe(json);expect(await vault.bytes(source)).toBe('纯虚构外部新来源');});
it('undo restores Task and association together and refuses further resume of reverted evidence',async()=>{const before=await vault.bytes(projectDocumentPath(store));const result=await runner.startConfirmed(await prepare());await runtime.undoOperation(result.snapshot.document.job!.steps[1].operationId);expect((await store.readTaskDb()).tasks).toHaveLength(2);expect((await project()).taskIds).toEqual((await store.readTaskDb()).tasks.map(t=>t.id));expect((await runner.inspect()).canResume).toBe(false);const raw=await vault.bytes(projectDocumentPath(store));const nw=vault.writes.length;expect((await runner.resume(await job())).canResume).toBe(false);expect(vault.writes.length).toBe(nw);expect(await vault.bytes(projectDocumentPath(store))).toBe(raw);expect(raw).not.toBe(before);});
it.each(['other_goal','state','old_link','extension'])('refuses a forged audited project delta %s even with recomputed content hashes',async cause=>{const result=await runner.startConfirmed(await prepare()),step=result.snapshot.document.job!.steps[0],audit=await store.readJson<any>(new OperationLedger(store).filePath,{version:1,records:[]}),record=audit.records.find((r:any)=>r.operationId===step.operationId)!,files=structuredClone((record.result!.undo as any).files),f=files.find((f:any)=>f.path===projectDocumentPath(store)),doc=JSON.parse(f.after),p=doc.projects[0];if(cause==='other_goal')doc.goals[0].future='伪造新增';if(cause==='state')p.state='agreed';if(cause==='old_link')p.taskIds=p.taskIds.slice(-1);if(cause==='extension')p.future='伪造修改';const change=p.changes.at(-1);change.fields=Object.fromEntries(PROJECT_SNAPSHOT_FIELDS.map(k=>[k,p[k]]));change.receipt.contentHash=continuityHash(change.fields);f.after=JSON.stringify(doc,null,2)+'\n';f.afterHash=fileRevision(f.after);await expect(verifyProjectLinkedTaskFiles(store,files,step.operationId,step.arguments,result.snapshot.document.job!.projectBinding!)).rejects.toThrow();});
it('routes a production chat plan to the exact host-bound project and shows it before any write',async()=>{const registry=new TaskPlanReviewRegistry(store,()=>runner,()=>{},clock),plugin:any=Object.assign(Object.create(LifeOpsPlugin.prototype),{app:store.app,store,settings:store.settings,refreshViews:vi.fn(async()=>{}),projectJobRunner:runner,taskPlanReviews:registry,unloaded:false,lifecycleGeneration:0}),nw=vault.writes.length;const result=await plugin.executeToolCalls([{id:'fictional-linked-plan-model',name:'propose_task_plan',arguments:{tasks:tasks(),projectId}}],'请安排纯虚构项目任务',undefined,undefined,undefined,[source]);expect(result.results[0].success,result.results[0].output).toBe(true);expect(result.actions[0].content).toContain('关联项目：纯虚构关联项目');expect(result.actions[0].content).toContain('进行中');expect(result.actions[0].content).not.toContain(projectId);expect(vault.writes.length).toBe(nw);await plugin.executeAgentAction(result.actions[0]);expect((await project()).taskIds).toEqual((await store.readTaskDb()).tasks.map(t=>t.id));});
it.each(['remove', 'rename', 'swap', 'add_to_legacy'])('refuses a changed binding %s even with a new plan hash and retains authorization bytes', async change => {
  const repo = new ProjectJobRepository(store), review = change === 'add_to_legacy'
    ? await runner.prepare(tasks(), '纯虚构无关联原授权', [source]) : await prepare();
  const queued = await repo.updateMetadata(await repo.load(), structuredClone(review.job));
  const candidate = structuredClone(queued.document.job!);
  if (change === 'remove') delete candidate.projectBinding;
  else if (change === 'add_to_legacy') candidate.projectBinding = structuredClone((await runnerBinding()).projectBinding!);
  else if (change === 'rename') candidate.projectBinding!.title = '纯虚构别的标题';
  else candidate.projectBinding!.projectId = 'project-' + 'a'.repeat(24);
  candidate.planHash = projectJobPlanHash(candidate); candidate.revision++;
  candidate.status = 'cancelled'; candidate.generation++; candidate.finishedAt = clock().toISOString();
  const writes = vault.writes.length, audit = await vault.bytes(new OperationLedger(store).filePath);
  await expect(repo.updateMetadata(queued, candidate)).rejects.toThrow();
  expect((await repo.load()).raw).toBe(queued.raw); expect(vault.writes.length).toBe(writes);
  expect(await vault.bytes(new OperationLedger(store).filePath)).toBe(audit);
  // The authorization in the local audit also rejects a recomputed forged Job saved externally.
  candidate.status = 'queued'; candidate.revision = 0; candidate.generation = 0; candidate.finishedAt = null;
  await vault.seed(projectJobPath(store), JSON.stringify({ version: 1, job: candidate }, null, 2) + '\n');
  const forged = await vault.bytes(projectJobPath(store)); expect((await runner.inspect()).canResume).toBe(false);
  await expect(runner.resume(await repo.load())).rejects.toThrow(); expect(await vault.bytes(projectJobPath(store))).toBe(forged);
  expect((await store.readTaskDb()).tasks).toHaveLength(1);
  async function runnerBinding() {
    // Build the expected six host fields without clearing the active authorization.
    const snapshot = await store.getProjectSnapshot(), p = snapshot.document.projects[0], g = snapshot.document.goals[0];
    return { projectBinding: { projectId: p.id, title: p.title, goalId: g.id, goalTitle: g.title,
      state: p.state as 'started', initialProjectHash: snapshot.revision } };
  }
});
it('does not promote an unknown legacy binding extension into new authority', async () => {
  const review = await runner.prepare(tasks(), '纯虚构旧扩展', [source]), repo = new ProjectJobRepository(store);
  const queued = await repo.updateMetadata(await repo.load(), structuredClone(review.job)), document = JSON.parse(queued.raw!);
  document.job.projectBinding = { futureVendor: '保留原字，不能执行' };
  await vault.seed(projectJobPath(store), JSON.stringify(document) + '\n'); const raw = await vault.bytes(projectJobPath(store)), nw = vault.writes.length;
  await expect(repo.load()).rejects.toThrow(); await expect(runner.inspect()).rejects.toThrow();
  expect(await vault.bytes(projectJobPath(store))).toBe(raw); expect(vault.writes.length).toBe(nw);
});
it.each(['source', 'privacy', 'memory', 'project'])('keeps the first committed Task and link, then refuses the remaining plan after %s changes', async change => {
  let refreshes = 0, changedRaw = '';
  runtime = new AgentRuntime({ store, refreshViews: async () => {
    if (++refreshes !== 1) return;
    if (change === 'source') await vault.seed(source, '纯虚构来源后来修改');
    if (change === 'privacy') store.settings.privacy = { excludedVaultPrefixes: [source] };
    if (change === 'memory') await vault.seed(store.personalMemoryPath(), JSON.stringify({ version: 1, records: [], future: '纯虚构外部修改' }));
    if (change === 'project') {
      const path = projectDocumentPath(store); changedRaw = (await vault.bytes(path)) + '\n'; await vault.seed(path, changedRaw);
    }
  } });
  runner = new ProjectJobRunner(store, runtime, clock);
  await expect(runner.startConfirmed(await prepare())).rejects.toThrow();
  const snapshot = await store.getProjectSnapshot(); expect(snapshot.tasks).toHaveLength(2);
  expect(snapshot.document.projects[0].taskIds).toEqual(snapshot.tasks.map(t => t.id));
  if (changedRaw) expect(await vault.bytes(projectDocumentPath(store))).toBe(changedRaw);
  expect((await runner.inspect()).canResume).toBe(false); const nw = vault.writes.length;
  await expect(runner.resume(await job())).rejects.toThrow(); expect(vault.writes.length).toBe(nw);
  expect((await store.readTaskDb()).tasks).toHaveLength(2);
});
it.each([true, false].flatMap(bound => [false, true].map(goalRef => ({ bound, goalRef }))))
  ('saves and reopens a $bound bound plan that read the Task mirror, with goalRef=$goalRef, without mistaking its audited update for an external source edit', async ({ bound, goalRef }) => {
    const mirror = store.taskMirrorPath();
    if (goalRef) await save({ kind: 'save_goal', id: (await store.getProjectSnapshot()).document.goals[0].id, input: { sourcePath: mirror } });
    const originalTasks = (await store.readTaskDb()).tasks;
    const review = await runner.prepare(tasks(), '纯虚构读取任务看板后安排', [mirror], undefined, bound ? projectId : '');
    const saved = await runner.startConfirmed(review); expect(saved.snapshot.document.job?.status).toBe('completed');
    expect((await store.readTaskDb()).tasks.slice(0, originalTasks.length)).toEqual(originalTasks);
    expect((await project()).taskIds).toHaveLength(bound ? 3 : 1);
    const raw = await vault.bytes(projectDocumentPath(store)); reopen(); expect((await runner.inspect()).message).toContain('全部保存');
    const writes = vault.writes.length; await runner.resume(await job()); expect(vault.writes.length).toBe(writes);
    expect(await vault.bytes(projectDocumentPath(store))).toBe(raw);
  });
it.each([true, false])('recomputes only an audited Task artifact source for a bound=%s plan and preserves historical artifact evidence', async bound => {
  await save({ kind: 'add_entry', projectId, entryKind: 'output', text: '纯虚构原任务看板产出', path: store.taskMirrorPath() });
  const initial = await store.getProjectSnapshot(), entry = initial.document.projects[0].entries[0]; expect(initial.artifacts[entry.id]).toBe('unchanged');
  const result = await runner.startConfirmed(await runner.prepare(tasks(), '纯虚构读取原产出后安排', [store.taskMirrorPath()], undefined, bound ? projectId : ''));
  expect(result.snapshot.document.job?.status).toBe('completed'); const current = await store.getProjectSnapshot();
  expect(current.artifacts[entry.id]).toBe('changed'); expect(current.document.projects[0].entries[0]).toEqual(entry);
  reopen(); expect((await runner.inspect()).message).toContain('全部保存');
});
it('retains an external handwritten mirror edit during the last commit guard and never treats it as its own source update', async () => {
  const initial = await store.getProjectSnapshot(), original = OperationLedger.prototype.verify; let external = '';
  vi.spyOn(OperationLedger.prototype, 'verify').mockImplementation(async function(this: InstanceType<typeof OperationLedger>, ...args) {
    const record = await original.apply(this, args);
    if (args[0].startsWith('job:') && args[0].includes(':step:')) {
      external = (await vault.bytes(store.taskMirrorPath())) + '\n## 纯虚构外部手写\n必须保留\n'; await vault.seed(store.taskMirrorPath(), external);
    }
    return record;
  });
  await expect(runner.startConfirmed(await runner.prepare(tasks(), '纯虚构看板来源', [store.taskMirrorPath()], undefined, projectId))).rejects.toThrow();
  expect(await vault.bytes(store.taskMirrorPath())).toBe(external);
  const remaining = (await store.readTaskDb({ readOnly: true })).tasks;
  expect(remaining.slice(0, initial.tasks.length)).toEqual(initial.tasks);
  expect(remaining.some(task => task.title === tasks()[1].title)).toBe(false);
  const links = (await project()).taskIds;
  expect(links.slice(0, initial.document.projects[0].taskIds.length)).toEqual(initial.document.projects[0].taskIds);
  expect(links).toEqual(remaining.map(task => task.id));
  const recovery = await store.readJson<any>(store.path(store.settings.folders.aiReports, 'Operations', 'write-recovery.json'), null);
  expect(recovery).toMatchObject({ status: 'pending', rollbackRequired: true });
  expect((await runner.inspect()).message).toContain('保存中断');
  const paths = [store.taskDbPath(), store.taskMirrorPath(), projectDocumentPath(store), projectJobPath(store)],
    pendingBytes = await Promise.all(paths.map(path => vault.bytes(path))), writes = vault.writes.length;
  await expect(runner.resume(await job())).rejects.toThrow();
  expect(await Promise.all(paths.map(path => vault.bytes(path)))).toEqual(pendingBytes);
  expect(vault.writes.length).toBe(writes);
});
