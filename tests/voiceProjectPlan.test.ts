import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { App } from "obsidian";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { VoiceSessionController } from "../src/voice/voiceRuntime";
import type { StoreHost } from "../src/store/settingsSlice";
import type { AiToolCall } from "../src/ai";

vi.mock("obsidian", () => ({ App: class {}, Plugin: class {}, TFile: class {}, TFolder: class {},
  Modal: class { open() {} }, Notice: class {}, ItemView: class {}, PluginSettingTab: class {}, Setting: class {},
  Platform: { isDesktopApp: true }, setIcon: vi.fn(), normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/{2,}/g, "/"),
  requestUrl: () => { throw Error("No network in voice project-plan tests"); } }));
vi.mock("ws", () => ({ default: class { constructor() { throw Error("No network in voice project-plan tests"); } } }));
const { LifeOpsStore } = await import("../src/store");
const { DiskVault } = await import("./helpers/diskVault");
const { default: LifeOpsPlugin } = await import("../src/main");
const { AgentRuntime } = await import("../src/agentRuntime");
const { ProjectJobRunner } = await import("../src/projectJobRunner");
const { TaskPlanReviewRegistry } = await import("../src/taskPlanReviewRegistry");
const { runConfirmedToolAction, agentToolsForRealtime } = await import("../src/toolRegistry");
const { executeOmniE2eToolCall, buildOmniE2eInstructions, finishOmniE2eVoiceTurn, handleOmniE2eAudioDelta, handleOmniE2eAudioDone, fallbackOmniResponseToBrain } = await import("../src/voice/voiceRealtime");
const { ProjectJobRepository } = await import("../src/projectJobRepository");
const { emptyPersonalMemoryDocument, createPersonalMemory, reviewPersonalMemoryRecord } = await import("../src/personalMemory");

let root: string, vault: InstanceType<typeof DiskVault>, store: StoreHost, plugin: any;
let runner: InstanceType<typeof ProjectJobRunner>, registry: InstanceType<typeof TaskPlanReviewRegistry>, projectId: string;
const message = "给纯虚构项目安排明天09:30核对银杏清单，下一步改为核对纯虚构蓝色清单。先给我完整卡。";
const clock = () => new Date("2026-10-06T03:00:00Z");
beforeEach(async () => {
  vi.stubGlobal("window", globalThis);
  root = await mkdtemp(join(tmpdir(), "lifeops-voice-project-plan-")); vault = new DiskVault(root);
  const app = { vault, workspace: { getLeavesOfType: vi.fn(() => []) } } as unknown as App;
  store = new LifeOpsStore(app, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;
  await store.initializeVault();
  await vault.seed(store.personalMemoryPath(), JSON.stringify(emptyPersonalMemoryDocument()));
  const runtime = new AgentRuntime({ store, refreshViews: async () => {} });
  const commands: Array<Record<string, unknown>> = [
    { kind: "save_goal", input: { title: "纯虚构学习目标", reason: "虚构验证", successCriteria: "核对原文" } },
    { kind: "save_project", input: { goalId: "", title: "纯虚构项目", state: "started", nextStep: "纯虚构原下一步" } }
  ];
  for (const [index, command] of commands.entries()) {
    if (command.kind === "save_project") (command.input as Record<string, unknown>).goalId = (await store.getProjectSnapshot()).document.goals[0].id;
    const id = `fixture-project-plan-${index}`;
    const result = await runtime.executeAiToolCall({ id, name: "propose_project_change", arguments: { command } }, "kimi", "全虚构夹具");
    expect(result.success, result.output).toBe(true); await runConfirmedToolAction(result.actions[0], { store, refreshViews: async () => {} });
  }
  projectId = (await store.getProjectSnapshot()).document.projects[0].id;
  runner = new ProjectJobRunner(store, runtime, clock);
  registry = new TaskPlanReviewRegistry(store, () => runner, () => {}, clock);
  plugin = Object.assign(Object.create(LifeOpsPlugin.prototype), { app, store, settings: store.settings,
    refreshViews: vi.fn(async () => {}), projectJobRunner: runner, taskPlanReviews: registry,
    unloaded: false, lifecycleGeneration: 0 });
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }); });
function viewFor(transcript = message) {
  const runtime = new VoiceSessionController({ provider: "offline-synthetic" }); runtime.connect(); runtime.connected();
  runtime.beginTurn({ route: "e2e", transcript }); runtime.transitionTurn("routing", "test"); runtime.transitionTurn("generating", "test");
  return { viewClosed: false, agentTextRequestGeneration: 1, agentVoicePipelineGeneration: 1,
    agentVoiceRuntime: runtime, controller: plugin, pendingAgentActions: [], agentInput: "下一轮未提交的不同缓冲区",
    agentOmniE2eReply: "", agentReply: "", agentOmniE2eAssistantIndex: -1, refreshAgentSuggestions: vi.fn() } as any;
}
function call(id = "voice-work-plan"): AiToolCall {
  return { id, name: "propose_project_work_plan", arguments: { projectId,
    tasks: [{ title: "核对银杏清单", date: "明天", time: "09:30", category: "虚构学习" }],
    nextStep: { text: "核对纯虚构蓝色清单" } } };
}
function stop(view: any) { view.agentVoiceRuntime.interrupt("user interrupted"); }

