import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { App } from "obsidian";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { fileRevision } from "../src/operationIdentity";
import type { StoreHost } from "../src/store/settingsSlice";
vi.mock("obsidian", () => ({ App: class {}, Notice: class {}, TFile: class {}, TFolder: class {}, normalizePath: (p:string)=>p, parseYaml:JSON.parse, stringifyYaml:JSON.stringify }));
const { LifeOpsStore } = await import("../src/store");
const { DiskVault } = await import("./helpers/diskVault");
const { summaryPeriod } = await import("../src/features/summaries/periods");
const { readSummaryScope, summaryPath, renderSummary, SUMMARY_TASK_METRIC_BASIS } = await import("../src/features/summaries/notes");
const { readSummaryQueryWithSources } = await import("../src/features/summaries/read");
let root:string, vault:InstanceType<typeof DiskVault>, store:StoreHost;
const body = "虚构旧摘要：完成了3项任务，人民币盈亏17元。";
beforeEach(async () => {
  vi.useFakeTimers({toFake:["Date"]}); vi.setSystemTime(new Date("2026-11-12T20:00:00+08:00"));
  root = await mkdtemp(join(tmpdir(),"lifeops-legacy-summary-")); vault = new DiskVault(root);
  store = new LifeOpsStore({vault} as unknown as App,structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;
  await store.initializeVault();
});
afterEach(async () => { vi.useRealTimers();vi.restoreAllMocks();await rm(root,{recursive:true,force:true}); });
async function tasks() {
  const first = await store.createTask({title:"虚构同名任务",date:"2026-11-03"});
  const second = await store.createTask({title:"虚构同名任务",date:"2026-11-04"});
  await store.updateTask(first.id,t=>({...t,createdAt:"2026-11-01T00:00:00+08:00",completionLog:[
    {completedAt:"2026-11-03T10:00:00+08:00",note:""},{completedAt:"2026-11-04T10:00:00+08:00",note:""},
    {completedAt:"2026-11-11T10:00:00+08:00",note:""}
  ]}));
  await store.updateTask(second.id,t=>({...t,createdAt:"2026-11-01T00:00:00+08:00",status:"completed",completedAt:"2026-11-04T11:00:00+08:00"}));
  return {first,second};
}
async function seed(level:"week"|"month"="month",through="2026-11-05",date="2026-11-03") {
  const period = summaryPeriod(level,date), scope = await readSummaryScope(store);
  // Original pre-basis stored format: tasksCompleted counted completion events.
  const properties = {lifeops:"lifeops-summary",level,from:period.from,to:period.to,through,sourceScope:scope.hash,
    inputCount:2,complete:false,generatedBy:"local",metrics:{tasksCompleted:3,taskCompletionPercent:50,energy:7,tradePnlCny:17,tradePnlUsd:-4}};
  const header = "---\n"+JSON.stringify(properties)+"\n---\n", text = "\n"+body+"\n";
  const raw = header+"<!-- LifeOps 指纹 "+fileRevision(header+text)+" -->\n"+text, path = summaryPath(store,period);
  await vault.seed(path,raw); return {period,path,raw,properties};
}
async function query(args:Record<string,unknown>={}) {
  const read = await readSummaryQueryWithSources(store,{level:"month",range:"this_month",...args});
  try { return JSON.parse(read.text); } finally {read.dispose();}
}
it.each(["week","month"] as const)("upgrades legacy %s task counts from the same original records and original through date without writing",async level=>{
  await tasks();const saved=await seed(level),before=await store.readPath(store.taskDbPath()),writes=vault.writes.length;
  const data=await query({level,range:{from:saved.period.from,to:saved.properties.through}}),row=data.summaries[0];
  expect(row).toMatchObject({through:"2026-11-05",edited:false,taskMetricBasis:SUMMARY_TASK_METRIC_BASIS,
    metrics:{tasksCompleted:2,taskCompletionEvents:3,taskCompletionPercent:100,energy:7,tradePnlCny:17,tradePnlUsd:-4},
    taskMetricsSource:{kind:"task_records_read_only",through:"2026-11-05",partial:false}});
  expect(row.taskMetricsSource.explanation).toContain("后补记录");expect(row.summary).toBe(body);
  expect(await store.readPath(saved.path)).toBe(saved.raw);expect(await store.readPath(store.taskDbPath())).toBe(before);expect(vault.writes).toHaveLength(writes);
});
it("projects selected upgraded fields without leaking task titles or old summary text",async()=>{
  await tasks();await seed();const read=await readSummaryQueryWithSources(store,{level:"month",range:"this_month",metrics:["tasksCompleted","taskCompletionEvents"]});
  try {expect(JSON.parse(read.text).summaries[0].metrics).toEqual({tasksCompleted:2,taskCompletionEvents:3});expect(read.text).not.toContain("虚构同名任务");expect(read.text).not.toContain(body);expect(read.sources.text).not.toContain("虚构同名任务");await read.assertSourcesCurrent();}finally{read.dispose();}
});
it("keeps a modern saved snapshot and never reads task bodies to recalculate it",async()=>{
  await tasks();const saved=await seed(),raw=renderSummary(saved.period,saved.properties.through,saved.properties.sourceScope,
    {...saved.properties.metrics,tasksCompleted:8,taskCompletionEvents:9},2,false,"local",body);await vault.seed(saved.path,raw);
  const spy=vi.spyOn(vault,"read"),data=await query({metrics:["tasksCompleted"]});expect(data.summaries[0].metrics.tasksCompleted).toBe(8);
  expect(data.summaries[0].taskMetricsSource).toBeUndefined();expect(spy.mock.calls.some(([f])=>[store.taskDbPath(),store.taskMirrorPath()].includes(f.path))).toBe(false);
});
it("does not read legacy task records for a currency-only metric request",async()=>{
  await tasks();await seed();const spy=vi.spyOn(vault,"read"),data=await query({metrics:["tradePnlCny","tradePnlUsd"]});
  expect(data.summaries[0].metrics).toEqual({tradePnlCny:17,tradePnlUsd:-4});expect(data.summaries[0].taskMetricsSource).toBeUndefined();
  expect(spy.mock.calls.some(([f])=>[store.taskDbPath(),store.taskMirrorPath()].includes(f.path))).toBe(false);
});
it("uses unknown for excluded task sources without falling back to an allowed mirror",async()=>{
  await tasks();store.settings.privacy={excludedVaultPrefixes:[store.taskDbPath()]};await seed();
  const spy=vi.spyOn(vault,"read"),data=await query({metrics:["tasksCompleted","taskCompletionEvents","taskCompletionPercent","tradePnlCny"]});
  expect(data.summaries[0].metrics).toEqual({tasksCompleted:null,taskCompletionEvents:null,taskCompletionPercent:null,tradePnlCny:17});
  expect(data.summaries[0].taskMetricsSource.kind).toBe("unavailable");expect(spy.mock.calls.some(([f])=>[store.taskDbPath(),store.taskMirrorPath()].includes(f.path))).toBe(false);
});
it("does not turn missing task files into zero",async()=>{
  await vault.delete(store.getFile(store.taskDbPath())!);await vault.delete(store.getFile(store.taskMirrorPath())!);await seed();
  const data=await query({metrics:["tasksCompleted"]});expect(data.summaries[0].metrics.tasksCompleted).toBeNull();expect(data.summaries[0].taskMetricsSource.kind).toBe("unavailable");
});
it("marks privacy-filtered task counts as partial and counts only allowed IDs",async()=>{
  const {second}=await tasks();await store.updateTask(second.id,t=>({...t,sourceNotePath:"虚构私人/隐藏.md"}));
  store.settings.privacy={excludedVaultPrefixes:["虚构私人"]};await seed();const data=await query({metrics:["tasksCompleted","taskCompletionEvents"]});
  expect(data.summaries[0].metrics).toEqual({tasksCompleted:1,taskCompletionEvents:2});expect(data.summaries[0].taskMetricsSource.partial).toBe(true);
});
it("shares one task snapshot across periods plus one final source-hash validation",async()=>{
  await tasks();await seed();await seed("month","2026-10-31","2026-10-03");const spy=vi.spyOn(vault,"read");
  const data=await query({range:{from:"2026-10-01",to:"2026-11-12"},metrics:["tasksCompleted"]});
  expect(data.summaries.map((r:any)=>r.metrics.tasksCompleted)).toEqual([0,2]);expect(spy.mock.calls.filter(([f])=>f.path===store.taskDbPath())).toHaveLength(2);
});
it.each(["taskDbPath","taskMirrorPath"] as const)("retains original task dependencies after returning: %s",async key=>{
  await tasks();await seed();const read=await readSummaryQueryWithSources(store,{level:"month",range:"this_month",metrics:["tasksCompleted"]});
  try {const path=store[key]();await vault.seed(path,(await store.readPath(path))+"\n");await expect(read.assertSourcesCurrent()).rejects.toThrow();}finally{read.dispose();}
});
it("detects creation of a previously missing task source after an unknown projection",async()=>{
  const db=await store.readPath(store.taskDbPath());await vault.delete(store.getFile(store.taskDbPath())!);await vault.delete(store.getFile(store.taskMirrorPath())!);await seed();
  const read=await readSummaryQueryWithSources(store,{level:"month",range:"this_month",metrics:["tasksCompleted"]});
  try {await vault.seed(store.taskDbPath(),db);await expect(read.assertSourcesCurrent()).rejects.toThrow();}finally{read.dispose();}
});
it.each(["2026-11-31","2026-10-31","2026-11-30","not-a-date"])("does not expand an invalid or future legacy through date: %s",async through=>{
  await tasks();await seed("month",through);const spy=vi.spyOn(vault,"read"),data=await query({metrics:["tasksCompleted"]});
  expect(data.summaries[0].metrics.tasksCompleted).toBeNull();expect(data.summaries[0].taskMetricsSource.kind).toBe("unavailable");
  expect(spy.mock.calls.some(([f])=>[store.taskDbPath(),store.taskMirrorPath()].includes(f.path))).toBe(false);
});
