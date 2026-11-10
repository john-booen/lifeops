import type { ChatMessage } from "../src/ai";
import { stubAgentModel } from "./helpers/stubAgentModel";
import { mkdtemp, rm, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TFolder, type App } from "obsidian";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { activityNotePath } from "../src/activityRecords";
import type { StoreHost } from "../src/store/settingsSlice";
import { createPersonalMemory, reviewPersonalMemoryRecord, emptyPersonalMemoryDocument } from "../src/personalMemory";
import { addDays, formatDate } from "../src/date";
import * as contextInjection from "../src/contextInjection";
import { OperationLedger } from "../src/dataFoundation/operationLedger";
import { bindAgentHistoryResponse, projectPersonalMemoryHistory } from "../src/personalMemoryHistory";
import { readPersonalMemoryWithSources } from "../src/personalMemorySources";

vi.mock("obsidian", () => ({
  App: class {}, Plugin: class {}, TFile: class {}, TFolder: class {}, WorkspaceLeaf: class {}, ItemView: class {}, Modal: class {},
  PluginSettingTab: class {}, Setting: class {}, Platform: { isDesktopApp: true }, Notice: class {},
  normalizePath: (path: string) => path.replace(/\\/g, "/").replace(/\/{2,}/g, "/"), setIcon: vi.fn(),
  requestUrl: vi.fn(() => { throw new Error("Network forbidden"); }), parseYaml: JSON.parse, stringifyYaml: JSON.stringify
}));
const { default: LifeOpsPlugin } = await import("../src/main");
const { LifeOpsView } = await import("../src/lifeOpsView");
const { LifeOpsStore } = await import("../src/store");
const { DiskVault } = await import("./helpers/diskVault");
const { AgentRuntime } = await import("../src/agentRuntime");
const { guardRealtimeCallbacks, stopBailianRealtimeRecording } = await import("../src/voice/voiceRealtime");
let root: string, vault: InstanceType<typeof DiskVault>, store: StoreHost, plugin: any;
const oldText = "我喜欢简短回复";
const newText = "我在研究问题时喜欢详细回复";
const original = createPersonalMemory({ kind: "core_profile", content: oldText, sourceRefs: [{ sourceId: "synthetic", path: "source.md", capturedAt: "2026-09-16T00:00:00Z" }] });

beforeEach(async () => {
  vi.stubGlobal("window", globalThis);
  root = await mkdtemp(join(tmpdir(), "lifeops-memory-context-runtime-"));
  vault = new DiskVault(root);
  const app = { vault, workspace: { getLeavesOfType: vi.fn(() => []) } } as unknown as App;
  store = new LifeOpsStore(app, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost;
  await store.initializeVault();
  await vault.seed("source.md", oldText);
  await vault.seed(store.personalMemoryPath(), JSON.stringify({ ...emptyPersonalMemoryDocument(), records: reviewPersonalMemoryRecord([original], original.id, { decision: "confirm" }) }));
  const reply = vi.fn(async () => ({ content: "根据已有记录回答。", toolCalls: [] }));
  plugin = Object.assign(Object.create(LifeOpsPlugin.prototype), {
    app, store, settings: store.settings, updateStatusBar: vi.fn(async () => {}),
    lifeOpsEvents: { publish: vi.fn() }, buildSemanticContext: vi.fn(async () => ""),
    ai: { agentReply: reply, agentReplyStream: reply, delegatedReplyStream: reply, agentReplyAfterToolResultsStream: reply },
    executeToolCalls: vi.fn(async () => ({ replies: [], actions: [], results: [] }))
  });
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }); });

describe("production context and session memory boundaries", () => {
  it("does not send forgotten user statements or assistant text to the daily summary model", async () => {
    const date = formatDate(new Date());
    const path = store.path(store.settings.folders.aiReports, "Conversations", date + ".md");
    const raw = "## 10:15:00\n\n### 我\n" + "前".repeat(495) + oldText
      + "\n\n正常口述记录仍应保留。\n\n### LifeOps Agent\n这是助手生成的文字。\n";
    await vault.seed(path, raw);
    await store.reviewPersonalMemory(original.id, { decision: "forget" });
    const dailyReview = vi.fn(async (_messages: ChatMessage[]) => "仅整理可使用的记录。".repeat(32));
    plugin.ai.generateSummary = dailyReview;
    plugin.withAiFallback = async (run: () => Promise<string>) => run();
    plugin.saveLocalOperation = vi.fn(async () => undefined);
    plugin.refreshViews = vi.fn(async () => undefined);

    await plugin.generateDailyReview();

    expect(dailyReview).toHaveBeenCalledOnce();
    const context = dailyReview.mock.calls[0][0][1].content;
    expect(context).not.toContain("我喜欢简短");
    expect(context).toContain("正常口述记录仍应保留");
    expect(context).not.toContain("这是助手生成的文字");
    expect(await vault.bytes(path)).toBe(raw);
  });

  it("keeps the confirmation/correction/forgetting loop across fresh stores and 30 synthetic days", async () => {
    const date = formatDate(new Date());
    for (let day = 29; day >= 0; day -= 1) {
      const localDate = addDays(date, -day);
      const path = store.path(store.settings.folders.aiReports, "Conversations", `${localDate}.md`);
      await vault.seed(path, `# ${localDate}\n\n用户：${oldText}\n\nAI：你已经完成了今日任务，而且连续熬夜30天。\n\n示例讨论${day}`);
      await store.upsertPersonalMemory({ id: `pending-${day}`, kind: "pattern_candidate", content: `未经确认的习惯推测${day}`, truth: "inference",
        sourceRefs: [{ sourceId: `conversation:${localDate}`, path, capturedAt: `${localDate}T10:00:00+08:00` }] });
    }
    const reopen = () => { store = new LifeOpsStore(plugin.app, structuredClone(DEFAULT_SETTINGS)) as unknown as StoreHost; plugin.store = store; plugin.settings = store.settings; };
    const request = async () => {
      const model = vi.fn(async (_messages: ChatMessage[]) => ({ content: "虚构答复。", toolCalls: [] }));
      stubAgentModel(plugin, model);
      await plugin.submitAgentMessageStream("请深入分析我过去的沟通偏好", [], vi.fn(), { selfTest: true });
      return model.mock.calls[0][0][0].content;
    };
    reopen();
    expect(await request()).toContain(oldText);
    await store.reviewPersonalMemory(original.id, { decision: "correct", content: newText });
    reopen();
    const corrected = await request();
    expect(corrected).toContain(newText); expect(corrected).not.toContain(oldText);
    expect(corrected).not.toContain("未经确认的习惯推测");
    expect(corrected).not.toContain("连续熬夜：");
    expect(corrected).toContain("今日任务摘录");
    await store.reviewPersonalMemory(original.id, { decision: "forget" });
    reopen();
    for (const [id, text] of [["replayed-old", oldText], ["replayed-corrected", newText]]) {
      await store.upsertPersonalMemory({ id, kind: "user_rule", content: text, sourceRefs: original.sourceRefs });
    }
    const forgotten = await request();
    expect(forgotten).not.toContain(oldText); expect(forgotten).not.toContain(newText);
    expect((await store.readPersonalMemories()).records.filter(record => record.status === "active")).toEqual([]);
    expect((await store.readPersonalMemories()).records.filter(record => record.status === "candidate")).toHaveLength(30);
    expect(await vault.bytes(store.path(store.settings.folders.aiReports, "Conversations", `${date}.md`))).toContain(oldText);
  });
});
