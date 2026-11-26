import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { App } from "obsidian";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/defaults";
import type { StoreHost } from "../src/store/settingsSlice";
import type { AgentConversationMessage } from "../src/types";
import { AgentRuntime } from "../src/agentRuntime";
import { attestAgentHistoryResponse, bindAgentHistoryResponse, historicalQueryHistoryContext } from "../src/personalMemoryHistory";
import { captureSummaryQueryScope } from "../src/agent/summaryQueryScope";
import { readStoredQueryWithSources } from "../src/storedQueryRead";
import { readPersonalMemoryWithSources, memorySourcePolicy } from "../src/personalMemorySources";
import { personalMemoryContextRevision } from "../src/personalMemoryContext";
import { runConfirmedToolAction } from "../src/toolRegistry";
import { fileRevision } from "../src/operationIdentity";
vi.mock("obsidian", () => ({ App: class {}, Notice: class {}, TFile: class {}, TFolder: class {}, Modal: class {}, Plugin: class {},
  WorkspaceLeaf: class {}, ItemView: class {}, PluginSettingTab: class {}, Setting: class {}, Platform: { isDesktopApp: true }, setIcon: vi.fn(),
  normalizePath: (path: string) => path.replace(/\\/g, "/"), parseYaml: JSON.parse, stringifyYaml: JSON.stringify,
  requestUrl: () => { throw Error("No provider transport in the fictional follow-up fixture"); } }));
const { LifeOpsStore } = await import("../src/store");
const { DiskVault } = await import("./helpers/diskVault");
const { LifeOpsAi } = await import("../src/ai");
const { default: Plugin } = await import("../src/main");
let root: string, store: StoreHost, vault: InstanceType<typeof DiskVault>, plugin: InstanceType<typeof Plugin>;
const original = "虚构纸样归档只在周三上午09:30可安排25分钟。", corrected = "虚构纸样归档只在周三晚上19:30可安排25分钟。";
const range = { from: "2026-10-26", to: "2026-11-08" };
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-23T03:00:00+08:00"));
  vi.stubGlobal("window", globalThis); root = await mkdtemp(join(tmpdir(), "lifeops-historical-followup-")); vault = new DiskVault(root);
  store = new LifeOpsStore({ vault, workspace: { getLeavesOfType: () => [] } } as unknown as App, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;
  await store.initializeVault();
  store.settings.ai = { ...store.settings.ai, provider: "custom", endpoint: "https://fiction.invalid/chat", model: "synthetic", apiKey: "fictional-key", dataDisclosureAccepted: true };
  store.settings.privacy!.plaintextCredentialStorageAccepted = true;
  plugin = Object.assign(Object.create(Plugin.prototype), { app: store.app, store, settings: store.settings, lifecycleGeneration: 1, unloaded: false,
    ai: new LifeOpsAi(store.settings), updateStatusBar: async () => {}, refreshViews: async () => {}, lifeOpsEvents: { publish: () => {} }, buildSemanticContext: async () => "" });
  for (const date of ["2026-10-28", "2026-11-04"]) await store.appendDaily(date, "日记", "虚构纸样归档连续25分钟完成12张。", "晚", "虚构纸样归档连续25分钟完成12张。");
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); await rm(root, { recursive: true, force: true }); });