it("advertises only the bounded project-plan proposal and makes click confirmation explicit", () => {
  const tools = agentToolsForRealtime();
  expect(tools.find(t => t.name === "propose_project_work_plan")).toMatchObject({ type: "function" });
  expect(tools.some(t => t.name === "set_project_next_step" || t.name === "propose_task_plan")).toBe(false);
  expect(buildOmniE2eInstructions()).toContain("propose_project_work_plan");
  expect(buildOmniE2eInstructions()).toContain("点击确认");
});
it("routes the active transcript to a readonly complete card, then reuses the durable confirmed Job", async () => {
  const view = viewFor(), before = await store.getProjectSnapshot(), writes = vault.writes.length;
  const reply = await executeOmniE2eToolCall(view, call());
  expect(reply).toContain("尚未保存"); expect(vault.writes.length).toBe(writes);
  expect((await new ProjectJobRepository(store).load()).document.job).toBeNull();
  const action = view.pendingAgentActions[0];
  expect(action).toMatchObject({ type: "task_plan" });
  expect(action.content).toContain("原下一步：纯虚构原下一步"); expect(action.content).toContain("核对纯虚构蓝色清单");
  expect(action.content).not.toContain(projectId);
  expect(() => registry.start({ ...action, content: action.content + "伪造安排" })).toThrow();
  expect(vault.writes.length).toBe(writes);
  await plugin.executeAgentAction(action);
  const current = await store.getProjectSnapshot(), job = (await new ProjectJobRepository(store).load()).document.job!;
  expect(current.tasks).toHaveLength(1); expect(current.tasks[0]).toMatchObject({ title: "核对银杏清单", date: "2026-10-07", time: "09:30", status: "active" });
  expect(current.document.projects[0]).toMatchObject({ state: "started", nextStep: "核对纯虚构蓝色清单", taskIds: [current.tasks[0].id] });
  expect(current.document.goals).toEqual(before.document.goals); expect(job.userMessage).toBe(message);
  expect(job.steps.map(step => step.toolName)).toEqual(["create_task", "set_project_next_step"]);
  expect(job.status).toBe("completed"); expect(() => registry.start(action)).toThrow();
});
it.each(["interrupt", "replacement", "close"])("leaves no private plan capability when %s happens during preparation", async kind => {
  const view = viewFor(), original = runner.prepareWorkPlan.bind(runner), writes = vault.writes.length;
  vi.spyOn(runner, "prepareWorkPlan").mockImplementation(async (...args) => {
    const review = await original(...args);
    if (kind === "interrupt") stop(view);
    if (kind === "replacement") view.agentVoiceRuntime = viewFor().agentVoiceRuntime;
    if (kind === "close") { view.viewClosed = true; view.agentTextRequestGeneration += 1; }
    return review;
  });
  expect(await executeOmniE2eToolCall(view, call())).toBe("");
  expect(view.pendingAgentActions).toEqual([]); expect((registry as any).reviews.size).toBe(0);
  expect(vault.writes.length).toBe(writes); expect((await new ProjectJobRepository(store).load()).document.job).toBeNull();
});
it("preserves a previously delivered card when a retried call becomes stale", async () => {
  const view = viewFor(); await executeOmniE2eToolCall(view, call());
  const originalCard = view.pendingAgentActions[0], original = registry.prepareWorkPlan.bind(registry);
  vi.spyOn(registry, "prepareWorkPlan").mockImplementation(async (...args) => { const action = await original(...args); stop(view); return action; });
  expect(await executeOmniE2eToolCall(view, call())).toBe(""); expect(view.pendingAgentActions).toEqual([originalCard]);
  await plugin.executeAgentAction(originalCard); expect((await store.getProjectSnapshot()).tasks).toHaveLength(1);
});
it("never dispatches an inactive turn or a tool outside the advertised Realtime set", async () => {
  const view = viewFor(), spy = vi.spyOn(plugin, "executeAgentToolCall"), writes = vault.writes.length;
  expect(await executeOmniE2eToolCall(view, { ...call(), name: "propose_task_plan" })).toContain("暂不支持");
  expect(spy).not.toHaveBeenCalled(); stop(view);
  expect(await executeOmniE2eToolCall(view, call())).toBe(""); expect(spy).not.toHaveBeenCalled(); expect(vault.writes.length).toBe(writes);
});
it("rejects malformed model fields without creating a plan or saving facts", async () => {
  const view = viewFor(), malformed = call("bad-voice-plan"), writes = vault.writes.length;
  malformed.arguments.executeNow = true;
  expect(await executeOmniE2eToolCall(view, malformed)).toContain("核对"); expect(view.pendingAgentActions).toEqual([]);
  expect((registry as any).reviews.size).toBe(0); expect(vault.writes.length).toBe(writes);
});
it("binds a single voice tool's cloned arguments before an asynchronous memory read", async () => {
  await vault.seed(store.dailyNotePath("2026-10-05", "早"), "纯虚构既有晨记");
  const view = viewFor("读一下纯虚构昨天的晨记"), before = await store.getProjectSnapshot();
  const original = vault.read.bind(vault), tool: AiToolCall = { id: "voice-query-clone", name: "query_vault",
    arguments: { domain: "journal", operation: "get", date: "2026-10-05", period: "早" } }; let mutated = false;
  vi.spyOn(vault, "read").mockImplementation(async file => {
    const raw = await original(file);
    if (!mutated && file.path === store.personalMemoryPath()) { mutated = true; tool.arguments.date = "2026-10-04"; }
    return raw;
  });
  expect(await executeOmniE2eToolCall(view, tool)).toContain("纯虚构既有晨记"); expect(mutated).toBe(true);
  expect(await vault.bytes(store.dailyNotePath("2026-10-05", "早"))).toBe("纯虚构既有晨记");
  const after = await store.getProjectSnapshot(); expect(after.document).toEqual(before.document); expect(after.tasks).toEqual(before.tasks);
});
it("discards a newly prepared token on card ID collision while preserving the displayed old card", async () => {
  const view = viewFor(), writes = vault.writes.length;
  const original = { id: "proposal:voice-work-plan:0", type: "create_task", title: "旧卡", content: "用户原卡", description: "原卡", date: "2026-10-06" };
  view.pendingAgentActions = [original]; await executeOmniE2eToolCall(view, call());
  expect(view.pendingAgentActions).toEqual([original]); expect((registry as any).reviews.size).toBe(0);
  expect(vault.writes.length).toBe(writes);
});
it("refuses to deliver a reused unseen card withdrawn while its baseline is being read", async () => {
  const prepare = () => registry.prepareWorkPlan([{ title: "核对银杏清单", date: "明天", time: "09:30", category: "虚构学习" }],
    message, [], "reused-unseen-proposal", projectId, { text: "核对纯虚构蓝色清单" });
  const unseen = await prepare(), writes = vault.writes.length, original = vault.read.bind(vault);
  let release!: () => void, announce!: () => void, held = false;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { announce = resolve; });
  vi.spyOn(vault, "read").mockImplementation(async file => {
    const raw = await original(file);
    if (!held && file.path === store.personalMemoryPath()) { held = true; announce(); await gate; }
    return raw;
  });
  const reused = prepare(); await started;
  registry.dismiss(unseen); release();
  await expect(reused).rejects.toThrow("失效");
  expect((registry as any).reviews.size).toBe(0); expect(vault.writes.length).toBe(writes);
});
it.each(["forget", "read_failure"] as const)("withholds an unseen old-memory card after final reply wait encounters %s", async kind => {
  const journal = store.dailyNotePath("2026-10-05", "早"); await vault.seed(journal, "核对银杏清单。");
  const record = createPersonalMemory({ kind: "core_profile", content: "核对银杏清单", sourceRefs: [
    { sourceId: "fictional-plan-source", path: journal, capturedAt: "2026-10-05T03:00:00Z" } ] });
  await vault.seed(store.personalMemoryPath(), JSON.stringify({ ...emptyPersonalMemoryDocument(),
    records: reviewPersonalMemoryRecord([record], record.id, { decision: "confirm" }) }));
  const view = viewFor(), before = await store.getProjectSnapshot();
  const prepare = registry.prepareWorkPlan.bind(registry), read = vault.read.bind(vault);
  let prepared = false, changed = false;
  vi.spyOn(registry, "prepareWorkPlan").mockImplementation(async (...args) => { const action = await prepare(...args); prepared = true; return action; });
  vi.spyOn(vault, "read").mockImplementation(async file => {
    if (prepared && file.path === store.personalMemoryPath()) {
      if (kind === "read_failure") throw Error("Fictional memory read became unavailable");
      if (!changed) { changed = true; await store.reviewPersonalMemory(record.id, { decision: "forget" }); }
    }
    return read(file);
  });
  const reply = await executeOmniE2eToolCall(view, call());
  expect(prepared).toBe(true); expect(reply).not.toContain("核对银杏清单");
  expect(view.pendingAgentActions).toEqual([]); expect((registry as any).reviews.size).toBe(0);
  const current = await store.getProjectSnapshot(); expect(current.document).toEqual(before.document); expect(current.tasks).toEqual(before.tasks);
  expect((await new ProjectJobRepository(store).load()).document.job).toBeNull(); expect(await vault.bytes(journal)).toBe("核对银杏清单。");
  if (kind === "forget") expect(JSON.parse(await vault.bytes(store.personalMemoryPath())).records.find((r: any) => r.id === record.id).status).toBe("forgotten");
});

