import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {DEFAULT_SETTINGS} from '../src/defaults';
import type {StoreHost} from '../src/store/settingsSlice';
import {executeVaultQuery,readVaultQueryWithSources,vaultQueryReadCoverage} from '../src/vaultQuery';
import {AgentRuntime} from '../src/agentRuntime';
import {getLifeOpsTool} from '../src/toolRegistry';

vi.mock('obsidian',()=>({App:class{},Notice:class{},TFile:class{},TFolder:class{},
 normalizePath:(path:string)=>path.replace(/\\/g,'/').replace(/\/{2,}/g,'/'),parseYaml:JSON.parse,stringifyYaml:JSON.stringify}));
const {LifeOpsStore}=await import('../src/store');
const {DiskVault}=await import('./helpers/diskVault');
const {ReadOnlyExternalVault}=await import('../src/features/externalVault/readOnly');
let root:string,external:string,vault:InstanceType<typeof DiskVault>,store:StoreHost,runtime:AgentRuntime;
const vaultName='虚构期段库';
beforeEach(async()=>{
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-11-12T20:00:00+08:00'));
 root=await mkdtemp(join(tmpdir(),'lifeops-fictional-journal-period-'));external=join(root,'original');await mkdir(external);await mkdir(join(root,'local'));
 vault=new DiskVault(join(root,'local'));const settings=structuredClone(DEFAULT_SETTINGS);
 settings.externalVaults=[{name:vaultName,path:external,folders:[settings.folders.dailyRoot]}];
 store=new LifeOpsStore({vault}as any,settings)as unknown as StoreHost;runtime=new AgentRuntime({store,refreshViews:async()=>{}});
});
afterEach(async()=>{vi.restoreAllMocks();vi.useRealTimers();await rm(root,{recursive:true,force:true});});
async function seed(dates:string[]){for(const date of dates){const path=store.dailyNotePath(date,'晚');await vault.seed(path,'虚构纸样本机原话 '+date);await mkdir(dirname(join(external,path)),{recursive:true});await writeFile(join(external,path),'虚构纸样外部原话 '+date);}}
const sourceDates=['2026-10-31','2026-11-02','2026-11-03','2026-11-08','2026-11-09','2026-11-12','2026-11-15','2026-11-16'];

