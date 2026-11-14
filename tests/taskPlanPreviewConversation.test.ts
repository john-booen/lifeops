import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, beforeEach, expect, it, vi} from "vitest";
import type {App} from "obsidian";
import type {StoreHost} from "../src/store/settingsSlice";
import {DEFAULT_SETTINGS} from "../src/defaults";
import {normalizeJournalDate, todayString} from "../src/date";
import {OperationLedger} from "../src/dataFoundation/operationLedger";
const request = vi.hoisted(() => vi.fn());
vi.mock("obsidian", () => ({App: class {}, Plugin: class {}, TFile: class {}, TFolder: class {}, WorkspaceLeaf: class {}, ItemView: class {},
  Modal: class {open() {}}, PluginSettingTab: class {}, Setting: class {}, Platform: {isDesktopApp: true}, Notice: class {}, setIcon: vi.fn(),
  normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/{2,}/g, "/"), requestUrl: request}));
const {LifeOpsStore} = await import("../src/store");
const {LifeOpsAi} = await import("../src/ai");
const {default: Plugin} = await import("../src/main");
const {DiskVault} = await import("./helpers/diskVault");
const title = "合成临时任务";
const message = "请帮我安排一项任务：合成临时任务，今天做，先给确认卡。";
const previewMessages = [message, "请先给我一张待确认的任务安排卡，只包含合成临时任务，今天做，暂不保存。",
  "请创建任务：合成临时任务，先给我确认卡，确认后再保存。", "帮我安排两项任务：合成甲、合成乙，先给确认卡。",
  "请新建一个临时任务，名字叫“合成临时任务”，先给我确认卡。",
  "帮我新增一条待办，名称为「合成临时任务」，先给我核对卡，暂不保存。"];
let root: string, vault: InstanceType<typeof DiskVault>, store: StoreHost, plugin: any, bodies: any[], calls: any[], published: string[];
const tool = (name = "propose_task_plan", args: unknown = {tasks: [{title, date: "今天"}]}, id = "fictional-preview") =>
  ({id, type: "function", function: {name, arguments: JSON.stringify(args)}});
const ledgerBytes = () => store.readPath(new OperationLedger(store).filePath);
const facts = async () => ({db: await vault.bytes(store.taskDbPath()), mirror: await vault.bytes(store.taskMirrorPath()), ledger: await ledgerBytes()});
beforeEach(async () => {
  vi.stubGlobal("window", globalThis); request.mockReset();
  root = await mkdtemp(join(tmpdir(), "lifeops-task-card-")); vault = new DiskVault(root);
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.privacy = {...settings.privacy, excludedVaultPrefixes: [], plaintextCredentialStorageAccepted: true};
  settings.ai = {...settings.ai, provider: "openai-compatible", endpoint: "https://example.test/chat", model: "kimi-k2.6", apiKey: "fictional-key", dataDisclosureAccepted: true};
  const app = {vault, workspace: {getLeavesOfType: () => []}} as unknown as App;
  store = new LifeOpsStore(app, settings) as unknown as StoreHost; await store.initializeVault();
  const ai = new LifeOpsAi(settings);
  plugin = Object.assign(Object.create(Plugin.prototype), {app, store, settings, ai, refreshViews: async () => {}, updateStatusBar: async () => {},
    lifeOpsEvents: {publish: () => {}}, buildSemanticContext: async () => ""});
  bodies = []; calls = [tool()]; published = [];
  request.mockImplementation(async ({body}: {body: string}) => {
    const payload = JSON.parse(body);
    bodies.push(payload);
    const pending = payload.messages.some((message: any) => message.role === "tool") ? [] : calls;
    const json = {choices: [{index: 0, finish_reason: pending.length ? "tool_calls" : "stop", message: {role: "assistant", content: "这是待确认安排，尚未保存。", tool_calls: pending}}]};
    return {status: 200, json, text: JSON.stringify(json)};
  });
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await rm(root, {recursive: true, force: true}); });
const run = (text = message, source: "text" | "voice" = "text") => plugin.submitAgentMessageStream(text, [], (text: string) => published.push(text), {selfTest: true, source});
for (const source of ["text", "voice"] as const) {
  it.each(previewMessages)(`uses the actual Main/transport to preview without saving (${source}): %s`, async text => {
    const before = await facts();
    const result = await run(text, source);
    expect(result.actions).toHaveLength(1); expect(result.actions[0]).toMatchObject({type: "task_plan"});
    expect(result.actions[0].content).toContain(title); expect(result.reply).toContain("尚未保存");
    expect(await facts()).toEqual(before);
  });
}
it("keeps original confirmation, completed Job and conflict-aware Undo after a successful preview", async () => {
  const before = await facts(), result = await run();
  await plugin.executeAgentAction(result.actions[0]);
  expect((await store.readTaskDb()).tasks.map(t => t.title)).toEqual([title]);
  await expect(plugin.executeAgentAction(result.actions[0])).rejects.toThrow();
  const undone = await plugin.executeAgentToolCall({id: "fictional-preview-undo", name: "undo_latest_operation", arguments: {}}, "撤销上一步");
  expect(undone.actions).toEqual([]); expect(await vault.bytes(store.taskDbPath())).toBe(before.db);
  expect(await vault.bytes(store.taskMirrorPath())).toBe(before.mirror);
  const ledger = JSON.parse((await ledgerBytes())!);
  expect(ledger.records.filter((r: any) => r.toolName === "create_task")).toEqual([expect.objectContaining({status: "reverted"})]);
  expect(ledger.records.some((r: any) => r.toolName === "undo_latest_operation" && r.status === "verified")).toBe(true);
});
it("retains explicit direct creation compatibility when no preview was requested", async () => {
  plugin.settings.ai.provider = "off";
  const directTitle = "合成直接创建";
  const result = await run("/todo " + directTitle);
  expect((await store.readTaskDb()).tasks.map(t => t.title)).toEqual([directTitle]); expect(result.actions).toEqual([]);
});

it.each(["大后天", "下周三", "下周末", "月底", "１２月５日", "十号"])("saves the requested date in an explicit offline task: %s", async day => {
  plugin.settings.ai.provider = "off";
  const date = normalizeJournalDate(day, todayString()), title = "虚构整理纸样";
  const result = await run(`/todo ${day} 10:30 ${title}`);
  expect(request).not.toHaveBeenCalled();
  expect(result.receipts).toHaveLength(1);
  expect((await store.readTaskDb()).tasks).toMatchObject([{title, date, time: "10:30"}]);
});

it("keeps the task database unchanged when an explicit offline month-day is impossible", async () => {
  plugin.settings.ai.provider = "off";
  const before = await facts();
  const result = await run("/todo 2月30日 虚构整理纸样");
  expect(result.receipts ?? []).toEqual([]);
  expect(await facts()).toEqual(before);
});

for (const source of ["text", "voice"] as const) {
  it(`keeps the acceptance card's natural new-task request preview-only (${source})`, async () => {
    const text = "帮我新建一个测试任务，名字叫“听感验收小任务”，安排明天，希望下午三点前完成。先给我确认卡，不要直接保存。";
    const before = await facts();
    const result = await run(text, source);
    expect(bodies).toHaveLength(2);
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0].type).toBe("task_plan");
    expect(await facts()).toEqual(before);
  });
}