function finishable(view: any) {
  Object.assign(plugin.settings.realtimeVoice, {provider:'qwen-omni-realtime',mode:'omni-e2e',speakReplies:false});
  Object.assign(view,{agentOmniE2eAssistantIndex:0,agentMessages:[{role:'assistant',content:''}],agentVoiceTrace:{},
    markVoiceTrace:vi.fn(),setAgentBusy:vi.fn(),appendAgentQualityLog:vi.fn(async()=>{}),refreshAgentSurfaceState:vi.fn(),
    voiceSession:{inputQueue:[]},currentVoiceMessageText:()=>'',resetCurrentVoiceTurnDraft:vi.fn(),transitionVoiceSession:vi.fn()});
  plugin.appendAgentConversation=vi.fn(async()=>{});return view;
}
it('keeps failed project proposal truth when a real-model-shaped call is followed by a false card claim',async()=>{
  const view=finishable(viewFor()),before=await store.getProjectSnapshot(),modelCall=call('service-bad-source');
  modelCall.arguments.nextStep={text:'核对纯虚构蓝色清单',source:null};
  const reply=await executeOmniE2eToolCall(view,modelCall);
  expect(reply).toContain('项目安排卡未生成');expect(reply).toContain('尚未保存');expect(view.pendingAgentActions).toEqual([]);
  await finishOmniE2eVoiceTurn(view,'好的，已为你生成待确认卡，需要点击确认。');
  expect(view.agentReply).toContain('项目安排卡未生成');expect(view.agentReply).not.toContain('已为你生成');
  expect(view.agentMessages[0].content).toBe(view.agentReply);expect(plugin.appendAgentConversation).toHaveBeenCalledWith(expect.any(String),view.agentReply,expect.any(Function));
  expect(await store.getProjectSnapshot()).toEqual(before);expect((await new ProjectJobRepository(store).load()).document.job).toBeNull();
});