it.each([0, 3, 12])("continues the checked two-week query after a real memory correction without reviving the old answer (background records:%s)", async backgroundCount => {
  for (let i = 0; i < backgroundCount; i++) {
    const content = `虚构纸样归档资料${i}：` + "这是一段已核对的虚构背景说明。".repeat(12);
    const path = store.path(store.settings.folders.ideas, `虚构背景${i}.md`); await vault.seed(path, content);
    const record = await store.upsertPersonalMemory({ kind: "core_profile", content, sourceRefs: [{ sourceId: `fictional-crowded-${i}`, path,
      capturedAt: new Date().toISOString(), contentHash: fileRevision(content), extractionVersion: "fictional-v1" }] });
    await store.reviewPersonalMemory(record.id, { decision: "confirm" });
  }
  const source = store.path(store.settings.folders.ideas, "虚构归档安排.md"); await vault.seed(source, original);
  const memory = await store.upsertPersonalMemory({ kind: "user_rule", content: original, sourceRefs: [{ sourceId: "fictional-followup-rule", path: source,
    capturedAt: new Date().toISOString(), contentHash: fileRevision(original), extractionVersion: "fictional-v1" }] });
  await store.reviewPersonalMemory(memory.id, { decision: "confirm" });
  let turns = 0;
  const firstQuestion = "回顾2026年10月26日至11月8日的虚构纸样归档原文，给下周一条安排建议，不修改任务。";
  const oldReply = "虚构旧答复按上午09:30安排纸样，旧模型结论不能在更正后当作新事实。";
  vi.spyOn(LifeOpsAi.prototype, "agentTurnStream").mockImplementation(async (_messages, onText) => {
    if (++turns === 1) return { content: "", toolCalls: [{ id: "fictional-first-week-read", name: "get_summaries", arguments: { level: "week", range, includeOriginals: true } }] };
    const answer = turns === 2 ? "虚构未发布草稿" : oldReply; onText(answer); return { content: answer, toolCalls: [] };
  });
  const first = await plugin.submitAgentMessageStream(firstQuestion, [], () => {}, { source: "text", selfTest: true });
  const user: AgentConversationMessage = { role: "user", content: firstQuestion }, assistant: AgentConversationMessage = { role: "assistant", content: first.reply };
  bindAgentHistoryResponse(first, user, assistant);
  const runtime = new AgentRuntime({ store, refreshViews: async () => {} });
  const proposal = await runtime.executeAiToolCall({ id: "fictional-followup-correct", name: "review_personal_memory", arguments: { memoryId: memory.id, decision: "correct", correctedContent: corrected } }, "kimi");
  expect(proposal.success, proposal.output).toBe(true); expect(await runConfirmedToolAction(proposal.actions[0], { store, refreshViews: async () => {} })).toBe(true);
  const tasks = await vault.bytes(store.taskDbPath()), memories = await vault.bytes(store.personalMemoryPath()); let followupTurns = 0;
  vi.mocked(LifeOpsAi.prototype.agentTurnStream).mockImplementation(async (messages, onText, options) => {
    const sent = JSON.stringify(messages);
    if (++followupTurns === 1) {
      expect(sent).toContain(range.from); expect(sent).toContain(range.to);
      expect(sent).toContain("19:30"); expect(sent).not.toContain(oldReply); expect(sent).not.toContain("09:30");
      // Reproduce the live regression: the provider invents a newer range
      // despite the checked selection surviving the memory correction.
      const modelRange = backgroundCount === 12 ? { from: "2026-11-02", to: "2026-11-12" } : range;
      return { content: "", toolCalls: [backgroundCount === 3
        ? { id: "fictional-reread-as-search", name: "query_vault", arguments: { domain: "journal", operation: "search", query: "纸样归档" } }
        : { id: "fictional-reread-corrected-week", name: "get_summaries", arguments: { level: "week", range: modelRange, includeOriginals: true } }] };
    }
    expect(sent).toContain("2026-10-28"); expect(sent).toContain("2026-11-04"); expect(sent).toContain("19:30");
    if(options?.toolChoice==='none') {
      expect(options.reasoning).toBe('disabled');
      expect(options.maxTokens).toBe(4096);
      expect(options.tools).toEqual([]);
      expect(options.preferFinite).toBe(true);
    }
    const answer = followupTurns === 2 ? "虚构未发布新草稿" : "10月28日与11月4日均记录连续25分钟归档。下一步（建议）：按当前已更正记忆，周三19:30留25分钟；未创建任务。";
    onText(answer); return { content: answer, toolCalls: [] };
  });
  const result = await plugin.submitAgentMessageStream("按刚更正的时间，接着这两周给一条下周建议，不创建任务。", [user, assistant], () => {}, { source: "text", selfTest: true });
  expect(result.reply).toContain("19:30"); expect(result.reply).not.toContain("09:30"); expect(result.actions).toEqual([]); expect(result.receipts).toEqual([]);
  expect(followupTurns).toBe(3); expect(await vault.bytes(store.taskDbPath())).toBe(tasks); expect(await vault.bytes(store.personalMemoryPath())).toBe(memories);
});

