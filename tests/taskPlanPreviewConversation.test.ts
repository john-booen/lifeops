import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, beforeEach, expect, it, vi} from "vitest";
import type {App} from "obsidian";
import type {StoreHost} from "../src/store/settingsSlice";
import {DEFAULT_SETTINGS} from "../src/defaults";
import {normalizeJournalDate, todayString} from "../src/date";
import {OperationLedger} from "../src/dataFoundation/operationLedger";
const request = vi.hoisted(() => vi.fn());
vi.mock("obsidian", () => ({App: class {}, Plugin: class {}, TFile: class {}, TFolder: class {}, WorkspaceLeaf: class {}, ItemView: class {},
  Modal: class {open() {}}, PluginSettingTab: class {}, Setting: class {}, Platform: {isDesktopApp: true}, Notice: class {}, setIcon: vi.fn(),
  normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/{2,}/g, "/"), requestUrl: request}));
const {LifeOpsStore} = await import("../src/store");
const {LifeOpsAi} = await import("../src/ai");
const {default: Plugin} = await import("../src/main");
const {DiskVault} = await import("./helpers/diskVault");
const {AgentRuntime} = await import("../src/agentRuntime");
const {armAdjacentTaskPlan,consumeAdjacentTaskPlan,consumeAdjacentTaskDecision} = await import("../src/panel/taskPlanApproval");
const title = "合成临时任务";
const message = "请帮我安排一项任务：合成临时任务，今天做，先给确认卡。";
const previewMessages = [message, "请先给我一张待确认的任务安排卡，只包含合成临时任务，今天做，暂不保存。",
  "请创建任务：合成临时任务，先给我确认卡，确认后再保存。", "帮我安排两项任务：合成甲、合成乙，先给确认卡。",
  "请新建一个临时任务，名字叫“合成临时任务”，先给我确认卡。",
  "帮我新增一条待办，名称为「合成临时任务」，先给我核对卡，暂不保存。"];
let root: string, vault: InstanceType<typeof DiskVault>, store: StoreHost, plugin: any, bodies: any[], calls: any[], published: string[];
const tool = (name = "propose_task_plan", args: unknown = {tasks: [{title, date: "今天"}]}, id = "fictional-preview") =>
  ({id, type: "function", function: {name, arguments: JSON.stringify(args)}});
