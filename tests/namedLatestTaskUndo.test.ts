import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {beforeEach,afterEach,it,expect,vi} from "vitest";
import type {App} from "obsidian";
import {DEFAULT_SETTINGS} from "../src/defaults";
import {AgentRuntime} from "../src/agentRuntime";
import {OperationLedger,type OperationLedgerDocument} from "../src/dataFoundation/operationLedger";
import type {StoreHost} from "../src/store/settingsSlice";
vi.mock("obsidian",()=>({App:class{},Plugin:class{},TFile:class{},TFolder:class{},WorkspaceLeaf:class{},ItemView:class{},Modal:class{},PluginSettingTab:class{},Setting:class{},Platform:{isDesktopApp:true},Notice:class{},normalizePath:(p:string)=>p.replace(/\\/g,"/").replace(/\/{2,}/g,"/"),setIcon:vi.fn(),requestUrl:()=>{throw Error("Offline test");}}));
const {LifeOpsStore}=await import("../src/store");
const {DiskVault}=await import("./helpers/diskVault");
let root:string,vault:InstanceType<typeof DiskVault>,store:StoreHost,runtime:AgentRuntime;
beforeEach(async()=>{root=await mkdtemp(join(tmpdir(),"lifeops-named-undo-"));vault=new DiskVault(root);store=new LifeOpsStore({vault}as unknown as App,structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;await store.initializeVault();runtime=new AgentRuntime({store,refreshViews:async()=>{}});});
afterEach(async()=>{vi.restoreAllMocks();await rm(root,{recursive:true,force:true});});
const ledgerDocument=async():Promise<OperationLedgerDocument>=>JSON.parse((await store.readPath(new OperationLedger(store).filePath))!);
const create=(title:string,id:string)=>runtime.executeAiToolCall({id,name:"create_task",arguments:{title}},"kimi","请创建任务："+title);
const undo=(message:string,id="undo-named",arguments_:Record<string,unknown>={})=>runtime.executeAiToolCall({id,name:"undo_latest_operation",arguments:arguments_},"kimi",message);
it.each(['任务','那一条任务','那个任务','这条任务'])("treats %s as the latest task creation rather than a literal title",async reference=>{
 const before=await vault.bytes(store.taskDbPath());await create('纯虚构需要撤销的资料整理','deictic-created');
 const result=await undo('撤销刚才创建的'+reference+'。','undo-named',{creationOnly:true});expect(result.success,result.output).toBe(true);expect(await vault.bytes(store.taskDbPath())).toBe(before);
 expect((await ledgerDocument()).records.find(r=>r.operationId==='deictic-created')?.status).toBe('reverted');
});
it.each(['任务','那个任务'])('does not turn a latest creation reference (%s) into Undo of a different kind of latest operation',async reference=>{
 await create('纯虚构任务','deictic-created');await runtime.executeAiToolCall({id:'deictic-completed',name:'complete_task',arguments:{taskIdOrTitle:'纯虚构任务'}},'kimi','纯虚构任务已经完成');
 const before=await vault.bytes(store.taskDbPath()),result=await undo('撤销刚才创建的'+reference+'。','deictic-wrong-kind',{creationOnly:true});
 expect(result.success).toBe(false);expect(await vault.bytes(store.taskDbPath())).toBe(before);expect((await new OperationLedger(store).latestReversible())?.operationId).toBe('deictic-completed');
});
it('does not reuse a cached deictic creation Undo for a later task',async()=>{
 await create('纯虚构第一条任务','deictic-a');expect((await undo('撤销刚才创建的那个任务。','deictic-reused',{creationOnly:true})).success).toBe(true);
 await create('纯虚构第二条任务','deictic-b');const before=await vault.bytes(store.taskDbPath()),ledger=await ledgerDocument();
 const result=await undo('撤销刚才创建的那个任务。','deictic-reused',{creationOnly:true});expect(result.success).toBe(false);expect(await vault.bytes(store.taskDbPath())).toBe(before);expect(await ledgerDocument()).toEqual(ledger);
});
it('rechecks the latest operation inside the Fact transaction for a deictic creation Undo',async()=>{
 await create('纯虚构此前创建任务','deictic-created');const before=await vault.bytes(store.taskDbPath()),actual=store.runFactOperation!.bind(store);let inserted=false;
 vi.spyOn(store,'runFactOperation').mockImplementation(async(...args:any[])=>{
  if(args[0].operationId==='undo:deictic-created'&&!inserted){inserted=true;const later=await runtime.executeAiToolCall({id:'deictic-later-habit',name:'create_habit',arguments:{name:'纯虚构后来习惯',frequencyUnit:'day',targetCount:1}},'kimi','请创建习惯：纯虚构后来习惯');expect(later.success,later.output).toBe(true);}
  return (actual as any)(...args);
 });
 const result=await undo('撤销刚才创建的那个任务。','deictic-raced',{creationOnly:true});expect(inserted).toBe(true);expect(result.success).toBe(false);
 expect(await vault.bytes(store.taskDbPath())).toBe(before);expect((await new OperationLedger(store).latestReversible())?.operationId).toBe('deictic-later-habit');
});
it("runs the original frozen T05 request through real disk Undo",async()=>{const before=await vault.bytes(store.taskDbPath());expect((await create("合成临时任务","create-a")).success).toBe(true);const result=await undo("请撤销刚才创建的合成临时任务。","undo-named",{taskTitle:"合成临时任务"});expect(result.success,result.output).toBe(true);expect(await vault.bytes(store.taskDbPath())).toBe(before);expect((await ledgerDocument()).records.find(r=>r.operationId==="create-a")?.status).toBe("reverted");});
it("does not undo another latest title or select an older matching record",async()=>{await create("合成临时任务","create-a");await create("别的任务","create-b");const before=await vault.bytes(store.taskDbPath()),result=await undo("请撤销刚才创建的合成临时任务。","undo-named",{taskTitle:"合成临时任务"});expect(result.success).toBe(false);expect(await vault.bytes(store.taskDbPath())).toBe(before);expect((await new OperationLedger(store).latestReversible())?.operationId).toBe("create-b");});
it("rejects a same-title completion instead of treating it as creation",async()=>{await create("合成临时任务","create-a");expect((await runtime.executeAiToolCall({id:"complete-a",name:"complete_task",arguments:{taskIdOrTitle:"合成临时任务"}},"kimi","合成临时任务已经完成")).success).toBe(true);const before=await vault.bytes(store.taskDbPath());expect((await undo("请撤销刚才创建的合成临时任务。","undo-named",{taskTitle:"合成临时任务"})).success).toBe(false);expect(await vault.bytes(store.taskDbPath())).toBe(before);});
it.each(["合成临时任务","别的任务"]) ("does not reuse a cached named Undo success for %s",async title=>{await create("合成临时任务","create-a");expect((await undo("请撤销刚才创建的合成临时任务。","shared-undo-id",{taskTitle:"合成临时任务"})).success).toBe(true);await create("别的任务","create-b");const before=await vault.bytes(store.taskDbPath()),ledger=await ledgerDocument();const result=await undo("请撤销刚才创建的"+title+"。","shared-undo-id",{taskTitle:title});expect(result.success).toBe(false);expect(result.output).toMatch(/已有撤销回执|调用 ID 冲突/);expect(await vault.bytes(store.taskDbPath())).toBe(before);expect(await ledgerDocument()).toEqual(ledger);});