async function checkedPair(ranges = [range]) {
  const scopes = [];
  for (const selection of ranges) {
    const read = await readStoredQueryWithSources(store, "get_summaries", { level: "week", range: selection, includeOriginals: true });
    try { scopes.push(captureSummaryQueryScope(store, read)!); } finally { read.dispose(); }
  }
  const records = (await readPersonalMemoryWithSources(store)).records;
  const user: AgentConversationMessage = { role: "user", content: "虚构原问题，包含不应继续提供的旧事实。" };
  const assistant: AgentConversationMessage = { role: "assistant", content: "虚构旧模型推断，不能重用为当前结论。" };
  const response = attestAgentHistoryResponse({ reply: assistant.content, actions: [] }, store, personalMemoryContextRevision(records), memorySourcePolicy(store), user.content, scopes);
  bindAgentHistoryResponse(response, user, assistant); return { history: [user, assistant], user, assistant, response, scopes };
}

it.each(['按刚更正的时间，接着这两周的虚构纸样归档给一条下周建议，不创建任务。','继续这两个星期的回顾。','用刚才的日期范围继续归档回顾。'])('rereads owned originals when a follow-up model returns no tools: %s',async message=>{
 const {history}=await checkedPair(),before=await vault.bytes(store.taskDbPath()),sent:string[]=[];let turns=0;
 vi.spyOn(LifeOpsAi.prototype,'agentTurnStream').mockImplementation(async(messages,onText)=>{
   turns++;sent.push(JSON.stringify(messages));
   const content=turns===1?'我只看到当前设定，没有两周的原文依据。':'10月28日、11月4日的原文都记录虚构纸样归档连续25分钟完成12张；未创建任务。';onText(content);return{content,toolCalls:[]};
 });
 const result=await plugin.submitAgentMessageStream(message,history,()=>{},{source:'text',selfTest:true});
 expect(turns).toBe(2);expect(sent[1]).toContain('2026-10-28');expect(sent[1]).toContain('2026-11-04');expect(sent[1]).toContain('完成12张');expect(result.reply).not.toContain('没有两周');expect(result.actions).toEqual([]);expect(result.receipts).toEqual([]);expect(await vault.bytes(store.taskDbPath())).toBe(before);
});

it.each(['unowned','new-date'])('does not prefetch a historical range from %s context',async kind=>{
 const pair=await checkedPair(),history=kind==='unowned'?pair.history.map(({role,content})=>({role,content})):pair.history;
 let turns=0;const execute=vi.spyOn(plugin as any,'executeToolCalls');vi.spyOn(LifeOpsAi.prototype,'agentTurnStream').mockImplementation(async()=>{turns++;return{content:'虚构：尚无本轮原文查询结果。',toolCalls:[]};});
 await plugin.submitAgentMessageStream(kind==='new-date'?'改查2026-11-09到2026-11-12，不沿用旧范围。':'接着这两周的虚构纸样归档继续说。',history,()=>{},{source:'text',selfTest:true});expect(turns).toBe(1);expect(execute).not.toHaveBeenCalled();
});

