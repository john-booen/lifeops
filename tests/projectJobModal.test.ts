import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import type { StoreHost } from "../src/store/settingsSlice";
import { DEFAULT_SETTINGS } from "../src/defaults";
const ui = vi.hoisted(() => {
  class Element {
    text = ""; disabled = false; children: Element[] = []; onclick?: () => Promise<void>;
    constructor(readonly tag = "div", options?: { text?: string }) { this.text = options?.text ?? ""; }
    empty() { this.children = []; } addClass() {}
    createDiv(options?: { text?: string }) { return this.createEl("div", options); }
    createSpan(options?: { text?: string }) { return this.createEl("span", options); }
    createEl(tag: string, options?: { text?: string }) { const node = new Element(tag, options); this.children.push(node); return node; }
    find(text: string): Element | undefined { return this.text === text ? this : this.children.map(child => child.find(text)).find(Boolean); }
  }
  const fields = new Map<string, { update: (value: string) => void; value: string }>(), notices: string[] = [];
  class Setting {
    name = ""; constructor(_el: unknown) {} setName(value: string) { this.name = value; return this; }
    addText(callback: (field: any) => void) { return this.field(callback); } addTextArea(callback: (field: any) => void) { return this.field(callback); }
    field(callback: (field: any) => void) {
      const state = { update: (_value: string) => {}, value: "" }; fields.set(this.name, state);
      const field = { inputEl: { rows: 1 }, setPlaceholder: (_value: string) => field,
        setValue: (value: string) => { state.value = value; return field; }, onChange: (update: (value: string) => void) => { state.update = update; return field; } };
      callback(field); return this;
    }
  }
  class Modal { contentEl = new Element(); constructor(readonly app: unknown) {} open() {} close() {} }
  return { Element, Setting, Modal, fields, notices };
});
vi.mock("obsidian", () => ({ App: class {}, TFile: class {}, TFolder: class {}, Modal: ui.Modal, Setting: ui.Setting,
  Notice: class { constructor(message: string) { ui.notices.push(message); } }, normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/{2,}/g, "/"), requestUrl: () => { throw Error("Network forbidden"); } }));