it("withdraws a previous project error when its voice source is invalidated", async () => {
  const view = finishable(viewFor());
  const bad = call("old-proposal-before-source-change");
  bad.arguments.nextStep = { text: "核对纯虚构蓝色清单", source: null };
  await executeOmniE2eToolCall(view, bad);
  expect(view.agentMessages[0].content).toContain("项目安排卡未生成");
  const client = {
    hasProtectedContextSources: () => true,
    assertContextSourcesCurrentNow: () => { throw Error("Fictional old source changed"); },
    close: vi.fn()
  };
  view.agentRealtimeClient = client;
  expect(await executeOmniE2eToolCall(view, call("source-changed"))).toBe("");
  expect(view.agentMessages[0].content).toContain("语音资料刚刚变化");
  expect(view.agentMessages[0].content).not.toContain("项目安排卡未生成");
  expect(view.agentVoiceRuntime.snapshot().currentTurn?.phase).toBe("failed");
  expect(client.close).toHaveBeenCalledOnce();
});
it('blocks unverified native audio after failed proposal and releases the guard for a replacement runtime',async()=>{
  const view=finishable(viewFor()),bad=call('failed-audio-plan');bad.arguments.nextStep={text:'核对纯虚构蓝色清单',source:null};
  await executeOmniE2eToolCall(view,bad);plugin.settings.realtimeVoice.speakReplies=true;view.enqueueAgentSpeechAudio=vi.fn(()=>true);
  handleOmniE2eAudioDelta(view,Buffer.alloc(640).toString('base64'),24000);
  expect(view.enqueueAgentSpeechAudio).not.toHaveBeenCalled();expect(view.agentVoiceRuntime.snapshot().currentTurn.nativeAudioStarted).toBe(false);
  view.agentVoiceRuntime=viewFor().agentVoiceRuntime;
  handleOmniE2eAudioDelta(view,Buffer.alloc(640).toString('base64'),24000);expect(view.enqueueAgentSpeechAudio).toHaveBeenCalledTimes(1);
});
it('keeps a delivered old card when a later malformed proposal fails, then allows corrected proposal in the same turn',async()=>{
  const view=finishable(viewFor());await executeOmniE2eToolCall(view,call('first-delivered-card'));const old=view.pendingAgentActions[0];
  const bad=call('second-bad-card');bad.arguments.nextStep={text:'核对纯虚构蓝色清单',source:null};await executeOmniE2eToolCall(view,bad);
  expect(view.pendingAgentActions).toEqual([old]);await plugin.assertAgentActionDeliverable(old);
  await executeOmniE2eToolCall(view,call('second-repaired-card'));expect(view.pendingAgentActions.length).toBeGreaterThan(0);
  await finishOmniE2eVoiceTurn(view,'完整卡已生成，尚未保存，请点击确认。');expect(view.agentReply).toContain('完整卡已生成');expect(view.agentReply).not.toContain('卡未生成');
  expect((await new ProjectJobRepository(store).load()).document.job).toBeNull();
});

