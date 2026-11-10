import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import type { App } from "obsidian";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { AgentRuntime } from "../src/agentRuntime";
import { todayString, addDays } from "../src/date";
import type { StoreHost } from "../src/store/settingsSlice";
vi.mock("obsidian", () => ({ App: class {}, Plugin: class {}, TFile: class {}, TFolder: class {}, WorkspaceLeaf: class {}, ItemView: class {}, Modal: class {}, PluginSettingTab: class {}, Setting: class {}, Platform: { isDesktopApp: true }, Notice: class {}, normalizePath: (p: string) => p.replace(/\\/g,"/").replace(/\/{2,}/g,"/"), setIcon: vi.fn(), requestUrl: () => { throw Error("Offline evaluation"); } }));
const { LifeOpsStore } = await import("../src/store");
const { default: LifeOpsPlugin } = await import("../src/main");
const { DiskVault } = await import("./helpers/diskVault");
let root: string, vault: InstanceType<typeof DiskVault>, store: StoreHost, runtime: AgentRuntime, plugin: any;
let serial = 0;
beforeEach(async () => {
  vi.stubGlobal("window", globalThis);
  root = await mkdtemp(join(tmpdir(), "lifeops-five-domain-")); vault = new DiskVault(root);
  const app = { vault, workspace: { getLeavesOfType: () => [] } } as unknown as App;
  store = new LifeOpsStore(app, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;
  await store.initializeVault();
  plugin = Object.assign(Object.create(LifeOpsPlugin.prototype), { app, store, settings: store.settings, refreshViews: async () => {}, updateStatusBar: async () => {}, lifeOpsEvents: { publish: () => {} } });
  runtime = new AgentRuntime({ store, refreshViews: async () => {} }); serial = 0;
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }); });
const call = (name: string, args: Record<string, unknown>, user: string, id = `eval-${++serial}`) => runtime.executeToolCall({ callId: id, toolName: name, arguments: args, source: "kimi", userMessage: user });
const tasks = () => store.readTaskDb();
const habits = () => store.readHabitDb();
const createTask = (title="合成核对") => call("create_task", {title,date:todayString()}, `请创建任务：${title}`);
const createHabit = (name="合成散步") => call("create_habit", {name,frequencyUnit:"day",targetCount:1}, `请创建习惯：${name}`);
const query = (args: Record<string,unknown>) => call("query_vault", args, "只查询原文，不修改");
async function seedMemory() {
  const path = store.path(store.settings.folders.ideas,"偏好来源.md"); await vault.seed(path,"合成偏好：先列依据。");
  const m = await store.upsertPersonalMemory({kind:"user_rule",content:"合成偏好：先列依据。",sourceRefs:[{sourceId:"eval-source",path,capturedAt:new Date().toISOString()}]});
  return {m,path};
}
async function review(id: string, decision: string, correctedContent?: string) {
  return call("review_personal_memory",{memoryId:id,decision,correctedContent},"请审查这条个人记忆");
}