it("retains both sides of a prior comparison as dates only, after its read handles are disposed", async () => {
  const other = { from: "2026-10-12", to: "2026-10-25" }, { history } = await checkedPair([other, range]);
  const before = JSON.stringify(history), context = historicalQueryHistoryContext(history, store);
  for (const value of [other.from, other.to, range.from, range.to]) expect(context).toContain(value);
  for (const value of [history[0].content, history[1].content, "完成12张", "2026-10-28晚.md"]) expect(context).not.toContain(value);
  expect(JSON.stringify(history)).toBe(before); expect(context).toContain("本轮必须按当前权限重新读取");
});
it.each(["privacy", "folders", "external", "vault"])("does not continue dates across a changed %s boundary", async change => {
  const { history } = await checkedPair();
  if (change === "privacy") store.settings.privacy!.excludedVaultPrefixes = [store.settings.folders.dailyRoot];
  if (change === "folders") store.settings.folders.dailyRoot = "虚构另一个日记目录";
  if (change === "external") store.settings.externalVaults = [{ id: "fictional-other", enabled: true } as never];
  if (change === "vault") store = { ...store, app: { ...store.app, vault: {} } } as StoreHost;
  expect(historicalQueryHistoryContext(history, store)).toBe("");
});
it.each(["user", "assistant", "json", "missing", "newer-unproven"])("rejects %s history rather than falling back to a possibly wrong old range", async change => {
  const { history } = await checkedPair();
  if (change === "user") history[0] = { ...history[0], content: history[0].content + "外部修改" };
  if (change === "assistant") history[1] = { ...history[1], content: history[1].content + "外部修改" };
  if (change === "json") history.splice(0, history.length, ...JSON.parse(JSON.stringify(history)));
  if (change === "missing") history.shift();
  if (change === "newer-unproven") history.push({ role: "user", content: "虚构后来查过另一个月。" }, { role: "assistant", content: "虚构未经核对回复。" });
  expect(historicalQueryHistoryContext(history, store)).toBe("");
});
it("accepts original checked objects through an ordinary UI spread, but never public-shaped date proof", async () => {
  const { history, user, assistant } = await checkedPair();
  expect(historicalQueryHistoryContext(history.map(row => ({ ...row })), { ...store } as StoreHost)).toContain(range.from);
  const response = attestAgentHistoryResponse({ reply: assistant.content, actions: [] }, store, personalMemoryContextRevision([]), memorySourcePolicy(store), user.content,
    [{ level: "week", range }]);
  const copied = history.map(({ role, content }) => ({ role, content })); bindAgentHistoryResponse(response, copied[0], copied[1]);
  expect(historicalQueryHistoryContext(copied, store)).toBe("");
});
it("does not mistake a copied summary or an unrelated owned query for an original summary selection", async () => {
  const read = await readStoredQueryWithSources(store, "get_summaries", { level: "week", range });
  try { expect(captureSummaryQueryScope(store, { ...read })).toBeUndefined(); }
  finally { read.dispose(); }
  expect(captureSummaryQueryScope(store, read)).toBeUndefined();
  const other = await readStoredQueryWithSources(store, "query_projects", {});
  try { expect(captureSummaryQueryScope(store, other)).toBeUndefined(); } finally { other.dispose(); }
});

