import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import type {App} from 'obsidian';import {DEFAULT_SETTINGS} from '../src/defaults';
vi.mock('obsidian',()=>({App:class{},Plugin:class{},TFile:class{},TFolder:class{},WorkspaceLeaf:class{},ItemView:class{},Modal:class{},PluginSettingTab:class{},Setting:class{},Platform:{isDesktopApp:true},Notice:class{},normalizePath:(p:string)=>p.replace(/\\/g,'/').replace(/\/{2,}/g,'/'),setIcon:vi.fn(),requestUrl:()=>{throw Error('Offline regression');}}));
const {LifeOpsStore}=await import('../src/store'),{DiskVault}=await import('./helpers/diskVault'),{default:Plugin}=await import('../src/main');
const observed={message:"请把个人记忆fixture-memory改为：合成沟通偏好：先说结果。",observedArguments:{memoryId:"fixture-memory"},expectedContent:"合成沟通偏好：先说结果。"};
let root:string,vault:InstanceType<typeof DiskVault>,store:any,plugin:any,memoryId:string,message:string,before:string;
beforeEach(async()=>{
 vi.stubGlobal('window',globalThis);root=await mkdtemp(join(tmpdir(),'lifeops-exact-memory-'));vault=new DiskVault(root);
 const app={vault,workspace:{getLeavesOfType:()=>[]}} as unknown as App;store=new LifeOpsStore(app,structuredClone(DEFAULT_SETTINGS));await store.initializeVault();
 const source=store.path(store.settings.folders.ideas,'合成沟通偏好.md');await vault.seed(source,'合成沟通偏好：先列依据。');
 const record=await store.upsertPersonalMemory({kind:'user_rule',content:'合成沟通偏好：先列依据。',sourceRefs:[{sourceId:'synthetic-exact-memory',path:source,capturedAt:new Date().toISOString()}]});memoryId=record.id;await store.reviewPersonalMemory(memoryId,{decision:'confirm'});
 plugin=Object.assign(Object.create(Plugin.prototype),{app,store,settings:store.settings,lifecycleGeneration:1,unloaded:false,updateStatusBar:async()=>{},lifeOpsEvents:{publish:()=>{}}});await plugin.refreshViews();
 message=observed.message.replace(observed.observedArguments.memoryId,memoryId);before=await vault.bytes(store.personalMemoryPath());
});
afterEach(async()=>{if(plugin){plugin.unloaded=true;clearTimeout(plugin.personalMemoryExpiryTimer);clearTimeout(plugin.personalMemorySourceRefreshTimer);}vi.restoreAllMocks();vi.unstubAllGlobals();await rm(root,{recursive:true,force:true});});
const prepare=(args:Record<string,unknown>,text=message)=>plugin.executeAgentToolCall({id:'synthetic-exact-correction',name:'review_personal_memory',arguments:args},text);
const exact=()=>({memoryId,decision:'correct',correctedContent:observed.expectedContent});
it('shows exact correction text without saving, then confirms once, reads from a fresh Store and undoes normally',async()=>{
 const result=await prepare(exact());expect(result.reply).toContain("确认卡");expect(result.actions).toHaveLength(1);const action=result.actions[0];expect(action.correctedMemoryContent).toBe(observed.expectedContent);expect(await vault.bytes(store.personalMemoryPath())).toBe(before);
 await plugin.executeAgentAction(action);await plugin.executeAgentAction(action);
 const fresh=new LifeOpsStore(plugin.app,structuredClone(store.settings));expect((await fresh.readPersonalMemories()).records.find((r:any)=>r.id===memoryId)?.content).toBe(observed.expectedContent);
 const undo=await plugin.executeAgentToolCall({id:'synthetic-undo-correction',name:'undo_latest_operation',arguments:{}},'请撤销最近一次更正。');expect(undo.reply).toContain("已撤销");expect((await fresh.readPersonalMemories()).records.find((r:any)=>r.id===memoryId)?.content).toBe('合成沟通偏好：先列依据。');
});
it('preserves the existing system/form preparation when no user sentence is supplied',async()=>{
 const result=await prepare({...exact(),correctedContent:'表单中已核对的合成更正。'},'');expect(result.reply).toContain("确认卡");expect(result.actions[0].correctedMemoryContent).toBe('表单中已核对的合成更正。');expect(await vault.bytes(store.personalMemoryPath())).toBe(before);
});
it('keeps internal punctuation, newline and a confirmation-card phrase that belongs to the quoted content',async()=>{
 const content='合成偏好：先列依据；保留 A、B。\n我会说“给我独立确认卡”。';const text=`请把个人记忆${memoryId}改为：${content}\n先给我独立确认卡。`;
 const result=await prepare({...exact(),correctedContent:content},text);expect(result.reply).toContain("确认卡");expect(result.actions[0].correctedMemoryContent).toBe(content);
});