it.each(['delivery_error','collision'])('keeps host failure truth when a prepared card is not delivered: %s',async kind=>{
  const view=finishable(viewFor());
  if(kind==='delivery_error')vi.spyOn(plugin,'assertAgentActionDeliverable').mockRejectedValueOnce(Error('纯虚构最后核对失败'));
  else view.pendingAgentActions=[{id:'proposal:host-no-delivery:0',type:'create_task',title:'原卡',content:'原卡',date:'2026-10-06'}];
  const original=view.pendingAgentActions.slice(),reply=await executeOmniE2eToolCall(view,call('host-no-delivery'));
  expect(reply).toContain('项目安排卡未生成');expect(view.pendingAgentActions).toEqual(original);expect((registry as any).reviews.size).toBe(0);
  await finishOmniE2eVoiceTurn(view,'已生成完整卡，请确认。');expect(view.agentReply).toContain('项目安排卡未生成');
  expect((await new ProjectJobRepository(store).load()).document.job).toBeNull();
});

it('finishes a failed proposal with host truth when Omni fails, without asking another model to invent a card',async()=>{
  const view=finishable(viewFor()),bad=call('failed-before-brain');bad.arguments.nextStep={text:'核对纯虚构蓝色清单',source:null};
  plugin.submitAgentMessage=vi.fn(async()=>({reply:'卡已生成',actions:[]}));view.agentRealtimeClient={cancelResponse:vi.fn(),close:vi.fn()};
  await executeOmniE2eToolCall(view,bad);await fallbackOmniResponseToBrain(view,'Synthetic timeout');
  expect(plugin.submitAgentMessage).not.toHaveBeenCalled();expect(view.agentReply).toContain('项目安排卡未生成');
  expect((await new ProjectJobRepository(store).load()).document.job).toBeNull();
});
it('cancels queued native output on failed proposal and speaks only the host notice locally after model done',async()=>{
  const view=finishable(viewFor()),output={start:vi.fn(async()=>{}),cancel:vi.fn(),appendPcm16:vi.fn(()=>true),finish:vi.fn(),fail:vi.fn()};
  view.agentAudioOutput=output;view.agentOmniPendingAudio=[];view.agentMode='voice';plugin.settings.realtimeVoice.speakReplies=true;
  const spoken: any[]=[];vi.stubGlobal('SpeechSynthesisUtterance',class{constructor(public text:string){}});vi.stubGlobal('speechSynthesis',{cancel:vi.fn(),speak:(x:any)=>spoken.push(x)});
  handleOmniE2eAudioDelta(view,Buffer.alloc(640).toString('base64'),24000);await Promise.resolve();
  expect(view.agentVoiceRuntime.snapshot().currentTurn.nativeAudioStarted).toBe(true);
  const bad=call('native-before-failed-proposal');bad.arguments.nextStep={text:'核对纯虚构蓝色清单',source:null};await executeOmniE2eToolCall(view,bad);
  expect(output.cancel).toHaveBeenCalledWith(expect.any(String),'project_proposal_failed');expect(view.agentOmniPendingAudio).toEqual([]);
  await finishOmniE2eVoiceTurn(view,'已生成卡片，确认就能保存。');expect(spoken).toHaveLength(1);expect(spoken[0].text).toContain('项目安排卡未生成');expect(spoken[0].text).not.toContain('已生成卡片');
  spoken[0].onend();await Promise.resolve();expect(view.agentReply).toContain('项目安排卡未生成');
});
it('ignores a retired native start promise without consuming the replacement owner queue',async()=>{
  const view=finishable(viewFor());plugin.settings.realtimeVoice.speakReplies=true;let release!:()=>void;
  const oldStart=new Promise<void>(yes=>{release=yes;});const output={start:vi.fn(()=>oldStart),cancel:vi.fn(),appendPcm16:vi.fn(()=>true),finish:vi.fn(),fail:vi.fn()};
  view.agentAudioOutput=output;view.agentOmniPendingAudio=[];handleOmniE2eAudioDelta(view,Buffer.alloc(640).toString('base64'),24000);
  const bad=call('native-start-pending');bad.arguments.nextStep={text:'核对纯虚构蓝色清单',source:null};await executeOmniE2eToolCall(view,bad);
  view.agentVoiceRuntime.selectOutputOwner('fallback-tts');view.agentOmniPlaybackReady=Promise.resolve();const replacement=[{pcm:new Int16Array([7]),sampleRate:24000}];view.agentOmniPendingAudio=replacement;
  release();await oldStart;await Promise.resolve();expect(output.appendPcm16).not.toHaveBeenCalled();expect(output.finish).not.toHaveBeenCalled();expect(view.agentOmniPendingAudio).toEqual(replacement);
  clearTimeout(view.agentVoiceResponseTimer);
});