const ledgerBytes = () => store.readPath(new OperationLedger(store).filePath);
const facts = async () => ({db: await vault.bytes(store.taskDbPath()), mirror: await vault.bytes(store.taskMirrorPath()), ledger: await ledgerBytes()});
beforeEach(async () => {
  vi.stubGlobal("window", globalThis); request.mockReset();
  root = await mkdtemp(join(tmpdir(), "lifeops-task-card-")); vault = new DiskVault(root);
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.privacy = {...settings.privacy, excludedVaultPrefixes: [], plaintextCredentialStorageAccepted: true};
  settings.ai = {...settings.ai, provider: "openai-compatible", endpoint: "https://example.test/chat", model: "kimi-k2.6", apiKey: "fictional-key", dataDisclosureAccepted: true};
  const app = {vault, workspace: {getLeavesOfType: () => []}} as unknown as App;
  store = new LifeOpsStore(app, settings) as unknown as StoreHost; await store.initializeVault();
  const ai = new LifeOpsAi(settings);
  plugin = Object.assign(Object.create(Plugin.prototype), {app, store, settings, ai, refreshViews: async () => {}, updateStatusBar: async () => {},
    lifeOpsEvents: {publish: () => {}}, buildSemanticContext: async () => ""});
  bodies = []; calls = [tool()]; published = [];
  request.mockImplementation(async ({body}: {body: string}) => {
    const payload = JSON.parse(body);
    bodies.push(payload);
    const pending = payload.messages.some((message: any) => message.role === "tool") ? [] : calls;
    const json = {choices: [{index: 0, finish_reason: pending.length ? "tool_calls" : "stop", message: {role: "assistant", content: "这是待确认安排，尚未保存。", tool_calls: pending}}]};
    return {status: 200, json, text: JSON.stringify(json)};
  });
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await rm(root, {recursive: true, force: true}); });
const run = (text = message, source: "text" | "voice" = "text") => plugin.submitAgentMessageStream(text, [], (text: string) => published.push(text), {selfTest: true, source});
for (const source of ["text", "voice"] as const) {
  it.each(previewMessages)(`uses the actual Main/transport to preview without saving (${source}): %s`, async text => {
    const before = await facts();
    const result = await run(text, source);
    expect(result.actions).toHaveLength(1); expect(result.actions[0]).toMatchObject({type: "task_plan"});
    expect(result.actions[0].content).toContain(title); expect(result.reply).toContain("尚未保存");
    expect(await facts()).toEqual(before);
  });
}
it("keeps original confirmation, completed Job and conflict-aware Undo after a successful preview", async () => {
  const before = await facts(), result = await run();
  await plugin.executeAgentAction(result.actions[0]);
  expect((await store.readTaskDb()).tasks.map(t => t.title)).toEqual([title]);
  await expect(plugin.executeAgentAction(result.actions[0])).rejects.toThrow();
  const undone = await plugin.executeAgentToolCall({id: "fictional-preview-undo", name: "undo_latest_operation", arguments: {}}, "撤销上一步");
  expect(undone.actions).toEqual([]); expect(await vault.bytes(store.taskDbPath())).toBe(before.db);
  expect(await vault.bytes(store.taskMirrorPath())).toBe(before.mirror);
  const ledger = JSON.parse((await ledgerBytes())!);
  expect(ledger.records.filter((r: any) => r.toolName === "create_task")).toEqual([expect.objectContaining({status: "reverted"})]);
  expect(ledger.records.some((r: any) => r.toolName === "undo_latest_operation" && r.status === "verified")).toBe(true);
});
it("retains explicit direct creation compatibility when no preview was requested", async () => {
  plugin.settings.ai.provider = "off";
  const directTitle = "合成直接创建";
  const result = await run("/todo " + directTitle);
  expect((await store.readTaskDb()).tasks.map(t => t.title)).toEqual([directTitle]); expect(result.actions).toEqual([]);
});

it.each(["大后天", "下周三", "下周末", "月底", "１２月５日", "十号"])("saves the requested date in an explicit offline task: %s", async day => {
  plugin.settings.ai.provider = "off";
  const date = normalizeJournalDate(day, todayString()), title = "虚构整理纸样";
  const result = await run(`/todo ${day} 10:30 ${title}`);
  expect(request).not.toHaveBeenCalled();
  expect(result.receipts).toHaveLength(1);
  expect((await store.readTaskDb()).tasks).toMatchObject([{title, date, time: "10:30"}]);
});

it("keeps the task database unchanged when an explicit offline month-day is impossible", async () => {
  plugin.settings.ai.provider = "off";
  const before = await facts();
  const result = await run("/todo 2月30日 虚构整理纸样");
  expect(result.receipts ?? []).toEqual([]);
  expect(await facts()).toEqual(before);
});

it.each([
  {plan:{date:"今天",endDate:"下周三",scheduleMode:"window",dueDate:"12月3日",dueTime:"17:30"},expected:{date:"2026-11-25",endDate:"2026-12-02",scheduleMode:"window",dueDate:"2026-12-03",dueTime:"17:30"}},
  {plan:{date:"",dueDate:"12月3日",dueTime:"17:30"},expected:{date:"",endDate:"",dueDate:"2026-12-03",dueTime:"17:30"}}
])("previews and confirms the same independent deadline without dropping period fields: $plan",async({plan,expected})=>{
  vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(new Date(2026,10,25,10));
  try{
    const before=await facts();calls=[tool("propose_task_plan",{tasks:[{title,...plan}],capacityAware:true},"fictional-deadline-preview-plan")];
    const result=await run("请新建合成临时任务，按明确的期间和独立硬截止先给确认卡，确认后再保存。");
    expect(result.actions).toHaveLength(1);expect(result.actions[0].content).toContain("必须截止2026-12-03 17:30");
    if(plan.endDate)expect(result.actions[0].content).toContain("2026-12-02");
    expect(await facts()).toEqual(before);await plugin.executeAgentAction(result.actions[0]);
    expect((await store.readTaskDb()).tasks).toMatchObject([{title,...expected}]);
    await expect(plugin.executeAgentAction(result.actions[0])).rejects.toThrow();expect((await store.readTaskDb()).tasks).toHaveLength(1);
    await plugin.executeAgentToolCall({id:"fictional-deadline-preview-undo",name:"undo_latest_operation",arguments:{}},"撤销上一步");
    expect(await vault.bytes(store.taskDbPath())).toBe(before.db);expect(await vault.bytes(store.taskMirrorPath())).toBe(before.mirror);
  }finally{vi.useRealTimers();}
});

