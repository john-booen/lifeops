import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import { DEFAULT_SETTINGS } from "../src/defaults";
import type { StoreHost } from "../src/store/settingsSlice";
import type { LifeOpsTask } from "../src/types";
import { formatVaultTaskBlock, parseVaultTasks } from "../src/vaultApi";
import { todayString } from "../src/date";
vi.mock("obsidian", () => ({ App: class {}, Notice: class {}, TFile: class {}, TFolder: class {}, normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/{2,}/g, "/") }));
const { LifeOpsStore } = await import("../src/store");
const { DiskVault } = await import("./helpers/diskVault");
let vault: InstanceType<typeof DiskVault>;
let store: StoreHost;
let root: string;
const NOW = "2026-09-09T00:00:00.000Z";
function task(overrides: Partial<LifeOpsTask> = {}): LifeOpsTask {
  return { id: "child", title: "核对资料", status: "active", priority: "high", quadrant: "important-not-urgent", category: "测试", project: "项目", date: "2026-09-09", endDate: "2026-09-10", time: "09:30", dueDate: "2026-09-10", dueTime: "18:00", repeatUnit: "none", repeatInterval: 1, repeatUntil: "", parentTaskId: "parent", note: "原有备注", source: "manual", sourceNotePath: "日记/source.md", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: NOW, completedAt: "", completionLog: [{ completedAt: "2026-08-01T00:00:00.000Z", note: "保留旧历史" }], sortOrder: 4, ...overrides };
}
function board(tasks: LifeOpsTask[]): string {
  return '# LifeOps 任务看板\n\n> 保留自定义说明。\n\n'+([['进行中','active'],['已完成','completed'],['放弃','abandoned']] as const).map(([heading,status])=>`## ${heading}\n${tasks.filter(t=>t.status===status).map(formatVaultTaskBlock).join('\n')}\n`).join('\n')+'\n## 我的补充\n请保留这里的内容。\n';
}
async function seed(tasks = [task()]) { await vault.seed(store.taskDbPath(), JSON.stringify({ tasks, extraRoot: { keep: true } },null,2)+'\n'); await vault.seed(store.taskMirrorPath(),board(tasks)); vault.writes.length=0; }
async function saved() { return JSON.parse(await vault.bytes(store.taskDbPath())); }
beforeEach(async()=>{root=await mkdtemp(join(tmpdir(),'lifeops-task-authority-'));vault=new DiskVault(root);store=new LifeOpsStore({vault} as unknown as App,structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;});
afterEach(async()=>{await rm(root,{recursive:true,force:true});});
describe('task JSON authority using actual files',()=>{
 it('reads complete JSON fields without replacing them with the readable projection',async()=>{await seed();expect((await store.readTaskDb()).tasks[0]).toEqual(task());expect(vault.writes).toEqual([]);});
 it('never repairs an absent mirror as a side effect of ordinary or readOnly reads',async()=>{await vault.seed(store.taskDbPath(),JSON.stringify({tasks:[task()]}));await store.readTaskDb();await store.readTaskDb({readOnly:true});expect(vault.writes).toEqual([]);});
 it('creates a task without losing existing fields, root extensions or multiline notes',async()=>{await seed();const created=await store.createTask({title:'新任务',date:'2026-09-09',parentTaskId:'parent',sourceNotePath:'日记/new.md',note:'第一行\n第二行'});const db=await saved();expect(db.tasks.find((t:LifeOpsTask)=>t.id==='child')).toEqual(task());expect(db.tasks.find((t:LifeOpsTask)=>t.id===created.id)).toEqual(created);expect(db.extraRoot).toEqual({keep:true});expect(created.id).not.toBe('child');expect(await vault.bytes(store.taskMirrorPath())).toContain('请保留这里的内容');});
 it('completes a task without dropping its metadata or full completion history',async()=>{await seed();await store.completeTask('child','新完成说明');const got=(await saved()).tasks[0];expect(got.parentTaskId).toBe('parent');expect(got.createdAt).toBe(task().createdAt);expect(got.sourceNotePath).toBe('日记/source.md');expect(got.completionLog).toHaveLength(2);expect(got.completionLog[0]).toEqual(task().completionLog[0]);expect(got.completionLog[1].note).toBe('新完成说明');expect(got.status).toBe('completed');});
 it('preserves unknown task members across an ordinary edit',async()=>{const item={...task(),futureData:{keep:[1,2]}};await seed([item]);await store.updateTaskDetails('child',{title:'新标题'});expect((await saved()).tasks[0].futureData).toEqual({keep:[1,2]});expect((await saved()).extraRoot).toEqual({keep:true});});
 it('rejects a changed mirror without overwriting either copy',async()=>{await seed();await vault.seed(store.taskMirrorPath(),board([task({title:'后来在文章里修改'})]));const before=await saved();const oldBoard=await vault.bytes(store.taskMirrorPath());await expect(store.postponeTask('child',1)).rejects.toThrow();expect(await saved()).toEqual(before);expect(await vault.bytes(store.taskMirrorPath())).toBe(oldBoard);expect(vault.writes).toEqual([]);});
 it('rejects duplicate task IDs before a mutation',async()=>{await seed([task(),task({title:'同 ID 第二个任务'})]);await expect(store.createTask({title:'新任务'})).rejects.toThrow();expect(vault.writes).toEqual([]);});
 it('never silently replaces a missing JSON database from a nonempty legacy board',async()=>{await vault.seed(store.taskMirrorPath(),board([task()]));const before=await vault.bytes(store.taskMirrorPath());await expect(store.createTask({title:'新任务'})).rejects.toThrow();expect(await vault.bytes(store.taskMirrorPath())).toBe(before);expect(vault.writes).toEqual([]);});
 it('rejects a same-version edit made after a database was read',async()=>{await seed();const read=await store.readTaskDb();read.tasks[0].title='stale edit';const current={tasks:[task({note:'后来手动增加'})]};await vault.seed(store.taskDbPath(),JSON.stringify(current));await expect(store.writeTaskDb(read)).rejects.toThrow();expect(await saved()).toEqual(current);});
 it('keeps JSON authority even when a readable mirror has a different title',async()=>{await seed();await vault.seed(store.taskMirrorPath(),board([task({title:'未确认的看板修改'})]));expect((await store.readTaskDb({readOnly:true})).tasks[0].title).toBe('核对资料');expect(vault.writes).toEqual([]);});
});

describe('task coordination and conflict boundaries',()=>{
 it.each(['postpone','quadrant','move','edit','delete','order'] as const)('keeps unrelated data during %s',async(kind)=>{
  const original=task({id:'untouched',sortOrder:9});await seed([task(),original]);
  if(kind==='postpone')await store.postponeTasks(['child'],2);
  else if(kind==='quadrant')await store.moveTaskToQuadrant('child','important-urgent');
  else if(kind==='move')await store.moveTaskToDate('child','2026-09-20');
  else if(kind==='edit')await store.updateTaskDetails('child',{title:'只改标题'});
  else if(kind==='delete')await store.deleteTask('child');
  else await store.moveTaskOrder('child','down');
  const db=await saved();const got=db.tasks.find((t:LifeOpsTask)=>t.id==='untouched');
  expect(got.parentTaskId).toBe(original.parentTaskId);expect(got.sourceNotePath).toBe(original.sourceNotePath);expect(got.createdAt).toBe(original.createdAt);expect(got.completionLog).toEqual(original.completionLog);expect(db.extraRoot).toEqual({keep:true});
  expect(await vault.bytes(store.taskMirrorPath())).toContain('请保留这里的内容');
 });
 it('preserves omitted edit fields and permits an explicit clear',async()=>{await seed();await store.updateTaskDetails('child',{title:'只改标题'});const got=(await saved()).tasks[0];expect({...got,title:task().title,updatedAt:NOW}).toEqual(task());await store.updateTaskDetails('child',{title:'只改标题',note:''});expect((await saved()).tasks[0].note).toBe('');});
 it('completes a repeating task and retains parent/source/history for the next instance',async()=>{await seed([task({repeatUnit:'day'})]);await store.completeTask('child','done');const tasks=(await saved()).tasks;expect(tasks).toHaveLength(2);const next=tasks.find((t:LifeOpsTask)=>t.id!=='child');expect(next.parentTaskId).toBe('parent');expect(next.sourceNotePath).toBe(task().sourceNotePath);expect(next.date).toBe('2026-09-10');expect(tasks.find((t:LifeOpsTask)=>t.id==='child').completionLog).toHaveLength(2);});
 it('uses distinct IDs for deliberately repeated equal titles',async()=>{await seed([]);const first=await store.createTask({title:'同名',date:'2026-09-09'});const second=await store.createTask({title:'同名',date:'2026-09-09'});expect(first.id).not.toBe(second.id);expect((await saved()).tasks).toHaveLength(2);});
 it('preserves indented legacy completion remarks and custom sections',async()=>{await seed();await vault.seed(store.taskMirrorPath(),board([task()]).replace('  - 备注：原有备注','  - 备注：原有备注\n  - 完成备注：旧系统留下的额外说明'));await store.postponeTask('child',1);expect(await vault.bytes(store.taskMirrorPath())).toContain('  - 完成备注：旧系统留下的额外说明');expect(await vault.bytes(store.taskMirrorPath())).toContain('请保留这里的内容');});
 it('rejects ambiguous free text inside a generated task section without deleting it',async()=>{await seed();const content=board([task()]).replace('## 已完成','这行手写文字必须保留。\n\n## 已完成');await vault.seed(store.taskMirrorPath(),content);await expect(store.postponeTask('child',1)).rejects.toThrow();expect(await vault.bytes(store.taskMirrorPath())).toBe(content);expect(vault.writes).toEqual([]);});
 it('rechecks JSON within the actual process callback',async()=>{await seed();const manual=JSON.stringify({tasks:[task({note:'later edit'})]});vault.beforeProcess=async file=>{expect(file.path).toBe(store.taskDbPath());await vault.seed(store.taskDbPath(),manual);};await expect(store.postponeTask('child',1)).rejects.toThrow();expect(await vault.bytes(store.taskDbPath())).toBe(manual);});
 it('never advances the read revision of a different forked change',async()=>{await seed();const before=await store.readTaskDb();const first={...before,tasks:[{...before.tasks[0],title:'first'}]};const second={...before,tasks:[{...before.tasks[0],title:'second'}]};await store.writeTaskDb(first);await expect(store.writeTaskDb(second)).rejects.toThrow();expect((await saved()).tasks[0].title).toBe('first');});
 it('restores JSON when mirror updating fails before changing the mirror',async()=>{await seed();const original=await vault.bytes(store.taskDbPath());const oldBoard=await vault.bytes(store.taskMirrorPath());const process=vault.process.bind(vault);let once=true;vault.process=async(file,update)=>{if(file.path===store.taskMirrorPath()&&once){once=false;throw new Error('synthetic mirror failure');}return process(file,update);};await expect(store.postponeTask('child',1)).rejects.toThrow('synthetic mirror failure');expect(await vault.bytes(store.taskDbPath())).toBe(original);expect(await vault.bytes(store.taskMirrorPath())).toBe(oldBoard);});
 it('rejects a board-only new task and an empty board when JSON has existing tasks',async()=>{await seed();const before=await vault.bytes(store.taskDbPath());for(const content of [board([task(),task({id:'board-only'})]),'']){await vault.seed(store.taskMirrorPath(),content);await expect(store.createTask({title:'next'})).rejects.toThrow();expect(await vault.bytes(store.taskDbPath())).toBe(before);expect(await vault.bytes(store.taskMirrorPath())).toBe(content);}});
 it('routes the Store-backed Vault API through complete canonical records',async()=>{await seed();const {createStoreVaultApi}=await import('../src/store/settingsSlice');const api=createStoreVaultApi(store);expect((await api.readTasks())[0]).toEqual(task());const created=await api.createTask({title:'adapter task',parentTaskId:'child',sourceNotePath:'source.md'});expect((await api.readTasks()).find(t=>t.id===created.id)).toEqual(created);await api.completeTask('核对资料','adapter done');expect((await saved()).tasks.find((t:LifeOpsTask)=>t.id==='child').completionLog).toHaveLength(2);});
 it('rejects ambiguous title completion through the Store adapter',async()=>{await seed([task(),task({id:'other'})]);const {createStoreVaultApi}=await import('../src/store/settingsSlice');await expect(createStoreVaultApi(store).completeTask('核对资料')).rejects.toThrow();expect(vault.writes).toEqual([]);});
 it.each([null,{...task(),completionLog:'bad'},{...task(),id:''}])('rejects damaged task members without a write: %j',async(value)=>{await vault.seed(store.taskDbPath(),JSON.stringify({tasks:[value]}));await expect(store.readTaskDb()).rejects.toThrow();expect(vault.writes).toEqual([]);});
});

describe('persistent mirror version',()=>{
 it('rejects later handwritten additions even outside generated task fields',async()=>{await seed();await store.postponeTask('child',1);const before=await vault.bytes(store.taskDbPath());const changed=(await vault.bytes(store.taskMirrorPath()))+'\n后来增加的个人说明\n';await vault.seed(store.taskMirrorPath(),changed);vault.writes.length=0;await expect(store.postponeTask('child',1)).rejects.toThrow();expect(await vault.bytes(store.taskDbPath())).toBe(before);expect(await vault.bytes(store.taskMirrorPath())).toBe(changed);expect(vault.writes).toEqual([]);});
 it('preserves unknown legacy metadata fields during initial adoption',async()=>{await seed();await vault.seed(store.taskMirrorPath(),board([task()]).replace('ID=child','ID=child · 自定义字段=保留这里'));await store.postponeTask('child',1);expect(await vault.bytes(store.taskMirrorPath())).toContain('自定义字段=保留这里');await store.postponeTask('child',1);expect((await vault.bytes(store.taskMirrorPath())).match(/自定义字段=保留这里/g)).toHaveLength(1);});
 it('rejects an unknown mirror metadata version without altering any record',async()=>{await seed();await vault.seed(store.taskDbPath(),JSON.stringify({tasks:[task()],taskMirror:{version:2,sha256:'a'.repeat(64)}}));await expect(store.readTaskDb()).rejects.toThrow();expect(vault.writes).toEqual([]);});
 it('compensates a mirror write whose readback then fails',async()=>{await seed();const originalJson=await vault.bytes(store.taskDbPath());const originalMirror=await vault.bytes(store.taskMirrorPath());const process=vault.process.bind(vault);let fail=false;const read=vault.read.bind(vault);vault.process=async(file,fn)=>{const result=await process(file,fn);if(file.path===store.taskMirrorPath())fail=true;return result;};vault.read=async(file)=>{if(fail&&file.path===store.taskMirrorPath()){fail=false;throw new Error('synthetic readback failure');}return read(file);};await expect(store.postponeTask('child',1)).rejects.toThrow();expect(await vault.bytes(store.taskDbPath())).toBe(originalJson);expect(await vault.bytes(store.taskMirrorPath())).toBe(originalMirror);});
});

describe('legacy format and stable projections',()=>{
 it('keeps an unscheduled task unscheduled on the board',async()=>{await seed([task({date:'',endDate:'',dueDate:'',dueTime:'',priority:'none'})]);await store.updateTaskDetails('child',{title:'无日期任务'});const text=await vault.bytes(store.taskMirrorPath());expect(text).toContain('日期=无日期');expect(text).toContain('优先级=无');expect((await saved()).tasks[0].date).toBe('');});
 it('does not invent changing order timestamps for an old record',async()=>{const item={...task(),createdAt:'',sortOrder:undefined};await vault.seed(store.taskDbPath(),JSON.stringify({tasks:[item]}));const first=await store.readTaskDb();const second=await store.readTaskDb();expect(first.tasks[0].sortOrder).toBe(0);expect(second.tasks).toEqual(first.tasks);expect(vault.writes).toEqual([]);});
 it('protects unknown nested mirror versions even through generic JSON writes',async()=>{const raw=JSON.stringify({tasks:[task()],taskMirror:{version:7,sha256:'a'.repeat(64)}});await vault.seed(store.taskDbPath(),raw);await expect(store.writeJson(store.taskDbPath(),{tasks:[]})).rejects.toThrow();expect(await vault.bytes(store.taskDbPath())).toBe(raw);});
});

describe('legacy startup and mirror regeneration',()=>{
 it('does not hide a populated board behind an existing empty database',async()=>{await seed();await vault.seed(store.taskDbPath(),JSON.stringify({tasks:[]}));await expect(store.readTaskDb()).rejects.toThrow();expect(vault.writes).toEqual([]);});
 it('does not initialize an empty database over a legacy board-only installation',async()=>{await vault.seed(store.taskMirrorPath(),board([task()]));await store.initializeVault();expect(store.getFile(store.taskDbPath())).toBeNull();expect((await store.readTaskDb({readOnly:true})).tasks[0].id).toBe('child');});
 it('refreshes the recorded mirror hash when rebuilding a missing projection',async()=>{await seed();await store.postponeTask('child',1);await vault.delete(store.getFile(store.taskMirrorPath())!);const database=await store.readTaskDb();await store.writeTaskMirror(database.tasks);await store.postponeTask('child',1);expect((await saved()).tasks[0].date).toBe('2026-09-11');});
});

describe("task creation preserves independently optional dates", () => {
  it.each([
    { label: "empty modal fields", input: { date: "", endDate: "", dueDate: "" }, dates: { date: "", endDate: "", dueDate: "" }, today: false },
    { label: "omitted fields", input: {}, dates: { date: "", endDate: "", dueDate: "" }, today: false },
    { label: "whitespace fields", input: { date: " ", endDate: " ", dueDate: " " }, dates: { date: "", endDate: "", dueDate: "" }, today: false },
    { label: "scheduled date only", input: { date: "2026-09-10" }, dates: { date: "2026-09-10", endDate: "", dueDate: "" }, today: true },
    { label: "deadline only", input: { dueDate: "2026-09-15" }, dates: { date: "", endDate: "", dueDate: "2026-09-15" }, today: false },
    { label: "date range without deadline", input: { date: "2026-09-10", endDate: "2026-09-12" }, dates: { date: "2026-09-10", endDate: "2026-09-12", dueDate: "" }, today: true },
    { label: "three independent dates", input: { date: " 2026-09-10 ", endDate: "2026-09-12", dueDate: "2026-09-15" }, dates: { date: "2026-09-10", endDate: "2026-09-12", dueDate: "2026-09-15" }, today: true }
  ])("persists $label through JSON, Markdown and a fresh dashboard", async ({ input, dates, today }) => {
    await seed([]);
    const created = await store.createTask({ title: "检查可选日期", project: "日期测试", note: "第一版", ...input });
    expect(created).toMatchObject(dates);
    expect((await saved()).tasks).toEqual([created]);

    const mirror = await vault.bytes(store.taskMirrorPath());
    const displayedDate = dates.date ? `${dates.date}${dates.endDate ? ` -> ${dates.endDate}` : ""}` : "无日期";
    expect(mirror).toContain(`日期=${displayedDate} · 时间=`);
    expect(mirror).toContain(`截止=${dates.dueDate} · ID=`);
    expect(parseVaultTasks(mirror)[0]).toMatchObject({ date: dates.date, dueDate: dates.dueDate });

    const reopened = new LifeOpsStore({ vault } as unknown as App, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;
    expect(await reopened.getTask(created.id)).toEqual(created);
    const dashboard = await reopened.getTaskDashboard("2026-09-10");
    expect(dashboard.noDate.map(item => item.id)).toEqual(dates.date ? [] : [created.id]);
    expect(dashboard.today.map(item => item.id)).toEqual(today ? [created.id] : []);
    expect(dashboard.overdue).toEqual([]);
    await reopened.updateTaskDetails(created.id, { title: "修改标题仍不填日期" });
    expect((await saved()).tasks[0]).toMatchObject({ ...dates, project: "日期测试", note: "第一版" });
  });


});
