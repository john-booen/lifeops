import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DEFAULT_SETTINGS} from "../src/defaults";
import {factRecoveryPath,readFactOperation} from "../src/dataFoundation/factOperation";
import {runDerivedOperation} from "../src/dataFoundation/derivedOperation";
import * as factReads from "../src/dataFoundation/factOperation";
vi.mock("obsidian",()=>({App:class{},Notice:class{},TFile:class{},TFolder:class{},normalizePath:(p:string)=>p.replace(/\\/g,"/").replace(/\/{2,}/g,"/")}));
const {LifeOpsStore}=await import("../src/store"),{DiskVault}=await import("./helpers/diskVault");
let directory:string,store:any,vault:any;const pending:Promise<unknown>[]=[],releases:(()=>void)[]=[];
function gate(){let release!:()=>void;const promise=new Promise<void>(yes=>release=yes);releases.push(release);return{promise,release};}
const tick=()=>new Promise<void>(yes=>setImmediate(yes));
beforeEach(async()=>{
 directory=await mkdtemp(join(tmpdir(),"lifeops-readonly-derived-"));
 vault=Object.assign(new DiskVault(directory),{adapter:{getBasePath:()=>directory},on:vi.fn(()=>({})),offref:vi.fn()});
 store=new LifeOpsStore({vault}as any,structuredClone(DEFAULT_SETTINGS));await store.initializeVault();
 await runDerivedOperation(store,async scope=>{await scope.writeFile(scope.vaultIndexPath(),JSON.stringify({generatedAt:new Date().toISOString(),vaultName:"Synthetic Test Vault",totalMarkdownFiles:0,indexedFiles:0,entries:[],fictionalReadSeed:true}));});
});
afterEach(async()=>{releases.splice(0).forEach(release=>release());await Promise.allSettled(pending.splice(0));vi.restoreAllMocks();await rm(directory,{recursive:true,force:true});});

it("waits for the writer's final guard before reading without becoming another transaction",async()=>{
 const entered=gate(),release=gate();let checks=0,reads=0;
 const writer=runDerivedOperation(store,async scope=>{await scope.writeFile(scope.vaultIndexPath(),JSON.stringify({entries:[],fictional:1}));},{assertBeforeCommit:async()=>{if(++checks===2){entered.release();await release.promise;}}});pending.push(writer);await entered.promise;
 expect(JSON.parse(await vault.bytes(factRecoveryPath(store))).status).toBe("committed");
 const read=readFactOperation(store,async()=>{reads++;return "fictional read";});pending.push(read);await tick();expect(reads).toBe(0);
 release.release();await writer;expect(await read).toBe("fictional read");expect(reads).toBe(1);
});


it("refuses an interrupted WAL without recovering or changing it",async()=>{
 const raw=JSON.stringify({version:1,operationId:"fictional-interrupted-read",purpose:"derived",status:"pending",entries:[]});await vault.seed(factRecoveryPath(store),raw);let reads=0;
 await expect(readFactOperation(store,async()=>{reads++;return "must not read";})).rejects.toThrow("上次保存被中断");expect(reads).toBe(0);expect(await vault.bytes(factRecoveryPath(store))).toBe(raw);
});




it("allows the genuine writer scope to read while a second ordinary Store still waits",async()=>{
 const entered=gate(),release=gate();let scopedRead=false,publicDone=false;
 const writer=runDerivedOperation(store,async scope=>{await scope.readSourceManifest();scopedRead=true;entered.release();await release.promise;});pending.push(writer);await entered.promise;
 const another:any=new LifeOpsStore({vault}as any,structuredClone(DEFAULT_SETTINGS));const read=another.readSourceManifest().then(()=>{publicDone=true;});pending.push(read);await tick();expect(scopedRead).toBe(true);expect(publicDone).toBe(false);
 release.release();await writer;await read;expect(publicDone).toBe(true);
});

it("still refreshes stale knowledge through the original derived writer and keeps the next search read-only",async()=>{
 const path=store.path(store.settings.folders.ideas,"fictional-read-refresh.md");await vault.seed(path,"# fictional source\n\nfictional evidence remains searchable.");
 expect((await store.searchKnowledge("fictional",5)).length).toBeGreaterThan(0);
 const writes=vault.writes.length;
 expect((await store.searchKnowledge("fictional",5)).length).toBeGreaterThan(0);
 expect(vault.writes.length).toBe(writes);
});