for (const source of ["text", "voice"] as const) {
  it(`keeps the acceptance card's natural new-task request preview-only (${source})`, async () => {
    const text = "帮我新建一个测试任务，名字叫“听感验收小任务”，安排明天，希望下午三点前完成。先给我确认卡，不要直接保存。";
    const before = await facts();
    const result = await run(text, source);
    expect(bodies).toHaveLength(2);
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0].type).toBe("task_plan");
    expect(await facts()).toEqual(before);
  });
}

it('previews and confirms an explicit legacy start plus end without losing its hard deadline',async()=>{
  calls=[tool('propose_task_plan',{tasks:[{title,date:'2026-11-13',time:'09:00',endTime:'10:30',scheduleMode:'fixed',dueDate:'2026-11-14',dueTime:'17:30'}]})];
  const before=await facts(),result=await run();expect(result.actions).toHaveLength(1);expect(await facts()).toEqual(before);expect(result.actions[0].content).toContain('09:00');expect(result.actions[0].content).toContain('10:30');
  await plugin.executeAgentAction(result.actions[0]);expect((await store.readTaskDb()).tasks).toMatchObject([{title,date:'2026-11-13',time:'',startTime:'09:00',endTime:'10:30',dueDate:'2026-11-14',dueTime:'17:30'}]);
});

it.each([
  {name:'local timed shortcut',message:'明天下午3点提醒我交虚构报告 等我确认',offline:false,batch:false},
  {name:'model create tool',message:'请新增虚构橙盒整理，先给我确认卡再保存。',offline:false,batch:false},
  {name:'offline command',message:'/todo 今天 10:00 虚构离线报告 等我确认',offline:true,batch:false},
  {name:'daily task batch',message:'把虚构橙盒整理和虚构蓝盒归档都排在今天，先给我确认卡，等我确认后再保存。',offline:false,batch:true}
])('F1 holds every creation entry until a real card is approved: $name',async({message,offline,batch})=>{
  if(offline)plugin.settings.ai.provider='off';
  calls=batch?[tool('schedule_task_batch',{date:'今天',tasks:[{title:'虚构橙盒整理'},{title:'虚构蓝盒归档'}]})]:[tool('create_task',{title:'虚构橙盒整理',date:'今天'})];
  const before=await facts(),result=await run(message);expect(await facts(),JSON.stringify({reply:result.reply,actions:result.actions})).toEqual(before);expect(result.actions).toHaveLength(1);expect(['task_plan','tool_batch']).toContain(result.actions[0].type);expect(result.receipts??[]).toEqual([]);
  await plugin.executeAgentAction(result.actions[0]);const saved=(await store.readTaskDb()).tasks;expect(saved).toHaveLength(batch?2:1);const after=await facts();await plugin.executeAgentAction(result.actions[0]).catch(()=>undefined);expect(await vault.bytes(store.taskDbPath())).toBe(after.db);expect((await store.readTaskDb()).tasks).toEqual(saved);
});
it.each([
  '明天下午3点提醒我交虚构报告 算了不用',
  '明天下午3点提醒我开虚构会议 这只是举个例子'
])('F1 rejects cancelled or illustrative creation even when a model requests the write: %s',async message=>{
  calls=[tool('create_task',{title:'虚构不应保存的报告',date:'今天'})];const before=await facts(),result=await run(message);expect(await facts()).toEqual(before);expect(result.actions).toEqual([]);expect(result.receipts??[]).toEqual([]);
});
it.each([
  {message:'明天下午3:00提醒我给靛色纸样夹贴标签。',title:'给靛色纸样夹贴标签'},
  {message:'请创建任务，名称为「等我确认」，今天做。',title:'等我确认'}
])('F1 preserves authorized direct creation and quoted literal titles: $message',async({message,title})=>{
  calls=[tool('create_task',{title,date:'今天'})];const result=await run(message);expect((await store.readTaskDb()).tasks.map(row=>row.title)).toEqual([title]);expect(result.actions).toEqual([]);expect(result.receipts).toHaveLength(1);
});