it.each(['tasks','memory'])('renews owned historical originals when the model chooses only %s facts',async domain=>{
  const {history}=await checkedPair(),before=await vault.bytes(store.taskDbPath());let turns=0;
  vi.spyOn(LifeOpsAi.prototype,'agentTurnStream').mockImplementation(async(messages,onText)=>{
    if(++turns===1)return{content:'',toolCalls:domain==='tasks'?[{id:'fictional-misdirected-stats',name:'get_stats',arguments:{domain:'tasks',range:{from:range.from,to:range.to}}}]:[{id:'fictional-misdirected-memory',name:'query_vault',arguments:{domain:'memory',operation:'get',query:'纸样归档'}}]};
    const sent=JSON.stringify(messages);expect(sent).toContain('2026-10-28');expect(sent).toContain('2026-11-04');expect(sent).toContain('完成12张');const answer=turns===2?'虚构未发布猜测：没有任务等于整周没做。':'10月28日与11月4日原文均记录完成12张；任务统计不能代替这两天的原话。';onText(answer);return{content:answer,toolCalls:[]};
  });
  const result=await plugin.submitAgentMessageStream('接着这两周的虚构纸样归档解释原文，不修改任务。',history,()=>{},{source:'text',selfTest:true});expect(result.reply).toContain('10月28日');expect(result.reply).not.toContain('整周没做');expect(turns).toBe(3);expect(result.actions).toEqual([]);expect(result.receipts).toEqual([]);expect(await vault.bytes(store.taskDbPath())).toBe(before);
});
it.each(['forged','new-range'])('does not automatically renew the old period for %s continuity',async kind=>{
  let {history}=await checkedPair();if(kind==='forged')history=JSON.parse(JSON.stringify(history));let turns=0;
  vi.spyOn(LifeOpsAi.prototype,'agentTurnStream').mockImplementation(async messages=>{
    if(++turns===1)return{content:'',toolCalls:[{id:'fictional-unbound-stats',name:'get_stats',arguments:{domain:'tasks',range:{from:'2026-11-16',to:'2026-11-22'}}}]};
    expect(JSON.stringify(messages.filter(m=>m.role==='tool'))).not.toContain('完成12张');return{content:'虚构：只取得所选任务统计。',toolCalls:[]};
  });
  await plugin.submitAgentMessageStream(kind==='new-range'?'不用这两周，改查2026年11月16日至22日的任务统计。':'接着这两周说明任务统计。',history,()=>{},{source:'text',selfTest:true});expect(turns).toBe(2);
});

const historicalInterruption=async()=>{
 const{ProviderRunFailure,providerRunStart}=await import('../src/providerRun');const run=providerRunStart(store.settings.ai);run.status='failed';
 return new ProviderRunFailure(run,'response_incomplete');
};
it('retains fresh owned historical sources and the corrected rule after an empty first provider response, without another model request',async()=>{
 const runtime=new AgentRuntime({store,refreshViews:async()=>{}});
 await runtime.executeAiToolCall({id:'fictional-rescue-rule',name:'append_memory_note',arguments:{content:corrected,category:'rules',explicit:true}},'kimi','请记住：'+corrected);
 const{history}=await checkedPair();const paths=[store.taskDbPath(),store.taskMirrorPath(),store.personalMemoryPath(),store.path(store.settings.folders.aiReports,'Operations','operation-ledger.json')];
 const before=await Promise.all(paths.map(path=>store.readPath(path)));const error=await historicalInterruption();
 const model=vi.spyOn(LifeOpsAi.prototype,'agentTurnStream').mockRejectedValue(error);
 const result=await plugin.submitAgentMessageStream('按刚更正的时间，接着这两周给一条建议，不创建任务。',history,()=>{},{source:'text',selfTest:true});
 expect(model).toHaveBeenCalledOnce();expect(result.reply).toContain('模型响应未完成');expect(result.reply).toContain('2026-10-26');expect(result.reply).toContain('2026-11-08');
 expect(result.reply).toContain('12张');expect(result.reply).toContain('19:30');expect(result.reply).not.toContain('09:30');expect(result.reply).toContain('具体建议尚未完成');
 expect(result.actions).toEqual([]);expect(result.receipts??[]).toEqual([]);expect(await Promise.all(paths.map(path=>store.readPath(path)))).toEqual(before);
});
it.each(['unowned','new-dates','privacy','cancel'] as const)('does not reuse old source authority after %s when the provider fails before its first tool',async mode=>{
 const{history}=await checkedPair();const error=await historicalInterruption(),controller=new AbortController();
 vi.spyOn(LifeOpsAi.prototype,'agentTurnStream').mockImplementation(async()=>{
  if(mode==='privacy')store.settings.privacy!.excludedVaultPrefixes=[store.settings.folders.dailyRoot];
  if(mode==='cancel')controller.abort(new DOMException('Cancelled','AbortError'));
  throw error;
 });
 const message=mode==='new-dates'?'只看2026年11月16日至22日，给一条建议。':'继续这两周的归档回顾。';
 const before=await Promise.all([store.taskDbPath(),store.personalMemoryPath()].map(path=>store.readPath(path)));
 await expect(plugin.submitAgentMessageStream(message,mode==='unowned'?structuredClone(history):history,()=>{},{source:'text',selfTest:true,signal:controller.signal})).rejects.toThrow();
 expect(await Promise.all([store.taskDbPath(),store.personalMemoryPath()].map(path=>store.readPath(path)))).toEqual(before);
});
it('never replays an already committed task to recover historical text after a model failure',async()=>{
 const{history}=await checkedPair(),error=await historicalInterruption();let turns=0;
 vi.spyOn(LifeOpsAi.prototype,'agentTurnStream').mockImplementation(async()=>{
  if(++turns===1)return{content:'',toolCalls:[{id:'fictional-once-before-interruption',name:'create_task',arguments:{title:'虚构只保存一次的纸袋任务',date:'今天'}}]};throw error;
 });
 const result=await plugin.submitAgentMessageStream('新增虚构只保存一次的纸袋任务，接着这两周的回顾。',history,()=>{},{source:'text',selfTest:true});
 expect((await store.readTaskDb()).tasks.filter(task=>task.title==='虚构只保存一次的纸袋任务')).toHaveLength(1);expect(result.receipts).toHaveLength(1);expect(result.reply).not.toContain('重新核对的资料');
});

