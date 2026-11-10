import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import type {App} from "obsidian";
import {DEFAULT_SETTINGS} from "../src/defaults";
import type {StoreHost} from "../src/store/settingsSlice";
import {tradingDocumentPath} from "../src/tradingResearch";
import {runDerivedOperation} from "../src/dataFoundation/derivedOperation";
import {factRecoveryPath} from "../src/dataFoundation/factOperation";

vi.mock("obsidian",()=>({App:class{},Plugin:class{},TFile:class{},TFolder:class{},WorkspaceLeaf:class{},ItemView:class{},Modal:class{},PluginSettingTab:class{},Setting:class{},Platform:{isDesktopApp:true},Notice:class{},normalizePath:(path:string)=>path.replace(/\\/g,"/").replace(/\/{2,}/g,"/"),setIcon:vi.fn(),requestUrl:vi.fn(()=>{throw Error("Network forbidden");})}));
const {default:LifeOpsPlugin}=await import("../src/main");
const {LifeOpsStore}=await import("../src/store"),{DiskVault}=await import("./helpers/diskVault");
const {AgentRuntime}=await import("../src/agentRuntime"),{runConfirmedToolAction}=await import("../src/toolRegistry");
let root:string,vault:InstanceType<typeof DiskVault>,store:StoreHost,plugin:any,source:string;
const oldRule="纯虚构旧规则甲";
beforeEach(async()=>{
  vi.stubGlobal("window",globalThis);root=await mkdtemp(join(tmpdir(),"lifeops-trading-conversation-"));vault=new DiskVault(root);
  const app={vault,workspace:{getLeavesOfType:vi.fn(()=>[])}} as unknown as App;
  store=new LifeOpsStore(app,structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;await store.initializeVault();
  source=store.path(store.settings.folders.tradingModels,"纯虚构规则来源.md");await vault.seed(source,"纯虚构来源一");
  const context={store,refreshViews:async()=>{}},runtime=new AgentRuntime(context);
  const proposed=await runtime.executeAiToolCall({id:"fiction-rule",name:"propose_trading_research_change",arguments:{command:{kind:"save_model",input:{title:"纯虚构规则模型",entry:oldRule,sourcePath:source}}}},"kimi");
  expect(proposed.success,proposed.output).toBe(true);await runConfirmedToolAction(proposed.actions[0],context);
  const firstModel=vi.fn(async()=>({content:oldRule,toolCalls:[]}));
  plugin=Object.assign(Object.create(LifeOpsPlugin.prototype),{app,store,settings:store.settings,lifecycleGeneration:1,unloaded:false,updateStatusBar:vi.fn(async()=>{}),refreshViews:vi.fn(async()=>{}),lifeOpsEvents:{publish:vi.fn()},buildSemanticContext:vi.fn(async()=>""),tryLocalAgentFallback:vi.fn(async()=>null),ai:{agentReply:firstModel,agentReplyStream:firstModel,delegatedReplyStream:firstModel,agentReplyAfterToolResultsStream:vi.fn(async()=>({content:oldRule,toolCalls:[]}))}});
});
afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllGlobals();await rm(root,{recursive:true,force:true});});
const run=(message:string,delivered=vi.fn())=>plugin.submitAgentMessageStream(message,[],delivered,{source:"text",selfTest:true});
const readTradingRuleBeforeAnswer=()=>plugin.ai.agentReply.mockImplementation(async(_c:string,_m:string,_h:unknown,_o:unknown,_s:string,options:any)=>{
  expect(options.sourceReadTurns).toBeDefined();
  if(!options.sourceReadTurns.length)return{content:"",toolCalls:[{id:"grounded-trading-read",name:"query_trading_research",arguments:{query:"纯虚构规则模型"}}]};
  expect(options.sourceReadTurns.flatMap((turn:any)=>turn.results).map((result:any)=>result.output).join("\n")).toContain(oldRule);
  return{content:oldRule,toolCalls:[]};
});
describe("trading research through the production conversation entry",()=>{
  it("stops a waiting voice request promptly, without provider calls or stopping the prior writer",async()=>{
    let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(resolve=>enter=resolve),waiting=new Promise<void>(resolve=>release=resolve);
    const operation=runDerivedOperation(store,async()=>{enter();await waiting;});await entered;
    const controller=new AbortController();const reply=plugin.submitAgentMessage("请回顾我的交易模型规则",[],{source:"voice",selfTest:true,signal:controller.signal});const rejected=expect(reply).rejects.toMatchObject({name:"AbortError"});
    controller.abort();await rejected;expect(plugin.activeVoiceRequests.size).toBe(0);expect(plugin.ai.agentReply).not.toHaveBeenCalled();release();await operation;
  });
});
