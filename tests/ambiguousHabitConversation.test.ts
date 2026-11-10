import { stubAgentModel } from "./helpers/stubAgentModel";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import type {App} from "obsidian";
import {DEFAULT_SETTINGS} from "../src/defaults";
import type {StoreHost} from "../src/store/settingsSlice";
vi.mock("obsidian",()=>({App:class{},Plugin:class{},TFile:class{},TFolder:class{},WorkspaceLeaf:class{},ItemView:class{},Modal:class{},PluginSettingTab:class{},Setting:class{},Platform:{isDesktopApp:true},Notice:class{},normalizePath:(p:string)=>p.replace(/\\/g,"/").replace(/\/{2,}/g,"/"),setIcon:vi.fn(),requestUrl:vi.fn(()=>{throw Error("Network forbidden");})}));
const {default:LifeOpsPlugin}=await import("../src/main");
const {LifeOpsStore}=await import("../src/store"),{DiskVault}=await import("./helpers/diskVault");
let root:string,vault:InstanceType<typeof DiskVault>,store:StoreHost,plugin:any,journalPath:string,firstId:string,otherId:string;
const manual="纯虚构手写日记，保留原段落。\n\n## 手写复盘\n纯虚构原亲写复盘。\n",date="2026-10-07",fullName="纯虚构散步20261007";
beforeEach(async()=>{
  vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(new Date(2026,9,7,12));vi.stubGlobal("window",globalThis);
  root=await mkdtemp(join(tmpdir(),"lifeops-ambiguous-habit-main-"));vault=new DiskVault(root);const app={vault,workspace:{getLeavesOfType:vi.fn(()=>[])}} as unknown as App;
  store=new LifeOpsStore(app,structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;await store.initializeVault();journalPath=store.dailyNotePath(date,"晚");await vault.seed(journalPath,manual);
  firstId=(await store.createHabit({name:fullName,frequencyUnit:"day",frequencyInterval:1,targetCount:1})).id;otherId=(await store.createHabit({name:fullName+"进阶",frequencyUnit:"day",frequencyInterval:1,targetCount:1})).id;
  plugin=Object.assign(Object.create(LifeOpsPlugin.prototype),{app,store,settings:store.settings,lifecycleGeneration:1,unloaded:false,updateStatusBar:vi.fn(async()=>{}),refreshViews:vi.fn(async()=>{}),lifeOpsEvents:{publish:vi.fn()},buildSemanticContext:vi.fn(async()=>""),tryLocalAgentFallback:vi.fn(async()=>null)});
});
afterEach(async()=>{vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();await rm(root,{recursive:true,force:true});});
async function submit(ref:string,source:"text"|"voice"){
  const firstModel=vi.fn(async()=>({content:"",toolCalls:[{id:"fiction-habit",name:"complete_habit",arguments:{name:ref}},{id:"fiction-journal",name:"append_journal_entry",arguments:{date,period:"晚",heading:"手写复盘",content:"纯虚构独立日记追加。"}}]}));
  stubAgentModel(plugin, firstModel);
  const response=await plugin.submitAgentMessage(`请把习惯${ref}标记为已完成，并把以下内容写入今天晚间日记的手写复盘：纯虚构独立日记追加。`,[],{source,selfTest:true});expect(firstModel).toHaveBeenCalledOnce();expect(response.actions).toEqual([]);return response;
}
describe("ambiguous habit and independent diary through real Main and actual disk",()=>{
  it.each(["text","voice"] as const)("does not write either similar habit, but saves and undoes the authorized diary: %s",async source=>{
    const habitBefore=await vault.bytes(store.habitDbPath());const response=await submit("纯虚构散步",source);expect(response.reply).toContain("多个可能的习惯");
    const fresh=new LifeOpsStore(plugin.app,plugin.settings) as unknown as StoreHost;expect(await vault.bytes(fresh.habitDbPath())).toBe(habitBefore);expect(await fresh.readPath(journalPath)).toContain(manual);expect(await fresh.readPath(journalPath)).toContain("纯虚构独立日记追加。");
    await plugin.undoLatestLifeOpsOperation();expect(await vault.bytes(journalPath)).toBe(manual);expect(await vault.bytes(fresh.habitDbPath())).toBe(habitBefore);
  });
  it("allows the unique exact full habit and retains separate diary/habit undo",async()=>{
    const habitBefore=await vault.bytes(store.habitDbPath());const response=await submit(fullName,"text");expect(response.reply).toContain(`已完成今日打卡：${fullName}`);let database=await store.readHabitDb();expect(database.checkins.some(c=>c.habitId===firstId&&c.status==="done")).toBe(true);expect(database.checkins.some(c=>c.habitId===otherId)).toBe(false);
    await plugin.undoLatestLifeOpsOperation();expect(await vault.bytes(journalPath)).toBe(manual);expect((await store.readHabitDb()).checkins.some(c=>c.habitId===firstId&&c.status==="done")).toBe(true);
    await plugin.undoLatestLifeOpsOperation();expect(await vault.bytes(store.habitDbPath())).toBe(habitBefore);
  });
});