it('keeps only owned dates after recovery so the next follow-up rereads edited originals',async()=>{
 const{history}=await checkedPair(),error=await historicalInterruption();
 const question='继续这两周的归档回顾。';
 const model=vi.spyOn(LifeOpsAi.prototype,'agentTurnStream').mockRejectedValue(error);
 const recovered=await plugin.submitAgentMessageStream(question,history,()=>{},{source:'text',selfTest:true});
 const user:AgentConversationMessage={role:'user',content:question},assistant:AgentConversationMessage={role:'assistant',content:recovered.reply};
 // The UI can retain just the final pair after clipping older conversation.
 bindAgentHistoryResponse(recovered,user,assistant);history.splice(0,history.length,user,assistant);
 const context=historicalQueryHistoryContext(history,store);
 expect(context).toContain(range.from);expect(context).toContain(range.to);
 expect(context).not.toContain('完成12张');
 const note=vault.getMarkdownFiles().find(file=>file.path.endsWith('2026-10-28晚.md'))!;
 await vault.modify(note,(await vault.read(note)).replaceAll('完成12张','完成17张'));
 const paths=[store.taskDbPath(),store.personalMemoryPath()];const before=await Promise.all(paths.map(path=>store.readPath(path)));
 model.mockRejectedValue(await historicalInterruption());
 const next=await plugin.submitAgentMessageStream('接着刚才这两周继续，不修改任务。',history,()=>{},{source:'text',selfTest:true});
 expect(next.reply).toContain('完成17张');expect(next.reply).toContain('2026\\-11\\-04');
 expect(next.actions).toEqual([]);expect(next.receipts??[]).toEqual([]);expect(model).toHaveBeenCalledTimes(2);
 expect(await Promise.all(paths.map(path=>store.readPath(path)))).toEqual(before);
 const copied=history.map(({role,content})=>({role,content}));expect(historicalQueryHistoryContext(copied,store)).toBe('');
});