it('does not let a queued old native audio-done finish a replacement playback owner',async()=>{
  const view=finishable(viewFor());plugin.settings.realtimeVoice.speakReplies=true;let release!:()=>void;
  const oldStart=new Promise<void>(yes=>{release=yes;});const output={start:vi.fn(()=>oldStart),cancel:vi.fn(),appendPcm16:vi.fn(()=>true),finish:vi.fn(),fail:vi.fn()};
  view.agentAudioOutput=output;view.agentOmniPendingAudio=[];view.agentVoiceRuntime.bindResponse('old-native-response');
  handleOmniE2eAudioDelta(view,Buffer.alloc(640).toString('base64'),24000);
  handleOmniE2eAudioDone(view,{eventType:'response.audio.done',responseId:'old-native-response',status:'in_progress'});
  const bad=call('audio-done-before-failed-proposal');bad.arguments.nextStep={text:'核对纯虚构蓝色清单',source:null};await executeOmniE2eToolCall(view,bad);
  view.agentVoiceRuntime.selectOutputOwner('fallback-tts');view.agentOmniPlaybackReady=Promise.resolve();
  release();await oldStart;await Promise.resolve();await Promise.resolve();expect(output.finish).not.toHaveBeenCalled();
  clearTimeout(view.agentVoiceResponseTimer);
});

it('withdraws only a new undisplayed card when refresh throws and retains an already shown card',async()=>{
 const view=finishable(viewFor());await executeOmniE2eToolCall(view,call('already-shown'));const old=view.pendingAgentActions[0];
 view.refreshAgentSuggestions.mockImplementationOnce(()=>{throw Error('Synthetic card display failed');});
 const reply=await executeOmniE2eToolCall(view,call('unshown-new-card'));expect(reply).toContain('项目安排卡未生成');
 expect(view.pendingAgentActions).toEqual([old]);expect((registry as any).reviews.size).toBe(1);await plugin.assertAgentActionDeliverable(old);
 await finishOmniE2eVoiceTurn(view,'新的完整卡已生成，请确认。');expect(view.agentReply).toContain('项目安排卡未生成');expect((await new ProjectJobRepository(store).load()).document.job).toBeNull();
});
it('retains a reused displayed token if its refresh fails, and clears old failure wording after a successful repair',async()=>{
 const view=finishable(viewFor());await executeOmniE2eToolCall(view,call('reused-display'));const old=view.pendingAgentActions[0];
 view.refreshAgentSuggestions.mockImplementationOnce(()=>{throw Error('Synthetic repeat display failed');});
 expect(await executeOmniE2eToolCall(view,call('reused-display'))).toContain('项目安排卡未生成');expect(view.pendingAgentActions).toEqual([old]);
 await plugin.assertAgentActionDeliverable(old);expect((registry as any).reviews.size).toBe(1);
 expect(await executeOmniE2eToolCall(view,call('repaired-display'))).toContain('尚未保存');expect(view.agentReply).not.toContain('卡未生成');
 expect((await new ProjectJobRepository(store).load()).document.job).toBeNull();
});