it.each(['先给我确认卡再保存','等我同意后再建','先确认，暂时不要保存'])('F1 binds a creation-only card to one adjacent bare approval: %s',async suffix=>{
  calls=[tool('create_task',{title:'虚构相邻确认',date:'明天'})];
  const before=await facts(),result=await run(`请新建虚构相邻确认，${suffix}。`),action=result.actions[0];
  expect(await facts()).toEqual(before);expect(action?.type).toBe('tool_batch');
  const message={role:'assistant' as const,content:result.reply},view={agentMessages:[message],pendingAgentActions:[action]};
  armAdjacentTaskPlan(view,message,[action]);expect(consumeAdjacentTaskPlan(view,'确定')).toBe(action);
  expect(consumeAdjacentTaskPlan(view,'确定')).toBeUndefined();await plugin.executeAgentAction(action);
  expect((await store.readTaskDb()).tasks.map(t=>t.title)).toEqual(['虚构相邻确认']);
});

it.each(['create_task','schedule_task_batch'])('F1 guards the actual Runtime before ledger claim, even with a supplied confirmed flag: %s',async name=>{
  const runtime=new AgentRuntime({store,refreshViews:async()=>{}}),before=await facts();
  const result=await runtime.executeToolCall({toolName:name,arguments:name==='create_task'?{title:'虚构底层确认',date:'明天'}:{date:'明天',tasks:[{title:'虚构底层确认'}]},source:'kimi',callId:`fictional-flag-${name}`,userMessage:'创建虚构底层确认，等我确认再保存。',confirmedByUser:true});
  expect(result.success,result.output).toBe(true);expect(await facts()).toEqual(before);expect(result.actions).toHaveLength(1);
  await plugin.executeAgentAction(result.actions[0]);expect((await store.readTaskDb()).tasks).toHaveLength(1);
});

it('F1 groups separate model creation calls into one real card and deduplicates concurrent approvals',async()=>{
  calls=[tool('create_task',{title:'虚构整份甲',date:'明天'},'fictional-card-a'),tool('create_task',{title:'虚构整份乙',date:'明天'},'fictional-card-b')];
  const before=await facts(),result=await run('新建虚构整份甲和虚构整份乙，等我确认再保存。');expect(await facts()).toEqual(before);expect(result.actions).toHaveLength(1);
  const action=result.actions[0];expect(action.toolBatch).toHaveLength(2);await Promise.allSettled([plugin.executeAgentAction(action),plugin.executeAgentAction(action)]);
  expect((await store.readTaskDb()).tasks.map(t=>t.title)).toEqual(['虚构整份甲','虚构整份乙']);
});

it('F1 revokes the exact dismissed card and refuses a copied capability without touching facts',async()=>{
  calls=[tool('create_task',{title:'虚构取消确认',date:'明天'})];const before=await facts(),result=await run('创建虚构取消确认，先给确认卡。'),action=result.actions[0];
  await expect(plugin.executeAgentAction(structuredClone(action))).rejects.toThrow();
  const message={role:'assistant' as const,content:result.reply},view={agentMessages:[message],pendingAgentActions:[action]};
  armAdjacentTaskPlan(view,message,[action]);expect(consumeAdjacentTaskDecision(view,'取消')).toEqual({action,approved:false});
  plugin.dismissAgentAction(action);await expect(plugin.executeAgentAction(action)).rejects.toThrow('取消');expect(await facts()).toEqual(before);
});