const { LifeOpsStore } = await import("../src/store"), { DiskVault } = await import("./helpers/diskVault"), { AgentRuntime } = await import("../src/agentRuntime");
const { ProjectJobRunner } = await import("../src/projectJobRunner"), { ProjectJobModal } = await import("../src/projectJobModal");
const { ProjectJobRepository } = await import("../src/projectJobRepository");
const { ProjectBoardModal } = await import("../src/projectBoard");
let root: string, vault: InstanceType<typeof DiskVault>, store: StoreHost, runner: InstanceType<typeof ProjectJobRunner>, modal: InstanceType<typeof ProjectJobModal>;
const content = () => modal.contentEl as unknown as InstanceType<typeof ui.Element>;
const click = async (label: string) => { const button = content().find(label); expect(button).toBeDefined(); await button!.onclick?.(); };
beforeEach(async () => {
  ui.fields.clear(); ui.notices.length = 0; root = await mkdtemp(join(tmpdir(), "lifeops-job-modal-")); vault = new DiskVault(root);
  store = new LifeOpsStore({ vault } as unknown as App, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost; await store.initializeVault();
  runner = new ProjectJobRunner(store, new AgentRuntime({ store, refreshViews: async () => {} })); modal = new ProjectJobModal(store.app, runner);
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
async function form() { modal.onOpen(); await vi.waitFor(() => expect(ui.fields.has("任务")).toBe(true)); ui.fields.get("任务")!.update("纯虚构界面任务甲\n纯虚构界面任务乙"); }
it("keeps opening and complete preview read-only, then confirms the frozen plan rather than edited display", async () => {
  const before = vault.writes.length; await form(); await click("核对安排"); expect(vault.writes.length).toBe(before);
  expect(content().find("核对将保存的安排")).toBeDefined(); content().find("纯虚构界面任务甲")!.text = "纯虚构误改显示";
  ui.fields.get("任务")!.update("纯虚构旧输入迟到"); await click("确认保存这些安排");
  expect((await store.readTaskDb()).tasks.map(t => t.title)).toEqual(["纯虚构界面任务甲", "纯虚构界面任务乙"]);
  expect(content().find("本次核对：已保存到事务")).toBeDefined();
  expect(content().find("保留历史，开始下一份安排")).toBeDefined(); await click("保留历史，开始下一份安排");
  expect(content().find("核对安排")).toBeDefined(); expect((await store.readTaskDb()).tasks).toHaveLength(2);
});
it("does not present old committed metadata as currently verified saved tasks after an actual undo", async () => {
  await form();await click("核对安排");await click("确认保存这些安排");
  const runtime=new AgentRuntime({store,refreshViews:async()=>{}});
  await runtime.undoLatestOperation();const jobBefore=await new ProjectJobRepository(store).load();
  const beforeWrites=vault.writes.length;await click("刷新");
  expect(content().find("已保存到事务")).toBeUndefined();
  expect(content().find("本次核对：已保存到事务")).toBeUndefined();
  expect(content().find("记录显示曾保存，当前结果待核对")).toBeDefined();
  expect(content().find("检查并恢复后继续")).toBeUndefined();
  expect((await store.readTaskDb()).tasks).toHaveLength(1);expect(vault.writes.length).toBe(beforeWrites);
  expect((await new ProjectJobRepository(store).load()).raw).toBe(jobBefore.raw);
});
it("does not create a plan when its preview returns after the window closed", async () => {
  await form(); let release!: () => void, entered!: () => void; const gate = new Promise<void>(resolve => release = resolve), started = new Promise<void>(resolve => entered = resolve);
  const original = runner.prepare.bind(runner); vi.spyOn(runner, "prepare").mockImplementation(async (...args) => { const result = await original(...args); entered(); await gate; return result; });
  const before = vault.writes.length, pending = click("核对安排"); await started; modal.onClose(); release(); await pending;
  expect(vault.writes.length).toBe(before); expect((await store.readTaskDb()).tasks).toHaveLength(0);
});
it("the visible stop button aborts before queue creation, rather than leaving a delayed task dispatch", async () => {
  await form(); await click("核对安排"); const saving = click("确认保存这些安排");
  await click("停止剩余安排"); await saving; expect((await store.readTaskDb()).tasks).toHaveLength(0);
  expect(ui.notices.some(message => message.includes("取消"))).toBe(true);
});
it("shows a stop button immediately for a chat confirmation before its initial queue write", async () => {
  const plan = await runner.prepare([{ title: "纯虚构对话立即停止" }], "安排纯虚构任务"), request = new AbortController();
  const completion = runner.startConfirmed(plan, request.signal); completion.catch(() => undefined);
  modal = new ProjectJobModal(store.app, runner, { request, completion }); modal.onOpen();
  expect(content().find("正在保存安排")).toBeDefined(); await click("停止剩余安排");
  await expect(completion).rejects.toThrow("取消"); expect((await store.readTaskDb()).tasks).toHaveLength(0);
});
it("does not redraw a closed chat status window when its held completion settles", async () => {
  let resolve!: (state: any) => void; const completion = new Promise<any>(done => resolve = done), request = new AbortController();
  modal = new ProjectJobModal(store.app, runner, { request, completion }); modal.onOpen(); const before = content().children;
  modal.onClose(); resolve(await runner.inspect()); await completion; await new Promise(done => setTimeout(done, 0));
  expect(content().children).toBe(before); expect(request.signal.aborted).toBe(false);
});
async function mixedForm(onChanged: () => Promise<void>, refresh: () => Promise<void> = async () => {}) {
  const fixtureRuntime = new AgentRuntime({ store, refreshViews: async () => {} });
  for (const kind of ["goal", "project"] as const) {
    const snapshot = await store.getProjectSnapshot(), id = `local:modal-refresh-${kind}`;
    const command = kind === "goal" ? { kind: "save_goal" as const, input: { title: "纯虚构刷新目标", reason: "", successCriteria: "", timeBoundary: "", constraints: "", nextStep: "", reviewOn: "", sourcePath: "", state: "agreed" as const, stateNote: "" } }
      : { kind: "save_project" as const, input: { title: "纯虚构刷新项目", goalId: snapshot.document.goals[0].id, kind: "work" as const, state: "started" as const, nextStep: "纯虚构旧下一步", nextStepSourcePath: "", commitments: "", blockers: "", reviewOn: "", stateNote: "" } };
    const result = await fixtureRuntime.executeLocalOperation("synthetic_modal_fixture", { command }, scope => scope.applyProjectCommand(command, snapshot.revision, id), id);
    expect(result.success, result.output).toBe(true);
  }
  runner = new ProjectJobRunner(store, new AgentRuntime({ store, refreshViews: refresh })); const projectId = (await store.getProjectSnapshot()).document.projects[0].id;
  modal = new ProjectJobModal(store.app, runner, undefined, projectId, onChanged); await form();
  ui.fields.get("同时更新项目下一步（可留空）")!.update("纯虚构当前下一步");
}
it("refreshes the owning board from actual saved tasks and next step, without publishing preview as saved", async () => {
  const observed: Array<Awaited<ReturnType<StoreHost["getProjectSnapshot"]>>> = [];
  await mixedForm(async () => { observed.push(await store.getProjectSnapshot()); });
  await click("核对安排"); expect(observed).toHaveLength(0); await click("确认保存这些安排");
  expect(observed.at(-1)?.tasks).toHaveLength(2);
  expect(observed.at(-1)?.document.projects[0]).toMatchObject({ nextStep: "纯虚构当前下一步", state: "started" });
});
it("labels the original project binding and withholds a current next-step claim after the project changes",async()=>{
  await mixedForm(async()=>{});await click("核对安排");await click("确认保存这些安排");
  const snapshot=await store.getProjectSnapshot(),project=snapshot.document.projects[0],runtime=new AgentRuntime({store,refreshViews:async()=>{}});
  const command={kind:"save_project" as const,id:project.id,input:{title:project.title,goalId:project.goalId,kind:project.kind,state:project.state,
    nextStep:"纯虚构本人后来调整",nextStepSourcePath:"",commitments:project.commitments,blockers:project.blockers,reviewOn:project.reviewOn,stateNote:project.stateNote}};
  const result=await runtime.executeLocalOperation("synthetic_status_change",{command},scope=>scope.applyProjectCommand(command,snapshot.revision,"local:later-status-change"),"local:later-status-change");expect(result.success,result.output).toBe(true);
  const beforeWrites=vault.writes.length;await click("刷新");
  expect(content().find("项目下一步已更新")).toBeUndefined();expect(content().find("记录显示曾保存，当前结果待核对")).toBeDefined();
  expect(content().find("本次核对：项目下一步已更新")).toBeUndefined();
  expect(content().find("原安排所属目标：纯虚构刷新目标；关联项目：纯虚构刷新项目；确认时项目阶段：进行中")).toBeDefined();
  expect((await store.getProjectSnapshot()).document.projects[0].nextStep).toBe("纯虚构本人后来调整");expect(vault.writes.length).toBe(beforeWrites);
});
it("does not trust a completed-looking step while a second actual save is still active",async()=>{
  let enter!:()=>void,release!:()=>void,refreshCount=0;
  const entered=new Promise<void>(done=>enter=done),held=new Promise<void>(done=>release=done);
  runner=new ProjectJobRunner(store,new AgentRuntime({store,refreshViews:async()=>{if(++refreshCount===2){enter();await held;}}}));
  const pending=runner.startConfirmed(await runner.prepare([{title:"纯虚构运行中甲"},{title:"纯虚构运行中乙"}],"明确纯虚构两项安排"));
  await entered;modal=new ProjectJobModal(store.app,runner);modal.onOpen();
  try{
    await vi.waitFor(()=>expect(content().find("把安排接着做")).toBeDefined());
    const beforeWrites=vault.writes.length;
    expect(content().find("本次核对：已保存到事务")).toBeUndefined();
    expect(content().find("已保存到事务")).toBeUndefined();
    expect(content().find("记录显示曾保存，当前结果待核对")).toBeDefined();
    expect(content().find("提交待核对")).toBeDefined();
    expect(content().find("正在核对并保存安排，原安排记录进度为 1/2 项；当前结果待核对。")).toBeDefined();
  expect(vault.writes.length).toBe(beforeWrites);
  }finally{modal.onClose();release();await pending;}
  expect((await store.readTaskDb()).tasks).toHaveLength(2);
});
it("refreshes the owning board after a held save settles even if the child window was closed", async () => {
  let enter!: () => void, release!: () => void, calls = 0;
  const entered = new Promise<void>(resolve => enter = resolve), held = new Promise<void>(resolve => release = resolve);
  const observed: Array<Awaited<ReturnType<StoreHost["getProjectSnapshot"]>>> = [];
  await mixedForm(async () => { observed.push(await store.getProjectSnapshot()); }, async () => { if (++calls === 1) { enter(); await held; } });
  await click("核对安排"); const saving = click("确认保存这些安排"); await entered;
  modal.onClose(); const children = content().children; release(); await saving;
  expect(observed.at(-1)?.tasks).toHaveLength(2); expect(observed.at(-1)?.document.projects[0].nextStep).toBe("纯虚构当前下一步");
  expect(content().children).toBe(children);
});
it("wires the project's plan entry back to a fresh board and ignores callbacks after the board closes", async () => {
  await mixedForm(async () => {}); const projectId = (await store.getProjectSnapshot()).document.projects[0].id;
  let changed!: () => Promise<void>;
  const board = new ProjectBoardModal(store.app, { getProjectSnapshot: () => store.getProjectSnapshot(), saveProjectCommand: async () => "", openProjectSource: async () => {},
    openProjectTaskPlan: (id, onChanged) => { expect(id).toBe(projectId); changed = onChanged!; } });
  const boardContent = board.contentEl as unknown as InstanceType<typeof ui.Element>;
  board.onOpen(); await vi.waitFor(() => expect(boardContent.find("为项目安排多项任务")).toBeDefined());
  await boardContent.find("为项目安排多项任务")!.onclick?.();
  await runner.startConfirmed(await runner.prepareWorkPlan([{ title: "纯虚构看板刷新任务" }], "明确虚构任务和下一步", [], projectId, { text: "纯虚构当前下一步" }));
  await changed(); expect(boardContent.find("下一步：纯虚构当前下一步")).toBeDefined(); expect(boardContent.find("关联任务（1）")).toBeDefined();
  expect(boardContent.find("下一步：纯虚构旧下一步")).toBeUndefined(); board.onClose(); const children = boardContent.children;
  await changed(); expect(boardContent.children).toBe(children);
});