// 50 fixed domain scenarios: task12 / habit10 / journal10 / knowledge10 / memory8, plus an injected disk failure.
// Tool calls are deliberately supplied offline; these prove execution and persistence,
// not real-model tool selection. Each scenario gets its own temporary vault.
describe("EVAL-02 fixed five-domain disk execution", () => {
  describe("task — 12", () => {
    it.each(["合成核对","中文 带空格","引号“任务”"])("TASK-create: %s", async title => { expect((await createTask(title)).success).toBe(true); expect((await tasks()).tasks.map(t=>t.title)).toEqual([title]); });
    it("TASK-relative-date",async()=>{expect((await call("create_task",{title:"合成明日",date:"明天"},"请创建明天的任务：合成明日")).success).toBe(true);expect((await tasks()).tasks[0].date).toBe(addDays(todayString(),1));});
    it("TASK-idempotent-retry",async()=>{const args={title:"合成唯一"};await call("create_task",args,"请创建任务：合成唯一","same");await call("create_task",args,"请创建任务：合成唯一","same");expect((await tasks()).tasks).toHaveLength(1);});
    it("TASK-complete-readback",async()=>{await createTask();expect((await call("complete_task",{taskIdOrTitle:"合成核对"},"合成核对任务已经完成")).success).toBe(true);expect((await tasks()).tasks[0].status).toBe("completed");});
    it("TASK-missing-does-not-invent",async()=>{const before=await vault.bytes(store.taskDbPath());expect((await call("complete_task",{taskIdOrTitle:"不存在"},"不存在任务已经完成")).success).toBe(false);expect(await vault.bytes(store.taskDbPath())).toBe(before);});
    it("TASK-delete-confirmation",async()=>{await createTask();const before=await vault.bytes(store.taskDbPath());const r=await call("delete_task",{taskIdOrTitle:"合成核对"},"请删除合成核对");expect(r.actions).toHaveLength(1);expect(await vault.bytes(store.taskDbPath())).toBe(before);await plugin.executeAgentAction(r.actions[0]);expect((await tasks()).tasks).toHaveLength(0);});
    it("TASK-pending-card-zero-write",async()=>{await createTask();const before=await vault.bytes(store.taskDbPath());await call("delete_task",{taskIdOrTitle:"合成核对"},"请删除合成核对");expect(await vault.bytes(store.taskDbPath())).toBe(before);});
    it("TASK-undo-restores",async()=>{const before=await vault.bytes(store.taskDbPath());const r=await createTask();await runtime.undoOperation(r.callId);expect(await vault.bytes(store.taskDbPath())).toBe(before);});
    it("TASK-undo-conflict-preserves-later-edit",async()=>{const r=await createTask();await store.createTask({title:"后来人工新增"});const later=await vault.bytes(store.taskDbPath());await expect(runtime.undoOperation(r.callId)).rejects.toThrow();expect(await vault.bytes(store.taskDbPath())).toBe(later);});
  });
  it("RECOVERY-disk-failure-safe-retry-and-undo", async () => {
    const paths = [store.taskDbPath(), store.taskMirrorPath()];
    const before = await Promise.all(paths.map(p => store.readPath(p)));
    let injected = false;
    for (const method of ["process", "modify"] as const) {
      const original = vault[method].bind(vault) as (...args: any[]) => Promise<any>;
      vi.spyOn(vault, method).mockImplementation((async (...args: any[]) => {
        if (!injected && args[0].path === store.taskDbPath()) { injected = true; throw Error("synthetic disk write failure"); }
        return original(...args);
      }) as any);
    }
    const args = { title: "合成重试任务" };
    const failed = await call("create_task", args, "请创建任务：合成重试任务", "disk-fault");
    expect(injected).toBe(true); expect(failed.success).toBe(false);
    expect(await Promise.all(paths.map(p => store.readPath(p)))).toEqual(before);
    const retry = await call("create_task", args, "请创建任务：合成重试任务", "disk-fault");
    expect(retry.success).toBe(true); expect((await tasks()).tasks).toHaveLength(1);
    await runtime.undoOperation(retry.callId);
    expect(await Promise.all(paths.map(p => store.readPath(p)))).toEqual(before);
  });
  describe("habit — 10",()=>{
    it.each(["day","week"])("HABIT-create-%s",async frequencyUnit=>{expect((await call("create_habit",{name:"合成阅读",frequencyUnit,targetCount:2},"请创建阅读习惯")).success).toBe(true);const h=(await habits()).habits[0];expect(h.name).toBe("合成阅读");expect(h.frequencyUnit).toBe(frequencyUnit);expect(h.targetCount).toBe(2);});
    it("HABIT-idempotent",async()=>{await call("create_habit",{name:"合成散步"},"请创建散步习惯","same");await call("create_habit",{name:"合成散步"},"请创建散步习惯","same");expect((await habits()).habits).toHaveLength(1);});
    it("HABIT-complete",async()=>{await createHabit();expect((await call("complete_habit",{name:"合成散步"},"合成散步已经完成")).success).toBe(true);expect((await habits()).checkins[0].status).toBe("done");});
    it("HABIT-missed",async()=>{await createHabit();expect((await call("miss_habit",{name:"合成散步",reason:"需要休息"},"请把合成散步习惯标记为未完成")).success).toBe(true);expect((await habits()).checkins[0].status).toBe("missed");});
    it("HABIT-missing",async()=>{expect((await call("complete_habit",{name:"不存在"},"不存在习惯已经完成")).success).toBe(false);expect((await habits()).checkins).toHaveLength(0);});
    it("HABIT-undo-checkin",async()=>{await createHabit();const before=await vault.bytes(store.habitDbPath());const r=await call("complete_habit",{name:"合成散步"},"合成散步已经完成");await runtime.undoOperation(r.callId);expect(await vault.bytes(store.habitDbPath())).toBe(before);});
    it("HABIT-undo-conflict",async()=>{const r=await createHabit();await store.createHabit({name:"后来人工新增",frequencyUnit:"day",frequencyInterval:1,targetCount:1});const later=await vault.bytes(store.habitDbPath());await expect(runtime.undoOperation(r.callId)).rejects.toThrow();expect(await vault.bytes(store.habitDbPath())).toBe(later);});
  });
  describe("journal — 10",()=>{
    it.each(["早","晚"] as const)("JOURNAL-save-%s-and-query",async period=>{const text="核对三项，还剩两项。讨论取消了。";const r=await call("append_journal_entry",{content:text,period,date:todayString()},`请保存${period==="早"?"晨间":"晚间"}日记：${text}`);expect(r.success).toBe(true);const q=await query({domain:"journal",operation:"get",date:todayString(),period});expect(q.output).toContain(text);expect(q.output).toContain(store.dailyNotePath(todayString(),period));});
    it("JOURNAL-yesterday",async()=>{const r=await call("append_journal_entry",{content:"合成补记",period:"晚",date:"昨天"},"请补记昨晚日记：合成补记");expect(r.success).toBe(true);expect(await store.readPath(store.dailyNotePath(addDays(todayString(),-1),"晚"))).toContain("合成补记");});
    it("JOURNAL-period-exact",async()=>{await vault.seed(store.dailyNotePath(todayString(),"早"),"早间计划");await vault.seed(store.dailyNotePath(todayString(),"晚"),"晚间实际");const q=await query({domain:"journal",operation:"get",date:todayString(),period:"晚"});expect(q.output).toContain("晚间实际");expect(q.output).not.toContain("早间计划");});
    it("JOURNAL-invalid-date",async()=>{expect((await call("append_journal_entry",{content:"不能落错日期",period:"晚",date:"2026-02-30"},"请保存晚间日记：不能落错日期")).success).toBe(false);});
    it("JOURNAL-empty-content",async()=>{expect((await call("append_journal_entry",{content:" ",period:"晚"},"请保存晚间日记")).success).toBe(false);});
    it("JOURNAL-idempotent-retry",async()=>{const args={content:"合成唯一日记段",period:"晚"};await call("append_journal_entry",args,"请保存晚间日记：合成唯一日记段","same");await call("append_journal_entry",args,"请保存晚间日记：合成唯一日记段","same");expect((await store.readPath(store.dailyNotePath(todayString(),"晚"))).split("合成唯一日记段")).toHaveLength(2);});
    it("JOURNAL-undo-preserves-original",async()=>{const p=store.dailyNotePath(todayString(),"晚");await vault.seed(p,"原始亲写段落");const r=await call("append_journal_entry",{content:"追加合成",period:"晚"},"请保存晚间日记：追加合成");await runtime.undoOperation(r.callId);expect(await vault.bytes(p)).toBe("原始亲写段落");});
    it("JOURNAL-undo-conflict",async()=>{const p=store.dailyNotePath(todayString(),"晚");const r=await call("append_journal_entry",{content:"合成段落",period:"晚"},"请保存晚间日记：合成段落");await vault.seed(p,"后来手写版本");await expect(runtime.undoOperation(r.callId)).rejects.toThrow();expect(await vault.bytes(p)).toBe("后来手写版本");});
  });
  describe("knowledge — 10",()=>{
    it("KNOWLEDGE-write-and-exact-read",async()=>{const r=await call("append_knowledge_note",{content:"合成知识：先核对证据再下结论。"},"请把这条保存到知识库：合成知识：先核对证据再下结论。");expect(r.success).toBe(true);const q=await query({domain:"note",operation:"search",query:"先核对证据再下结论"});expect(q.output).toContain("先核对证据再下结论");});
    it("KNOWLEDGE-body-search",async()=>{const p=store.path(store.settings.folders.ideas,"中性标题.md");await vault.seed(p,"正文独有琥珀词");const q=await query({domain:"note",operation:"search",query:"琥珀词"});expect(q.output).toContain(p);expect(q.output).toContain("琥珀词");});
    it("KNOWLEDGE-exact-not-nearby",async()=>{const p=store.path(store.settings.folders.ideas,"同名.md");await vault.seed(p,"准确来源");await vault.seed(store.path(store.settings.folders.ideas,"同名副本.md"),"不能替代");const q=await query({domain:"note",operation:"get",path:p});expect(q.output).toContain("准确来源");expect(q.output).not.toContain("不能替代");});
    it("KNOWLEDGE-missing-path-no-fallback",async()=>{await vault.seed(store.path(store.settings.folders.ideas,"近似.md"),"不可替代原文");const q=await query({domain:"note",operation:"get",path:store.path(store.settings.folders.ideas,"不存在.md")});expect(q.output).not.toContain("不可替代原文");});
    it("KNOWLEDGE-empty-path-content",async()=>{const p=store.path(store.settings.folders.ideas,"空白.md");await vault.seed(p,"");const q=await query({domain:"note",operation:"get",path:p});expect(q.output).toContain(p);expect(q.output).not.toContain("undefined");});
    it("KNOWLEDGE-private-source-excluded",async()=>{const p=store.path(store.settings.folders.ideas,"隐私/原文.md");await vault.seed(p,"保密合成内容");store.settings.privacy!.excludedVaultPrefixes=[store.path(store.settings.folders.ideas,"隐私")];const q=await query({domain:"note",operation:"get",path:p});expect(q.output).not.toContain("保密合成内容");});
    it("KNOWLEDGE-unsafe-path-excluded",async()=>{const q=await query({domain:"note",operation:"get",path:"../outside.md"});expect(q.success).toBe(false);});
    it("KNOWLEDGE-write-undo",async()=>{const r=await call("append_knowledge_note",{content:"唯一可撤销知识"},"请保存到知识库：唯一可撤销知识");expect(r.success).toBe(true);await runtime.undoOperation(r.callId);const q=await query({domain:"note",operation:"search",query:"唯一可撤销知识"});expect(q.output).toContain("没有找到");expect(q.output).not.toContain("- source:");});
  });
  describe("personal memory — 8",()=>{
    it("MEMORY-direct-create-and-undo",async()=>{const before=await vault.bytes(store.personalMemoryPath());const r=await call("append_memory_note",{content:"合成偏好"},"请记住这个偏好");expect(r.actions).toEqual([]);expect(r.receipt).toBeDefined();expect(await vault.bytes(store.personalMemoryPath())).not.toBe(before);await runtime.undoOperation(r.receipt!.operationId);expect(await vault.bytes(store.personalMemoryPath())).toBe(before);});
    it("MEMORY-candidate-not-active",async()=>{await seedMemory();const q=await query({domain:"memory",operation:"get"});expect(q.output).not.toContain("合成偏好：先列依据。");});
    it("MEMORY-confirm-persistence",async()=>{const {m}=await seedMemory();const r=await review(m.id,"confirm");await plugin.executeAgentAction(r.actions[0]);expect((await store.readPersonalMemories()).records.find(x=>x.id===m.id)?.status).toBe("active");expect((await query({domain:"memory",operation:"get"})).output).toContain(m.content);});
    it("MEMORY-correction-pending",async()=>{const {m}=await seedMemory();await store.reviewPersonalMemory(m.id,{decision:"confirm"});const before=await vault.bytes(store.personalMemoryPath());const r=await review(m.id,"correct","合成偏好：改为先给结论。");expect(await vault.bytes(store.personalMemoryPath())).toBe(before);await plugin.executeAgentAction(r.actions[0]);const q=await query({domain:"memory",operation:"get"});expect(q.output).toContain("改为先给结论");expect(q.output).not.toContain("先列依据");});
    it("MEMORY-forget-reprocess-no-revival",async()=>{const {m,path}=await seedMemory();await store.reviewPersonalMemory(m.id,{decision:"confirm"});const r=await review(m.id,"forget");await plugin.executeAgentAction(r.actions[0]);await store.upsertPersonalMemory({kind:"user_rule",content:m.content,sourceRefs:m.sourceRefs});expect((await query({domain:"memory",operation:"get"})).output).not.toContain(m.content);expect(await vault.bytes(path)).toBe(m.content);});
    it("MEMORY-missing-source-not-authority",async()=>{const {m,path}=await seedMemory();await store.reviewPersonalMemory(m.id,{decision:"confirm"});await vault.delete(store.getFile(path)!);expect((await query({domain:"memory",operation:"get"})).output).not.toContain(m.content);});
    it("MEMORY-unknown-id-zero-write",async()=>{const before=await vault.bytes(store.personalMemoryPath());expect((await review("absent","confirm")).success).toBe(false);expect(await vault.bytes(store.personalMemoryPath())).toBe(before);});
    it("MEMORY-stale-confirmation-refused",async()=>{const {m}=await seedMemory();const r=await review(m.id,"confirm");await store.reviewPersonalMemory(m.id,{decision:"correct",content:"后续人工纠正"});const after=await vault.bytes(store.personalMemoryPath());await expect(plugin.executeAgentAction(r.actions[0])).rejects.toThrow();expect(await vault.bytes(store.personalMemoryPath())).toBe(after);});
  });
});
