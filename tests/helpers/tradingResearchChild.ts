import {LifeOpsStore} from "../../src/store";
import {AgentRuntime} from "../../src/agentRuntime";
import {DEFAULT_SETTINGS} from "../../src/defaults";
import {DiskVault} from "./diskVault";
import type {App} from "obsidian";
import type {StoreHost} from "../../src/store/settingsSlice";
import type {TradingCommand} from "../../src/tradingResearch";
import {tradingDocumentPath} from "../../src/dataFoundation/tradingPersistence";
import {factRecoveryPath,recoverFactOperation} from "../../src/dataFoundation/factOperation";
import {readFile} from "node:fs/promises";
import {join} from "node:path";
import {buildTradingResearchContext} from "../../src/tradingTools";
const [root,mode,phase]=process.argv.slice(2),vault=new DiskVault(root),store=new LifeOpsStore({vault} as unknown as App,structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;
const fixture=JSON.parse(await readFile(join(root,"fiction-command.json"),"utf8")) as {command:TradingCommand;revision:string;operationId:string};
const runtime=new AgentRuntime({store,refreshViews:async()=>{}}),processFile=vault.process.bind(vault),create=vault.create.bind(vault),crash=()=>process.kill(process.pid,"SIGKILL");
function after(path:string,content:string):void{
  if(phase==="after-research"&&path===tradingDocumentPath(store))crash();
  if(phase==="after-audit"&&path.endsWith("operation-ledger.json")&&JSON.parse(content).records.some((r:any)=>r.operationId===fixture.operationId&&r.status==="verified"))crash();
  if(phase==="after-wal"&&path===factRecoveryPath(store)&&JSON.parse(content).operationId===fixture.operationId&&JSON.parse(content).status==="committed")crash();
}
vault.process=async(file,update)=>{const result=await processFile(file,update);after(file.path,result);return result;};
vault.create=async(path,content)=>{const file=await create(path,content);after(path,content);return file;};
if(mode==="inspect"){try{console.log(JSON.stringify({readable:true,output:await buildTradingResearchContext(store)}));}catch(cause){console.log(JSON.stringify({readable:false,error:cause instanceof Error?cause.message:"protected"}));}}
else if(mode==="recover"){console.log(JSON.stringify({recovery:await recoverFactOperation(store)}));}
else{const result=await runtime.executeLocalOperation("fiction_trading_commit",{command:fixture.command,revision:fixture.revision},scope=>scope.applyTradingCommand(fixture.command,fixture.revision,fixture.operationId),fixture.operationId);console.log(JSON.stringify(result));if(!result.success)process.exitCode=1;}