function resultCall(taskId='missing-task',id='voice-result'): AiToolCall {
 return {id,name:'propose_project_task_result',arguments:{projectId,taskId,entryKind:'output',text:'核对清单完成。'}};
}
function changeCall(valid=true,id='voice-change'): AiToolCall {
 return {id,name:'propose_project_change',arguments:{command:{kind:'save_project',id:valid?projectId:'missing-project',input:{nextStep:'纯虚构修订下一步'}}}};
}
async function linkedTask(): Promise<string> {
 const runtime=new AgentRuntime({store,refreshViews:async()=>{}});
 const r=await runtime.executeAiToolCall({id:'fixture-result-task',name:'propose_project_change',arguments:{command:{kind:'create_task',projectId,input:{title:'纯虚构原任务',date:'2026-10-07'}}}},'kimi','纯虚构准备');
 expect(r.success,r.output).toBe(true);await runConfirmedToolAction(r.actions[0],{store,refreshViews:async()=>{}});
 return (await store.getProjectSnapshot()).document.projects[0].taskIds[0];
}
it.each(['result','change'] as const)('preserves host failure when %s proposal has no card and the model invents one',async kind=>{
 const view=finishable(viewFor()),before=await store.getProjectSnapshot();
 await executeOmniE2eToolCall(view,kind==='result'?resultCall():changeCall(false));
 await finishOmniE2eVoiceTurn(view,'确认卡已经生成，请点击确认。');
 expect(view.agentReply).toContain(kind==='result'?'任务结果卡未生成':'项目变更卡未生成');
 expect(view.agentMessages[0].content).toBe(view.agentReply);expect(view.pendingAgentActions).toEqual([]);
 expect(await store.getProjectSnapshot()).toEqual(before);expect((await new ProjectJobRepository(store).load()).document.job).toBeNull();
});
it('cannot erase a result failure by delivering a different project-plan card',async()=>{
 const view=finishable(viewFor()),before=await store.getProjectSnapshot();await executeOmniE2eToolCall(view,resultCall());
 await executeOmniE2eToolCall(view,call('unrelated-success-plan'));expect(view.pendingAgentActions).toHaveLength(1);
 await plugin.assertAgentActionDeliverable(view.pendingAgentActions[0]);
 await finishOmniE2eVoiceTurn(view,'两张卡都已生成，尚未保存。');expect(view.agentReply).toContain('任务结果卡未生成');
 expect(await store.getProjectSnapshot()).toEqual(before);expect((await new ProjectJobRepository(store).load()).document.job).toBeNull();
});
it('clears only the repaired proposal category while keeping another category failure',async()=>{
 const taskId=await linkedTask(),view=finishable(viewFor());
 const malformed=resultCall(taskId);malformed.arguments.unexpectedSource=null;
 await executeOmniE2eToolCall(view,malformed);await executeOmniE2eToolCall(view,changeCall(false));
 await executeOmniE2eToolCall(view,resultCall(taskId,'repaired-result'));expect(view.pendingAgentActions).toHaveLength(1);
 await finishOmniE2eVoiceTurn(view,'结果卡已生成，请确认。');expect(view.agentReply).toContain('项目变更卡未生成');expect(view.agentReply).not.toContain('任务结果卡未生成');
 expect((await store.getProjectSnapshot()).document.projects[0].entries).toEqual([]);
});
it.each(['result','change'] as const)('keeps a displayed old %s card when an incoming same-id card conflicts',async kind=>{
 const taskId=await linkedTask(),view=finishable(viewFor());const first=kind==='result'?resultCall(taskId,'same-id'):changeCall(true,'same-id');
 await executeOmniE2eToolCall(view,first);const old=view.pendingAgentActions[0],second=structuredClone(first);
 if(kind==='result')second.arguments.text='另一项纯虚构结果。';else (second.arguments.command as any).input.nextStep='另一纯虚构下一步';
 await executeOmniE2eToolCall(view,second);expect(view.pendingAgentActions).toEqual([old]);
 await finishOmniE2eVoiceTurn(view,'新卡已生成。');expect(view.agentReply).toContain(kind==='result'?'任务结果卡未生成':'项目变更卡未生成');
 expect((await store.getProjectSnapshot()).document.projects[0].entries).toEqual([]);expect((await new ProjectJobRepository(store).load()).document.job).toBeNull();
});
it.each(['result','change'] as const)('withdraws an unshown %s card on refresh failure and preserves old pending card',async kind=>{
 const taskId=await linkedTask(),view=finishable(viewFor());await executeOmniE2eToolCall(view,call('old-plan'));const old=view.pendingAgentActions[0];
 view.refreshAgentSuggestions.mockImplementationOnce(()=>{throw Error('Synthetic refresh failed');});
 await executeOmniE2eToolCall(view,kind==='result'?resultCall(taskId):changeCall());expect(view.pendingAgentActions).toEqual([old]);await plugin.assertAgentActionDeliverable(old);
 await finishOmniE2eVoiceTurn(view,'新卡已生成。');expect(view.agentReply).toContain(kind==='result'?'任务结果卡未生成':'项目变更卡未生成');
 expect((await store.getProjectSnapshot()).document.projects[0].entries).toEqual([]);
});
it('does not let an older same-tool success erase a newer failure',async()=>{
 const taskId=await linkedTask(),view=finishable(viewFor()),execute=plugin.executeAgentToolCall.bind(plugin);
 const response=await execute(resultCall(taskId,'older-success'),message);let release!:()=>void,started!:()=>void;
 const gate=new Promise<void>(yes=>{release=yes;}),entered=new Promise<void>(yes=>{started=yes;});
 vi.spyOn(plugin,'executeAgentToolCall').mockImplementation(async(tool:unknown,user:unknown,guard:unknown)=>{
   if((tool as AiToolCall).id==='older-success'){started();await gate;return response;}
   return execute(tool,user,guard);
 });
 const older=executeOmniE2eToolCall(view,resultCall(taskId,'older-success'));await entered;
 const newerFailure=resultCall(taskId,'newer-failure');newerFailure.arguments.unexpectedSource=null;
 await executeOmniE2eToolCall(view,newerFailure);release();await older;
 await finishOmniE2eVoiceTurn(view,'结果卡已生成，请确认。');expect(view.agentReply).toContain('任务结果卡未生成');expect(view.pendingAgentActions).toHaveLength(1);
 expect((await store.getProjectSnapshot()).document.projects[0].entries).toEqual([]);
});
it('returns protected query data to the model without appending raw IDs or policy text to the chat',async()=>{
 const view=finishable(viewFor());view.agentReply='正在核对你的项目。';view.agentOmniE2eReply=view.agentReply;view.agentMessages[0].content=view.agentReply;
 const before=await store.getProjectSnapshot(),reply=await executeOmniE2eToolCall(view,{id:'hidden-query',name:'query_projects',arguments:{query:'纯虚构项目'}});
 expect(reply).toContain(projectId);expect(reply).toContain('文件校验只证明');expect(view.agentReply).toBe('正在核对你的项目。');expect(view.agentMessages[0].content).toBe(view.agentReply);
 await finishOmniE2eVoiceTurn(view,'项目仍在进行，原下一步保持。');expect(view.agentReply).toBe('项目仍在进行，原下一步保持。');expect(await store.getProjectSnapshot()).toEqual(before);
});
it('withdraws all new unshown project cards when one card in a multi-card response collides',async()=>{
 const view=finishable(viewFor());await executeOmniE2eToolCall(view,changeCall(true,'old-id'));const old=view.pendingAgentActions[0],execute=plugin.executeAgentToolCall.bind(plugin);
 const collision=changeCall(true,'old-id');(collision.arguments.command as any).input.nextStep='另一纯虚构下一步';
 const a=await execute(collision,message),b=await execute(changeCall(true,'new-id'),message);
 vi.spyOn(plugin,'executeAgentToolCall').mockResolvedValueOnce({reply:'两张卡已生成。',actions:[...a.actions,...b.actions]});
 await executeOmniE2eToolCall(view,changeCall());expect(view.pendingAgentActions).toEqual([old]);
 await finishOmniE2eVoiceTurn(view,'两张新卡已生成。');expect(view.agentReply).toContain('项目变更卡未生成');
 expect((await store.getProjectSnapshot()).document.projects[0].nextStep).toBe('纯虚构原下一步');
});
it('does not publish a late result failure after the original turn is stopped and replaced',async()=>{
 const view=finishable(viewFor()),execute=plugin.executeAgentToolCall.bind(plugin);let release!:()=>void,started!:()=>void;
 const gate=new Promise<void>(yes=>{release=yes;}),entered=new Promise<void>(yes=>{started=yes;});
 vi.spyOn(plugin,'executeAgentToolCall').mockImplementation(async(tool:unknown,user:unknown,guard:unknown)=>{started();await gate;return execute(tool,user,guard);});
 const old=executeOmniE2eToolCall(view,resultCall());await entered;stop(view);view.agentVoiceRuntime=viewFor().agentVoiceRuntime;view.agentReply='新回合文字';
 release();expect(await old).toBe('');expect(view.agentReply).toBe('新回合文字');expect(view.pendingAgentActions).toEqual([]);
});
it('ignores a retired failure after a newer failure was repaired in the same turn',async()=>{
 const taskId=await linkedTask(),view=finishable(viewFor()),execute=plugin.executeAgentToolCall.bind(plugin);let release!:()=>void,started!:()=>void;
 const gate=new Promise<void>(yes=>{release=yes;}),entered=new Promise<void>(yes=>{started=yes;});
 vi.spyOn(plugin,'executeAgentToolCall').mockImplementation(async(tool:unknown,user:unknown,guard:unknown)=>{
  if((tool as AiToolCall).id==='slow-old-failure'){started();await gate;}
  return execute(tool,user,guard);
 });
 const malformed=(id:string)=>{const c=resultCall(taskId,id);c.arguments.unexpectedSource=null;return c;};
 const old=executeOmniE2eToolCall(view,malformed('slow-old-failure'));await entered;
 await executeOmniE2eToolCall(view,malformed('newer-known-failure'));await executeOmniE2eToolCall(view,resultCall(taskId,'valid-repair'));
 expect(view.agentReply).not.toContain('卡未生成');release();await old;
 await finishOmniE2eVoiceTurn(view,'待确认卡已生成，尚未保存。');expect(view.agentReply).not.toContain('卡未生成');expect(view.pendingAgentActions).toHaveLength(1);
});
it('cannot treat a valid result for another task as a repair of the failed task',async()=>{
 const taskId=await linkedTask(),view=finishable(viewFor());await executeOmniE2eToolCall(view,resultCall('missing-different-task'));
 await executeOmniE2eToolCall(view,resultCall(taskId,'unrelated-result'));await finishOmniE2eVoiceTurn(view,'结果卡均已生成。');
 expect(view.agentReply).toContain('任务结果卡未生成');expect(view.pendingAgentActions).toHaveLength(1);
});