it('keeps freshly recomputed task counts alongside original notes when a follow-up model stops after its statistics read',async()=>{
 const one=await store.createTask({title:'虚构第一周纸袋',date:'2026-10-28'});
 await store.updateTask(one.id,row=>({...row,status:'completed',completedAt:'2026-10-28T20:00:00+08:00'}));
 const two=await store.createTask({title:'虚构第二周纸盒',date:'2026-11-04'});
 const{history}=await checkedPair(),error=await historicalInterruption();let turns=0;
 const paths=[store.taskDbPath(),store.taskMirrorPath(),store.personalMemoryPath(),store.path(store.settings.folders.aiReports,'Operations','operation-ledger.json')];let afterEdit:string[]=[];
 vi.spyOn(LifeOpsAi.prototype,'agentTurnStream').mockImplementation(async()=>{
  if(++turns===1)return{content:'',toolCalls:[{id:'fictional-history-and-task-counts',name:'get_stats',arguments:{domain:'tasks',range}}]};
  // Another legitimate local edit finished after the model's statistics read.
  await store.updateTask(two.id,row=>({...row,status:'completed',completedAt:'2026-11-04T20:00:00+08:00'}));afterEdit=await Promise.all(paths.map(path=>store.readPath(path)));throw error;
 });
 const result=await plugin.submitAgentMessageStream('接着这两周的归档回顾，保留任务完成数，不修改任务。',history,()=>{},{source:'text',selfTest:true});
 expect(result.reply).toContain('完成12张');expect(result.reply).toContain('计划 2 项，计划内完成 2 项');
 expect(result.reply).toContain('计划完成率 100%');expect(result.reply).not.toContain('计划完成率 50%');
 expect(result.reply).toContain('未登记情况未知');expect(result.actions).toEqual([]);expect(result.receipts??[]).toEqual([]);expect(turns).toBe(2);
 expect((await store.readTaskDb()).tasks).toHaveLength(2);
 expect(await Promise.all(paths.map(path=>store.readPath(path)))).toEqual(afterEdit);
});

it('withholds unstable counts while keeping freshly read originals during interrupted historical recovery',async()=>{
 const one=await store.createTask({title:'虚构已完成纸袋',date:'2026-10-28'});
 await store.updateTask(one.id,row=>({...row,status:'completed',completedAt:'2026-10-28T20:00:00+08:00'}));
 const two=await store.createTask({title:'虚构同步更新纸盒',date:'2026-11-04'});
 const{history}=await checkedPair(),error=await historicalInterruption();let turns=0,armed=false,changed='';
 const read=vault.read.bind(vault);vi.spyOn(vault,'read').mockImplementation(async file=>{
  const text=await read(file);
  if(armed&&file.path.endsWith('2026-10-28晚.md')){
   armed=false;await store.updateTask(two.id,row=>({...row,status:'completed',completedAt:'2026-11-04T20:00:00+08:00'}));changed=await store.readPath(store.taskDbPath());
  }return text;
 });
 vi.spyOn(LifeOpsAi.prototype,'agentTurnStream').mockImplementation(async()=>{
  if(++turns===1)return{content:'',toolCalls:[{id:'fictional-history-stats-race',name:'get_stats',arguments:{domain:'tasks',range}}]};armed=true;throw error;
 });
 const result=await plugin.submitAgentMessageStream('接着这两周回顾原文和任务完成数，不修改任务。',history,()=>{},{source:'text',selfTest:true});
 expect(changed).not.toBe('');expect(result.reply).toContain('完成12张');expect(result.reply).toContain('登记统计尚未稳定核对完成');
 expect(result.reply).not.toContain('计划完成率');expect(result.actions).toEqual([]);expect(result.receipts??[]).toEqual([]);expect(turns).toBe(2);
 expect(await store.readPath(store.taskDbPath())).toBe(changed);
});

