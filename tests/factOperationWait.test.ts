import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import type {App} from "obsidian";
import {DEFAULT_SETTINGS} from "../src/defaults";
import type {StoreHost} from "../src/store/settingsSlice";
import {factRecoveryPath,runFactOperation,waitForFactOperations} from "../src/dataFoundation/factOperation";
import {runDerivedOperation} from "../src/dataFoundation/derivedOperation";
vi.mock("obsidian",()=>({App:class{},Notice:class{},TFile:class{},TFolder:class{},normalizePath:(p:string)=>p.replace(/\\/g,"/").replace(/\/{2,}/g,"/")}));
const {LifeOpsStore}=await import("../src/store"),{DiskVault}=await import("./helpers/diskVault");
let root:string,vault:InstanceType<typeof DiskVault>,store:StoreHost;
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return{promise,resolve};}
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
beforeEach(async()=>{root=await mkdtemp(join(tmpdir(),"lifeops-wait-operation-"));vault=new DiskVault(root);store=new LifeOpsStore({vault} as unknown as App,structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;});
afterEach(async()=>{vi.restoreAllMocks();await rm(root,{recursive:true,force:true});});
describe("public read preparation waits for live writes without owning them",()=>{
  it.each(["fact","derived"] as const)("waits across Store instances for the same Vault's %s operation",async purpose=>{
    const entered=deferred(),release=deferred();
    const operation=runFactOperation(store,{operationId:`fiction-wait-${purpose}`,purpose},async()=>{entered.resolve();await release.promise;},async()=>{});await entered.promise;
    const another=new LifeOpsStore({vault} as unknown as App,structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;
    let settled=false;const read=waitForFactOperations(another).then(()=>{settled=true;});
    try{await tick();expect(settled).toBe(false);}finally{release.resolve();await operation;}
    await read;expect(settled).toBe(true);
  });
  it("waits for the final protected-source guard even when the disk journal is committed",async()=>{
    const entered=deferred(),release=deferred();let checks=0;
    const path=store.vaultIndexPath();
    const operation=runDerivedOperation(store,async scope=>{await scope.writeFile(path,JSON.stringify({entries:[]}));},{assertBeforeCommit:async()=>{if(++checks===2){entered.resolve();await release.promise;}}});await entered.promise;
    expect(JSON.parse(await vault.bytes(factRecoveryPath(store))).status).toBe("committed");
    let settled=false;const read=waitForFactOperations(store).then(()=>{settled=true;});
    try{await tick();expect(settled).toBe(false);}finally{release.resolve();await operation;}await read;
  });
  it("also waits for work queued while an earlier operation is running",async()=>{
    const firstEntered=deferred(),firstRelease=deferred(),secondEntered=deferred(),secondRelease=deferred();
    const first=runDerivedOperation(store,async()=>{firstEntered.resolve();await firstRelease.promise;});await firstEntered.promise;
    let settled=false;const read=waitForFactOperations(store).then(()=>{settled=true;});
    const second=runDerivedOperation(store,async()=>{secondEntered.resolve();await secondRelease.promise;});
    firstRelease.resolve();await first;await secondEntered.promise;
    try{await tick();expect(settled).toBe(false);}finally{secondRelease.resolve();await second;}await read;
  });
  it("cancels only the waiting reader and removes its listener while the writer continues",async()=>{
    const entered=deferred(),release=deferred();let writerFinished=false;
    const operation=runDerivedOperation(store,async()=>{entered.resolve();await release.promise;writerFinished=true;});await entered.promise;
    const controller=new AbortController(),add=vi.spyOn(controller.signal,"addEventListener"),remove=vi.spyOn(controller.signal,"removeEventListener");
    const read=waitForFactOperations(store,{signal:controller.signal});const rejected=expect(read).rejects.toMatchObject({name:"AbortError"});controller.abort();await rejected;
    expect(writerFinished).toBe(false);expect(add).toHaveBeenCalledOnce();expect(remove).toHaveBeenCalledWith("abort",add.mock.calls[0][1]);
    release.resolve();await operation;expect(writerFinished).toBe(true);await waitForFactOperations(store);
  });
  it("rejects a pre-cancelled reader before adding any listener",async()=>{
    const controller=new AbortController();controller.abort();const add=vi.spyOn(controller.signal,"addEventListener");
    await expect(waitForFactOperations(store,{signal:controller.signal})).rejects.toMatchObject({name:"AbortError"});expect(add).not.toHaveBeenCalled();
  });
  it("removes the listener when an operation finishes normally",async()=>{
    const entered=deferred(),release=deferred();const operation=runDerivedOperation(store,async()=>{entered.resolve();await release.promise;});await entered.promise;
    const controller=new AbortController(),add=vi.spyOn(controller.signal,"addEventListener"),remove=vi.spyOn(controller.signal,"removeEventListener");const read=waitForFactOperations(store,{signal:controller.signal});
    release.resolve();await operation;await read;expect(remove).toHaveBeenCalledWith("abort",add.mock.calls[0][1]);
  });
  it("rejects a held scope immediately rather than waiting for itself",async()=>{
    await runDerivedOperation(store,async scope=>{await expect(waitForFactOperations(scope)).rejects.toThrow("保存操作内");});
  });
  it("rechecks request ownership after waiting without cancelling the writer",async()=>{
    const entered=deferred(),release=deferred();const operation=runDerivedOperation(store,async()=>{entered.resolve();await release.promise;});await entered.promise;
    let current=true;const read=waitForFactOperations(store,{assertCurrent:()=>{if(!current)throw Error("request retired");}});const rejected=expect(read).rejects.toThrow("request retired");
    current=false;release.resolve();await operation;await rejected;
  });
  it("treats a failed live operation as settled and leaves durable recovery to its existing guard",async()=>{
    const entered=deferred(),release=deferred();const operation=runDerivedOperation(store,async()=>{entered.resolve();await release.promise;throw Error("fictional writer failure");});const failure=expect(operation).rejects.toThrow("fictional writer failure");await entered.promise;
    const read=waitForFactOperations(store);release.resolve();await failure;await read;
    const pending=JSON.stringify({version:1,operationId:"fiction-old-interruption",purpose:"derived",status:"pending",entries:[]});await vault.seed(factRecoveryPath(store),pending);
    await waitForFactOperations(store);expect(await vault.bytes(factRecoveryPath(store))).toBe(pending);
  });
});