it('advertises explicit past periods and bounded intervals instead of forcing last-week requests into week',()=>{
 const parameter=(getLifeOpsTool('query_vault')!.parameters.properties as any).range;
 for(const name of ['last_week','last_month','this_week','this_month','from','to'])expect(JSON.stringify(parameter)).toContain(name);
});
it.each(['get','list','search']as const)('keeps a real runtime %s of last week in Nov2-Nov8 for both vaults',async operation=>{
 await seed(sourceDates);const result=await runtime.executeToolCall({toolName:'query_vault',callId:'fictional-last-week-'+operation,source:'kimi',
  arguments:{domain:'journal',operation,range:'last_week',...(operation==='search'?{query:'虚构纸样'}:{}),limit:12,sort:'oldest'}});
 expect(result.success,result.output).toBe(true);expect(result.output).toContain('2026-11-02 至 2026-11-08');
 for(const date of ['2026-11-02','2026-11-03','2026-11-08'])expect(result.output).toContain(date+'晚.md');
 for(const date of ['2026-10-31','2026-11-09','2026-11-12','2026-11-15','2026-11-16'])expect(result.output).not.toContain(date+'晚.md');
 if(operation!=='list'){expect(result.output).toContain('本机原话');expect(result.output).toContain('外部原话');}
 expect(result.actions).toEqual([]);
});
it.each(['local',vaultName])('the legacy anchored week uses the same whole week in %s',async selected=>{
 await seed(sourceDates);const output=await executeVaultQuery(store,{domain:'journal',operation:'get',date:'2026-11-04',range:'week',vault:selected});
 for(const date of ['2026-11-02','2026-11-03','2026-11-08'])expect(output).toContain(date+'晚.md');
 for(const date of ['2026-11-09','2026-11-12','2026-11-15'])expect(output).not.toContain(date+'晚.md');
});
it('keeps this_week through today while preserving legacy week through Sunday',async()=>{
 await seed(sourceDates);const bounded=await executeVaultQuery(store,{domain:'journal',operation:'get',range:'this_week',vault:'local'});
 expect(bounded).toContain('2026-11-09 至 2026-11-12');expect(bounded).not.toContain('2026-11-15晚.md');
 const legacy=await executeVaultQuery(store,{domain:'journal',operation:'get',range:'week',vault:'local'});expect(legacy).toContain('2026-11-15晚.md');
});
it.each(['local',vaultName])('last_month includes leap day and excludes adjacent months in %s',async selected=>{
 vi.setSystemTime(new Date('2024-03-15T20:00:00+08:00'));await seed(['2024-01-31','2024-02-01','2024-02-29','2024-03-01']);
 const output=await executeVaultQuery(store,{domain:'journal',operation:'get',range:'last_month',vault:selected});
 expect(output).toContain('2024-02-01 至 2024-02-29');expect(output).toContain('2024-02-01晚.md');expect(output).toContain('2024-02-29晚.md');
 expect(output).not.toContain('2024-01-31晚.md');expect(output).not.toContain('2024-03-01晚.md');
});
it('resolves a previous week across the year independently of note modification time',async()=>{
 vi.setSystemTime(new Date('2027-01-01T20:00:00+08:00'));await seed(['2026-12-20','2026-12-21','2026-12-27','2026-12-28','2027-01-01']);
 const output=await executeVaultQuery(store,{domain:'journal',operation:'get',range:'last_week',vault:vaultName});
 expect(output).toContain('2026-12-21 至 2026-12-27');for(const d of ['2026-12-21','2026-12-27'])expect(output).toContain(d+'晚.md');
 for(const d of ['2026-12-20','2026-12-28','2027-01-01'])expect(output).not.toContain(d+'晚.md');
});
it.each([{from:'2026-10-31',to:'2026-11-03'},'2026-10-31/2026-11-03','2026-10-31..2026-11-03','{"from":"2026-10-31","to":"2026-11-03"}'])('retains a literal cross-month interval %j through the actual tool gateway',async range=>{
 await seed(sourceDates);const result=await runtime.executeToolCall({toolName:'query_vault',callId:'fictional-month-window',source:'kimi',
  arguments:{domain:'journal',operation:'search',range,query:'虚构纸样',limit:12}});
 expect(result.success,result.output).toBe(true);expect(result.output).toContain('2026-10-31 至 2026-11-03');
 for(const d of ['2026-10-31','2026-11-02','2026-11-03'])expect(result.output).toContain(d+'晚.md');expect(result.output).not.toContain('2026-11-08晚.md');
});
it.each([null,7,'year','{"from":"2026-11-02"}',{from:'2026-11-08',to:'2026-11-02'},
 {from:'2026-02-30',to:'2026-03-01'},{from:'2026-11-02',to:'2026-11-08',extra:true}])('refuses invalid range %j before any local or external source read',async range=>{
 await seed(sourceDates);const local=vi.spyOn(vault,'read'),list=vi.spyOn(ReadOnlyExternalVault.prototype,'listMarkdown'),body=vi.spyOn(ReadOnlyExternalVault.prototype,'read');
 await expect(executeVaultQuery(store,{domain:'journal',operation:'get',range}as any)).rejects.toThrow(/范围|区间/);
 expect(local).not.toHaveBeenCalled();expect(list).not.toHaveBeenCalled();expect(body).not.toHaveBeenCalled();
});
it('returns a repairable parameter error instead of silently discarding an unsupported runtime range',async()=>{
 await seed(sourceDates);const list=vi.spyOn(ReadOnlyExternalVault.prototype,'listMarkdown');const result=await runtime.executeToolCall({toolName:'query_vault',callId:'fictional-range-refusal',source:'kimi',arguments:{domain:'journal',operation:'get',range:'unknown-period'}});
 expect(result.success).toBe(false);expect(result.output).toMatch(/范围|区间/);expect(result.output).not.toMatch(/权限刚刚变化|操作记录暂不可用/);expect(list).not.toHaveBeenCalled();
});
it('refuses a conflicting explicit day or non-journal range without opening the external catalog',async()=>{
 await seed(sourceDates);const list=vi.spyOn(ReadOnlyExternalVault.prototype,'listMarkdown');
 for(const input of [{domain:'journal',date:'2026-11-12',range:'last_week'},{domain:'note',range:'last_week'},{domain:'task',range:'last_week'}]){
  const result=await runtime.executeToolCall({toolName:'query_vault',callId:'fictional-conflict-'+input.domain,source:'kimi',arguments:{...input,operation:'get'}});
  expect(result.success).toBe(false);expect(result.output).toMatch(/range|日期|范围|区间/);expect(result.actions).toEqual([]);
 }
 expect(list).not.toHaveBeenCalled();
});
it('keeps exact paths and exclusions inside the requested interval and leaves originals unchanged',async()=>{
 await seed(sourceDates);const path=store.dailyNotePath('2026-11-03','晚'),original=await readFile(join(external,path),'utf8');
 store.settings.privacy!.excludedVaultPrefixes=[store.dailyNotePath('2026-11-02','晚')];const read=await readVaultQueryWithSources(store,{domain:'journal',operation:'search',query:'虚构纸样',range:'last_week',limit:12});
 try{expect(read.text).toContain('2026-11-03晚.md');expect(read.text).not.toContain('2026-11-02晚.md');expect(vaultQueryReadCoverage(read)?.pages.every(p=>!p.path.includes('2026-11-12'))).toBe(true);await read.assertSourcesCurrent();}finally{read.dispose();}
 await expect(executeVaultQuery(store,{domain:'journal',operation:'get',range:'last_week',path:store.dailyNotePath('2026-11-12','晚'),vault:'local'})).rejects.toThrow(/不匹配/);
 const result=await executeVaultQuery(store,{domain:'journal',operation:'get',range:'last_week',path:'external-vault/'+vaultName+'/'+store.dailyNotePath('2026-11-12','晚'),vault:vaultName});expect(result).not.toContain('2026-11-12晚.md');
 expect(await readFile(join(external,path),'utf8')).toBe(original);
});
it.each(['last_week' as const,{from:'2026-11-02',to:'2026-11-08'}])('holds one date selection %j across midnight and caller edits while the external read awaits its catalog',async range=>{
 vi.setSystemTime(new Date('2026-11-15T23:59:59+08:00'));await seed(sourceDates);
 let entered!:()=>void,resume!:()=>void;const started=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{resume=r;});
 const original=ReadOnlyExternalVault.prototype.listMarkdown;let first=true;
 vi.spyOn(ReadOnlyExternalVault.prototype,'listMarkdown').mockImplementation(async function(this:InstanceType<typeof ReadOnlyExternalVault>){if(first){first=false;entered();await gate;}return original.call(this);});
 const input={domain:'journal' as const,operation:'get' as const,range:structuredClone(range)};
 const reading=readVaultQueryWithSources(store,input);await started;if(typeof input.range==='object'){input.range.from='2026-11-09';input.range.to='2026-11-15';}vi.setSystemTime(new Date('2026-11-16T00:00:01+08:00'));resume();
 const read=await reading;try{expect(read.text).toContain('2026-11-02 至 2026-11-08');expect(read.text).toContain('本机原话 2026-11-03');expect(read.text).toContain('外部原话 2026-11-03');expect(read.text).not.toContain('2026-11-12晚.md');expect(vaultQueryReadCoverage(read)?.dateRange).toEqual({from:'2026-11-02',to:'2026-11-08'});await read.assertSourcesCurrent();}finally{read.dispose();}
});
it('keeps the requested morning filter in both vaults without substituting an evening original',async()=>{
 await seed(['2026-11-03','2026-11-09']);const path=store.dailyNotePath('2026-11-03','早');await vault.seed(path,'虚构本机晨间原话');await mkdir(dirname(join(external,path)),{recursive:true});await writeFile(join(external,path),'虚构外部晨间原话');
 const output=await executeVaultQuery(store,{domain:'journal',operation:'get',range:'last_week',period:'早'});
 expect(output).toContain('虚构本机晨间原话');expect(output).toContain('虚构外部晨间原话');expect(output).not.toContain('2026-11-03晚.md');expect(output).not.toContain('2026-11-09晚.md');
});