it('F1 freezes relative dates before midnight, keeps the independent deadline and can undo the exact creation',async()=>{
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(2026,10,25,23,59));
  try{
    const before=await facts();calls=[tool('create_task',{title:'虚构跨夜核对',date:'明天',endDate:'下周三',scheduleMode:'window',dueDate:'12月3日',dueTime:'17:30'})];
    const result=await run('新建虚构跨夜核对，先给确认卡。'),action=result.actions[0];expect(await facts()).toEqual(before);
    expect(action.content).toContain('2026-12-03 17:30');vi.setSystemTime(new Date(2026,10,26,7));await plugin.executeAgentAction(action);
    expect((await store.readTaskDb()).tasks).toMatchObject([{date:'2026-11-26',endDate:'2026-12-02',dueDate:'2026-12-03',dueTime:'17:30'}]);
    await plugin.executeAgentToolCall({id:'fictional-crossnight-undo',name:'undo_latest_operation',arguments:{}},'撤销上一步');
    expect(await vault.bytes(store.taskDbPath())).toBe(before.db);expect(await vault.bytes(store.taskMirrorPath())).toBe(before.mirror);
  }finally{vi.useRealTimers();}
});

it.each([true,false])('F1 applies adjacent approval or cancellation to the actual persistent new-task plan: %s',async approved=>{
  const before=await facts(),result=await run(),action=result.actions[0];expect(action.type).toBe('task_plan');
  const message={role:'assistant' as const,content:result.reply},view={agentMessages:[message],pendingAgentActions:[action]};
  armAdjacentTaskPlan(view,message,[action]);expect(consumeAdjacentTaskDecision(view,approved?'确定':'取消')).toEqual({action,approved});
  if(approved){await plugin.executeAgentAction(action);expect((await store.readTaskDb()).tasks.map(t=>t.title)).toEqual([title]);}
  else{plugin.dismissAgentAction(action);await expect(plugin.executeAgentAction(action)).rejects.toThrow();expect(await facts()).toEqual(before);}
});

it.each(['假如我明天建虚构练习，等我确认。','请不要创建虚构练习。','虚构练习，先给确认卡，算了取消。'])('F1 does not turn negative examples into executable cards: %s',async message=>{
  calls=[tool('create_task',{title:'虚构练习'})];const before=await facts(),result=await run(message);expect(await facts()).toEqual(before);expect(result.actions).toEqual([]);
});
it.each([{message:'不用等我确认，直接创建虚构纸盒。',title:'虚构纸盒'},{message:'创建任务「取消订阅」，今天做。',title:'取消订阅'},{message:'不用给我确认卡，直接创建虚构纸盒。',title:'虚构纸盒'},{message:'创建任务「制作确认卡」，今天做。',title:'制作确认卡'}])('F1 preserves explicit no-wait creation: $message',async({message,title})=>{
  calls=[tool('create_task',{title,date:'今天'})];const result=await run(message);expect(result.actions).toEqual([]);expect((await store.readTaskDb()).tasks.map(t=>t.title)).toEqual([title]);
});

it('F1 does not mistake 分别保存 for 别保存 in a legitimate period creation',async()=>{
  calls=[tool('create_task',{title:'虚构银杏跨月整理',date:'2026-11-25',endDate:'2026-12-02',scheduleMode:'window',dueDate:'2026-12-03',dueTime:'17:30'})];
  const result=await run('请直接新建并保存「虚构银杏跨月整理」：可从2026年11月25日开始，到12月2日期间分次完成，不排每天固定工作时段。另有独立交付期限，必须在2026年12月3日17:30前完成。计划完成和必须截止分别保存，不用再问。');
  expect(result.actions).toEqual([]);expect(result.receipts).toHaveLength(1);expect((await store.readTaskDb()).tasks).toMatchObject([{title:'虚构银杏跨月整理',date:'2026-11-25',endDate:'2026-12-02',dueDate:'2026-12-03',dueTime:'17:30'}]);
});
it.each(['别创建虚构纸盒。','请你别保存虚构纸盒。','这次先别创建虚构纸盒。'])('F1 preserves actual negative imperatives: %s',async message=>{
  calls=[tool('create_task',{title:'虚构纸盒'})];const before=await facts(),result=await run(message);expect(await facts()).toEqual(before);expect(result.actions).toEqual([]);
});