it('retains checked habit samples and separate-currency trade counts with the recovered historical notes',async()=>{
 const selected={from:'2026-11-02',to:'2026-11-08'};
 const habit=await store.createHabit({name:'虚构纸样整理',frequencyUnit:'week',frequencyInterval:1,targetCount:4,startDate:selected.from});
 await store.recordHabitStatus(habit.id,'done',selected.from);
 const runtime=new AgentRuntime({store,refreshViews:async()=>{}});
 const saved=await runtime.executeAiToolCall({id:'fictional-history-currencies',name:'record_trade',arguments:{trades:[
  {market:'A股',symbol:'FICT-CNY',direction:'long',openedAt:'2026-11-04',pnl:120},
  {market:'美股',symbol:'FICT-USD',direction:'long',openedAt:'2026-11-05',pnl:-30},
  {market:'美股',symbol:'FICT-UNKNOWN',direction:'long',openedAt:'2026-11-06'}
 ]}},'kimi');expect(saved.success,saved.output).toBe(true);
 const{tradeDatabasePath}=await import('../src/features/trading/persistence');
 const paths=[store.habitDbPath(),tradeDatabasePath(store.settings.folders),store.taskDbPath()];const before=await Promise.all(paths.map(path=>store.readPath(path)));
 const{history}=await checkedPair(),error=await historicalInterruption();let turns=0;
 vi.spyOn(LifeOpsAi.prototype,'agentTurnStream').mockImplementation(async()=>{
  if(++turns===1)return{content:'',toolCalls:['habits','trades'].map(domain=>({id:'fictional-history-'+domain,name:'get_stats',arguments:{domain,range}}))};throw error;
 });
 const result=await plugin.submitAgentMessageStream('接着这两周原文回顾，也保留习惯与交易登记，不创建任务。',history,()=>{},{source:'text',selfTest:true});
 for(const value of ['完成12张','虚构纸样整理','25%','120 元','-30 美元','另 1 笔盈亏未知'])expect(result.reply).toContain(value);
 expect(result.reply).not.toContain('净盈亏 90');expect(result.actions).toEqual([]);expect(result.receipts??[]).toEqual([]);expect(turns).toBe(2);
 expect(await Promise.all(paths.map(path=>store.readPath(path)))).toEqual(before);
});

it('keeps cross-week statistics on the owned dates when the model invents a newer range',async()=>{
 const one=await store.createTask({title:'虚构前周已完成纸袋',date:'2026-10-28'});
 await store.updateTask(one.id,row=>({...row,status:'completed',completedAt:'2026-10-28T20:00:00+08:00'}));
 await store.createTask({title:'虚构后周未完成纸盒',date:'2026-11-04'});
 const{history}=await checkedPair(),error=await historicalInterruption();let turns=0;
 vi.spyOn(LifeOpsAi.prototype,'agentTurnStream').mockImplementation(async()=>{
  if(++turns===1)return{content:'',toolCalls:[{id:'fictional-statistics-newer-dates',name:'get_stats',arguments:{domain:'tasks',range:{from:'2026-11-02',to:'2026-11-12'}}}]};throw error;
 });
 const result=await plugin.submitAgentMessageStream('接着这两周的原文和任务完成数，给我一份回顾，不修改任务。',history,()=>{},{source:'text',selfTest:true});
 expect(result.reply).toContain('完成12张');expect(result.reply).toContain('计划 2 项，计划内完成 1 项');expect(result.reply).toContain('计划完成率 50%');
 expect(result.reply).not.toContain('2026-11-12');expect(result.reply).not.toContain('计划完成率 0%');expect(turns).toBe(2);
 const ledger=JSON.parse(await store.readPath(store.path(store.settings.folders.aiReports,'Operations','operation-ledger.json')));
 const stats=ledger.records.filter((row:{toolName:string})=>row.toolName==='get_stats');expect(stats).toHaveLength(1);expect(JSON.parse(stats[0].result.output).range).toEqual(range);
 expect(result.actions).toEqual([]);expect(result.receipts??[]).toEqual([]);expect((await store.readTaskDb()).tasks).toHaveLength(2);
});
