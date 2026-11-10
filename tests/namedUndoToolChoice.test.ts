import {mkdtemp,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {beforeEach,afterEach,it,expect,vi} from "vitest";
import type {App} from "obsidian";
import {DEFAULT_SETTINGS} from "../src/defaults";
import {AgentRuntime} from "../src/agentRuntime";
import {OperationLedger} from "../src/dataFoundation/operationLedger";
import type {StoreHost} from "../src/store/settingsSlice";
const request=vi.hoisted(()=>vi.fn());
vi.mock("obsidian",()=>({App:class{},Plugin:class{},TFile:class{},TFolder:class{},WorkspaceLeaf:class{},ItemView:class{},Modal:class{},PluginSettingTab:class{},Setting:class{},Platform:{isDesktopApp:true},Notice:class{},normalizePath:(p:string)=>p.replace(/\\/g,"/").replace(/\/{2,}/g,"/"),setIcon:vi.fn(),requestUrl:request}));
const {LifeOpsStore}=await import("../src/store");
const {LifeOpsAi}=await import("../src/ai");
const {default:Plugin}=await import("../src/main");
const {DiskVault}=await import("./helpers/diskVault");
const originalResponse: { choices: unknown[] }={choices:[{index:0,finish_reason:"stop",message:{role:"assistant",content:"好，先撤销这一步，我停在这儿。"}}]};
const title="合成最新白玉核对",oldTitle="合成旧琥珀核对",message="请撤销刚才创建的"+title;
let root:string,vault:InstanceType<typeof DiskVault>,store:StoreHost,plugin:any,runtime:AgentRuntime,initialTask:string;
let honorChoice:boolean,forceRogue:boolean,fail:boolean,bodies:any[],extraCalls:any[];
const ledger=async()=>JSON.parse((await store.readPath(new OperationLedger(store).filePath))!);
beforeEach(async()=>{
  vi.stubGlobal("window",globalThis);request.mockReset();
  root=await mkdtemp(join(tmpdir(),"lifeops-named-choice-"));vault=new DiskVault(root);
  const settings=structuredClone(DEFAULT_SETTINGS);
  settings.privacy={...settings.privacy,excludedVaultPrefixes:[],plaintextCredentialStorageAccepted:true};
  settings.ai={...settings.ai,provider:"openai-compatible",endpoint:"https://example.test/chat",model:"kimi-k2.6",apiKey:"fictional-key",dataDisclosureAccepted:true};
  const app={vault,workspace:{getLeavesOfType:()=>[]}} as unknown as App;
  store=new LifeOpsStore(app,settings) as unknown as StoreHost;await store.initializeVault();
  runtime=new AgentRuntime({store,refreshViews:async()=>{}});
  await runtime.executeAiToolCall({id:"old-created",name:"create_task",arguments:{title:oldTitle}},"kimi","请创建任务："+oldTitle);
  initialTask=await vault.bytes(store.taskDbPath());
  await runtime.executeAiToolCall({id:"latest-created",name:"create_task",arguments:{title}},"kimi","请创建任务："+title);
  const ai=new LifeOpsAi(settings);
  // Reproduce the no-tool conversational path without making an external request.
  vi.spyOn(ai,"agentReplyStream").mockResolvedValue({content:"好，先撤销这一步，我停在这儿。",toolCalls:[]});
  vi.spyOn(ai,"agentReplyAfterToolResultsStream").mockResolvedValue({content:"依据实际回执回答。",toolCalls:[]});
  plugin=Object.assign(Object.create(Plugin.prototype),{app,store,settings,ai,refreshViews:async()=>{},updateStatusBar:async()=>{},lifeOpsEvents:{publish:()=>{}},buildSemanticContext:async()=>"",tryLocalAgentFallback:async()=>null});
  honorChoice=true;forceRogue=false;fail=false;bodies=[];extraCalls=[];
  request.mockImplementation(async ({body}:{body:string})=>{
    const parsed=JSON.parse(body);bodies.push(parsed);if(fail)throw Error("fictional unavailable provider");
    const json=structuredClone(originalResponse);
    if(forceRogue || honorChoice && parsed.tool_choice?.function?.name==="undo_latest_operation"){
      json.choices[0]={index:0,finish_reason:"tool_calls",message:{role:"assistant",content:"",tool_calls:[{id:"undo-choice-"+bodies.length,type:"function",function:{name:"undo_latest_operation",arguments:"{}"}},...extraCalls]}};
    }
    return {status:200,json,text:JSON.stringify(json)};
  });
});
afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllGlobals();await rm(root,{recursive:true,force:true});});
const run=(text=message,source:"text"|"voice"="text")=>plugin.submitAgentMessageStream(text,[],()=>{},{selfTest:true,source});
it("does not undo locally after a failed provider request",async()=>{
  fail=true;const before=await vault.bytes(store.taskDbPath()),audit=await ledger();
  const result=await run().catch(()=>undefined);expect(bodies.length).toBeGreaterThan(0);
  if(result)expect(result.reply).not.toContain("已撤销");
  expect(await vault.bytes(store.taskDbPath())).toBe(before);expect(await ledger()).toEqual(audit);
});
it("does not request or undo after the turn has already been cancelled",async()=>{
  const before=await vault.bytes(store.taskDbPath()),audit=await ledger(),controller=new AbortController();controller.abort();
  await plugin.submitAgentMessageStream(message,[],()=>{},{selfTest:true,source:"text",signal:controller.signal}).catch(()=>undefined);
  expect(request).not.toHaveBeenCalled();expect(await vault.bytes(store.taskDbPath())).toBe(before);expect(await ledger()).toEqual(audit);
});
